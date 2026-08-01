"""
OCR video stream - outputs NDJSON to stdout for real-time subtitle extraction.
Usage: python ocr_video_stream.py <video_path> [fps] [regions_json] [min_confidence]

Architecture: sequential read (NO random seek) — same as ocr_video_srt_v3.py for max speed.

Each output line is a JSON object:
  {"type":"frame","timestamp":1.23,"detections":[...],"processed":5,"total":100,"percent":5,
   "duration":60.0,"elapsed":2.1,"eta":38.0,"speed":2.4,"ocr_count":3}
  {"type":"done","processed":100,"total":100,"duration":60.0,"elapsed":12.3,"ocr_count":40}
  {"type":"error","error":"message"}
"""
import sys
import io
import json
import time
import re
import os
import unicodedata
from rapidfuzz import fuzz

os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")
os.environ.setdefault("GLOG_minloglevel", "2")

# Fix Windows cp1252 encoding issue — force UTF-8 output
if hasattr(sys.stdout, 'buffer'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'buffer'):
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

def emit(obj):
    print(json.dumps(obj, ensure_ascii=True), flush=True)

try:
    import cv2
except ImportError:
    emit({"type": "error", "error": "opencv-python chưa cài. Chạy: pip install opencv-python"})
    sys.exit(1)

try:
    from paddleocr import PaddleOCR
    import paddle
except ImportError:
    emit({"type": "error", "error": "paddleocr chưa cài. Chạy: pip install paddleocr"})
    sys.exit(1)

# ── Args ──────────────────────────────────────────────────────────────────────
if len(sys.argv) < 2:
    emit({"type": "error", "error": "Thiếu đường dẫn video."})
    sys.exit(1)

VIDEO_PATH = sys.argv[1]
FPS        = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
REGIONS    = json.loads(sys.argv[3]) if len(sys.argv) > 3 else []
MIN_CONF   = float(sys.argv[4]) if len(sys.argv) > 4 else 0.25
START_TIME = max(0.0, float(sys.argv[5])) if len(sys.argv) > 5 else 0.0
SCAN_RANGES = json.loads(sys.argv[6]) if len(sys.argv) > 6 and sys.argv[6].strip() else []
TEXT_MODE  = os.environ.get("OCR_TEXT_MODE", "multilingual").strip().lower()

# ── Tuning ───────────────────────────────────────────────────────────────────
MAX_WIDTH = 960
MIN_WIDTH = 640
CHECK_EVERY_FRAMES = 2
CHANGE_THRESHOLD = 2.2
STABLE_FRAMES = 2
FUZZY_DUP = 70
MAX_OCR_INFERENCE_FPS = 5.0
MIN_OCR_INTERVAL_SEC = 1.0 / MAX_OCR_INFERENCE_FPS
# Keep the last stable reading through one missed OCR sample. A fixed 0.25s
# tolerance is too short when scanning at 1-3 FPS and causes the same subtitle
# to be emitted again as a brand-new track.
VANISH_TOLERANCE_SEC = max(0.25, (1.0 / max(0.1, FPS)) * 1.75)

def accepts_text(text):
    """Keep subtitle languages; watermark filtering happens from selected regions."""
    compact = re.sub(r"\s+", "", text)
    if not compact:
        return False
    if TEXT_MODE != "chinese":
        # Reject only punctuation/digits artifacts. Vietnamese/Latin subtitles
        # must survive — this supplied video has Vietnamese subtitle tracks.
        return bool(re.search(r"[A-Za-z\u00c0-\u024f\u1e00-\u1eff\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]", compact))
    if TEXT_MODE == "chinese":
        # Explicit Chinese-only mode remains available for noisy source videos.
        cjk_count = len(re.findall(r"[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]", compact))
        return cjk_count > 0
    return True

# ── OCR init ──────────────────────────────────────────────────────────────────
def _verify_gpu_compute():
    """Treat CUDA as available only after a synchronizing tensor operation."""
    if not paddle.is_compiled_with_cuda() or paddle.device.cuda.device_count() < 1:
        return False, "Paddle CUDA backend unavailable"
    try:
        paddle.set_device("gpu:0")
        values = paddle.to_tensor([1.0, 2.0, 3.0]) * 2
        if values.numpy().tolist() != [2.0, 4.0, 6.0]:
            raise RuntimeError("CUDA tensor returned an unexpected result")
        return True, None
    except Exception as error:
        paddle.set_device("cpu")
        return False, str(error)


def _make_ocr(**extra):
    """Prefer quiet API variants; don't silently fall through to no kwargs."""
    common = {
        "text_detection_model_name": "PP-OCRv5_mobile_det",
        "text_recognition_model_name": "PP-OCRv5_mobile_rec",
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
        **extra,
    }
    variants = [
        {**common, "show_log": False},
        common,
    ]
    last_error = None
    for kwargs in variants:
        try:
            return PaddleOCR(**kwargs)
        except Exception as error:
            last_error = error
    raise last_error or RuntimeError("Không khởi tạo được PaddleOCR")

ocr = None
_last_err = None
OCR_DEVICE = "cpu"
ocr_candidates = []
_gpu_verified, _gpu_error = _verify_gpu_compute()
if _gpu_verified:
    ocr_candidates.append(({"device": "gpu:0"}, "gpu:0"))
ocr_candidates.extend([
    ({"device": "cpu", "enable_mkldnn": False}, "cpu"),
    ({"device": "cpu"}, "cpu"),
    ({}, "cpu"),
])
for kwargs, device in ocr_candidates:
    try:
        ocr = _make_ocr(**kwargs)
        OCR_DEVICE = device
        break
    except Exception as e:
        _last_err = e

if ocr is None:
    emit({"type": "error", "error": f"Không khởi tạo được PaddleOCR: {_last_err}"})
    sys.exit(1)
if _gpu_error:
    print(f"[OCR GPU fallback] {_gpu_error}", file=sys.stderr, flush=True)

# ── Video open ────────────────────────────────────────────────────────────────
cap = cv2.VideoCapture(VIDEO_PATH)
if not cap.isOpened():
    emit({"type": "error", "error": f"Không mở được video: {VIDEO_PATH}"})
    sys.exit(1)

video_fps        = cap.get(cv2.CAP_PROP_FPS) or 25.0
total_frames_vid = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
duration         = total_frames_vid / video_fps
interval         = 1.0 / FPS
check_every_frames = max(1, round(video_fps / max(0.1, FPS)))
START_TIME       = min(duration, START_TIME)
SCAN_RANGES = [
    {"start": max(START_TIME, min(duration, float(item.get("start", 0)))), "end": max(START_TIME, min(duration, float(item.get("end", duration))))}
    for item in SCAN_RANGES if isinstance(item, dict)
]
SCAN_RANGES = [item for item in SCAN_RANGES if item["end"] > item["start"]]
# Progress is frame-driven because detection must match the original algorithm.
scan_duration = sum(item["end"] - item["start"] for item in SCAN_RANGES) if SCAN_RANGES else max(0, duration - START_TIME)
total_scans      = max(1, int(scan_duration * video_fps / check_every_frames))

# ── Helpers ───────────────────────────────────────────────────────────────────
def get_regions(frame_w, frame_h):
    if not REGIONS:
        return [{"id": "full-frame", "x1": 0, "y1": 0, "x2": frame_w, "y2": frame_h}]
    result = []
    for r in REGIONS:
        x1 = int(frame_w * r["x"] / 100)
        y1 = int(frame_h * r["y"] / 100)
        x2 = int(frame_w * (r["x"] + r["width"]) / 100)
        y2 = int(frame_h * (r["y"] + r["height"]) / 100)
        result.append({
            "id": r.get("id", "region"),
            "x1": max(0, x1), "y1": max(0, y1),
            "x2": min(frame_w, x2), "y2": min(frame_h, y2),
        })
    return result

def crop_resize(frame, x1, y1, x2, y2):
    crop = frame[y1:y2, x1:x2]
    if crop.size == 0:
        return crop
    if crop.shape[1] < MIN_WIDTH:
        scale = MIN_WIDTH / crop.shape[1]
        crop  = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    elif crop.shape[1] > MAX_WIDTH:
        scale = MAX_WIDTH / crop.shape[1]
        crop  = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return crop

def extract_data_from_result(item):
    """Trả về dict có rec_texts/rec_scores/rec_polys từ nhiều format PaddleOCR."""
    if isinstance(item, dict):
        return item.get("res", item) if isinstance(item.get("res", item), dict) else item
    # PaddleOCR >= 3.x: item là object có .json property (callable hoặc dict)
    if hasattr(item, "json"):
        j = item.json
        if callable(j):
            j = j()
        if isinstance(j, dict):
            return j.get("res", j) if isinstance(j.get("res", j), dict) else j
    # Fallback: thử lấy trực tiếp attributes
    data = {}
    for key in ("rec_texts", "rec_scores", "rec_polys", "dt_polys"):
        val = getattr(item, key, None)
        if val is not None:
            data[key] = list(val) if hasattr(val, "__iter__") and not isinstance(val, str) else val
    if data:
        return data
    return None

def prediction_items(image):
    predict = getattr(ocr, "predict", None)
    return predict(image) if callable(predict) else ocr.ocr(image, cls=False)

def normalized_results(result):
    for item in result or []:
        data = extract_data_from_result(item)
        if data:
            yield data
            continue
        rows = item if isinstance(item, list) else []
        if rows and isinstance(rows[0], list) and len(rows) == 1 and isinstance(rows[0][0], (list, tuple)):
            rows = rows[0]
        texts, scores, polys = [], [], []
        for row in rows:
            if not isinstance(row, (list, tuple)) or len(row) < 2:
                continue
            polygon, recognition = row[0], row[1]
            if not isinstance(recognition, (list, tuple)) or len(recognition) < 2:
                continue
            texts.append(str(recognition[0]))
            scores.append(float(recognition[1]))
            polys.append(polygon)
        if texts:
            yield {"rec_texts": texts, "rec_scores": scores, "rec_polys": polys}

def run_ocr_on_region(frame, frame_w, frame_h, reg):
    """OCR only the selected ROI; boxes remain relative to the full video."""
    detections = []
    crop = crop_resize(frame, reg["x1"], reg["y1"], reg["x2"], reg["y2"])
    if crop.size == 0:
        return detections
    scale_x = (reg["x2"] - reg["x1"]) / crop.shape[1]
    scale_y = (reg["y2"] - reg["y1"]) / crop.shape[0]
    try:
        result = prediction_items(crop)
    except Exception as ex:
        emit({"type": "ocr_error", "timestamp": CURRENT_SAMPLE_TS, "region_id": reg["id"], "error": str(ex)})
        print(f"[OCR predict error] {ex}", file=sys.stderr, flush=True)
        return detections
    for data in normalized_results(result):
        for idx, (text, score) in enumerate(zip(data.get("rec_texts", []), data.get("rec_scores", []))):
            text = text.strip()
            if not text or score < MIN_CONF or not accepts_text(text):
                continue
            boxes = data.get("rec_polys", data.get("dt_polys", []))
            box = None
            if idx < len(boxes):
                pts = boxes[idx]; xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
                box = {"x": round((reg["x1"] + min(xs) * scale_x) / frame_w * 100, 2), "y": round((reg["y1"] + min(ys) * scale_y) / frame_h * 100, 2), "width": round((max(xs) - min(xs)) * scale_x / frame_w * 100, 2), "height": round((max(ys) - min(ys)) * scale_y / frame_h * 100, 2)}
            # Detection models can emit two highly overlapping polygons for one
            # subtitle. De-duplicate spatially as well as textually.
            if any(
                boxes_overlap(existing.get("box"), box)
                and fuzz.ratio(existing["text"], text) >= 70
                for existing in detections
            ):
                continue
            detections.append({"text": text, "confidence": round(float(score), 4), "region_id": reg["id"], "box": box})
    return sorted(detections, key=lambda item: (
        (item.get("box") or {}).get("y", 0),
        (item.get("box") or {}).get("x", 0),
    ))

def boxes_overlap(a, b, threshold=0.5):
    if not a or not b:
        return False
    x1 = max(a["x"], b["x"])
    y1 = max(a["y"], b["y"])
    x2 = min(a["x"] + a["width"], b["x"] + b["width"])
    y2 = min(a["y"] + a["height"], b["y"] + b["height"])
    if x2 <= x1 or y2 <= y1:
        return False
    intersection = (x2 - x1) * (y2 - y1)
    smaller_area = min(a["width"] * a["height"], b["width"] * b["height"])
    return smaller_area > 0 and intersection / smaller_area >= threshold

def sorted_join(result):
    items = sorted(result, key=lambda item: (
        (item.get("box") or {}).get("y", 0),
        (item.get("box") or {}).get("x", 0),
    ))
    return " ".join(item["text"].strip() for item in items if item.get("text", "").strip())

def _fold_accents(text):
    return "".join(
        char for char in unicodedata.normalize("NFD", text)
        if unicodedata.category(char) != "Mn"
    )

def same_text(left, right):
    left = "".join(left.split()).replace("。", "")
    right = "".join(right.split()).replace("。", "")
    if not left or not right:
        return False
    if left == right:
        return True
    shortest = min(len(left), len(right))
    # Short captions need a stricter threshold; long Vietnamese lines tolerate
    # OCR accent errors without merging genuinely different short phrases.
    threshold = 88 if shortest <= 6 else 78 if shortest <= 14 else FUZZY_DUP
    raw_score = fuzz.ratio(left, right)
    folded_score = fuzz.ratio(_fold_accents(left), _fold_accents(right))
    containment = shortest >= 8 and (left in right or right in left)
    return containment or raw_score >= threshold or folded_score >= max(threshold, 82)

# ── Main loop: OCR every requested sample, per manual ROI ──────────────────
frame_id = 0
sample_index = 0
processed = 0
ocr_count = 0
start_clock  = time.time()
frame_w = frame_h = 0
CURRENT_SAMPLE_TS = START_TIME
region_state = {}
active_range_index = -1

while True:
    ret, frame = cap.read()
    if not ret:
        break

    frame_id += 1
    nominal_sec = max(0.0, (frame_id - 1) / video_fps)
    pts_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
    sec = pts_ms / 1000.0 if pts_ms is not None and pts_ms > 0 else nominal_sec
    if sec < START_TIME - 1e-6:
        continue
    if SCAN_RANGES:
        range_index = next((index for index, item in enumerate(SCAN_RANGES) if item["start"] - 1e-6 <= sec <= item["end"] + 1e-6), -1)
        if range_index < 0:
            continue
        if range_index != active_range_index:
            # Never carry cached detections across an intentionally skipped
            # section of the timeline.
            region_state = {}
            active_range_index = range_index
    frame_h, frame_w = frame.shape[:2]

    if frame_id % check_every_frames != 0:
        continue

    sample_ts = round(sec, 3)
    CURRENT_SAMPLE_TS = sample_ts
    detections = []
    for reg in get_regions(frame_w, frame_h):
        crop = crop_resize(frame, reg["x1"], reg["y1"], reg["x2"], reg["y2"])
        if crop.size == 0:
            continue
        gray = cv2.GaussianBlur(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), (3, 3), 0)
        state = region_state.setdefault(reg["id"], {
            "prev_gray": None,
            "last_text": "",
            "last_seen_ts": None,
            "last_ocr_ts": None,
            "last_result": [],
            "pending_text": "",
            "pending_count": 0,
            "pending_start_ts": None,
        })
        previous = state["prev_gray"]
        pixel_change = previous is None or cv2.absdiff(gray, previous).mean() >= CHANGE_THRESHOLD
        last_ocr_ts = state["last_ocr_ts"]
        interval_ready = last_ocr_ts is None or (sample_ts - last_ocr_ts) >= MIN_OCR_INTERVAL_SEC
        periodic_refresh = last_ocr_ts is None or (sample_ts - last_ocr_ts) >= 1.8
        should_ocr = interval_ready and (pixel_change or periodic_refresh)

        if should_ocr:
            result = run_ocr_on_region(frame, frame_w, frame_h, reg)
            ocr_count += 1
            state["last_ocr_ts"] = sample_ts
            text = sorted_join(result)
            if text and state["last_text"] and same_text(text, state["last_text"]):
                state["last_seen_ts"] = sample_ts
                # Keep emitting the exact accepted reading. Small OCR variations
                # in accents/punctuation must not leak downstream as new tracks.
                result = state["last_result"]
                state["pending_text"] = ""
                state["pending_count"] = 0
                state["pending_start_ts"] = None
            elif text:
                if state["pending_text"] and same_text(text, state["pending_text"]):
                    state["pending_count"] += 1
                else:
                    state["pending_text"] = text
                    state["pending_count"] = 1
                    state["pending_start_ts"] = sample_ts
                if state["pending_count"] >= 2:
                    first_seen_ts = state["pending_start_ts"] if state["pending_start_ts"] is not None else sample_ts
                    # Debounce confirms the reading on the second sample, but
                    # downstream timing must start at the first visual sample.
                    for item in result:
                        item["first_seen_ts"] = first_seen_ts
                    state["last_text"] = text
                    state["last_seen_ts"] = sample_ts
                    state["last_result"] = result
                    state["pending_text"] = ""
                    state["pending_count"] = 0
                    state["pending_start_ts"] = None
                else:
                    result = state["last_result"]
            elif state["last_seen_ts"] is None or (sample_ts - state["last_seen_ts"]) > VANISH_TOLERANCE_SEC:
                state["last_text"] = ""
                state["last_result"] = []
                state["pending_text"] = ""
                state["pending_count"] = 0
                state["pending_start_ts"] = None
            else:
                result = state["last_result"]

        # Emit cached detections on skipped samples. This keeps a continuous
        # subtitle track without paying for 12 Paddle inference calls/second.
        detections.extend(state["last_result"])
        state["prev_gray"] = gray
    processed += 1

    elapsed = time.time() - start_clock
    progress_ratio = min(1.0, processed / max(1, total_scans))
    eta = round((elapsed / progress_ratio) - elapsed, 1) if progress_ratio > 0.001 else 0
    speed = round((processed / max(0.1, FPS)) / elapsed, 2) if elapsed > 0 else 0
    percent = min(99, round(progress_ratio * 100))

    emit({
        "type": "frame",
        "timestamp": sample_ts,
        "detections": detections,
        "processed": processed,
        "total": total_scans,
        "percent": percent,
        "duration": round(duration, 2),
        "elapsed": round(elapsed, 1),
        "eta": eta,
        "speed": speed,
        "ocr_count": ocr_count,
    })

cap.release()

elapsed = time.time() - start_clock
emit({
    "type":      "done",
    "processed": processed,
    "total":     total_scans,
    "duration":  round(duration, 2),
    "elapsed":   round(elapsed, 1),
    "ocr_count": ocr_count,
})
