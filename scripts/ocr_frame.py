"""Persistent NDJSON PaddleOCR worker for /api/ocr/frame and /api/ocr/batch."""
import base64
import io
import json
import os
import re
import sys

os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")
os.environ.setdefault("GLOG_minloglevel", "2")

# Electron can inherit a PATH which resolves another zlibwapi.dll first.
# Register the verified CUDA 11.8 x64 directory before importing Paddle.
CUDA_BIN = os.environ.get("PADDLE_CUDA_BIN", r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v11.8\bin")
if os.path.isdir(CUDA_BIN):
    os.environ["PATH"] = CUDA_BIN + os.pathsep + os.environ.get("PATH", "")
    if hasattr(os, "add_dll_directory"):
        os.add_dll_directory(CUDA_BIN)

import cv2
import numpy as np
from paddleocr import PaddleOCR
import paddle

TEXT_MODE = os.environ.get("OCR_TEXT_MODE", "multilingual").strip().lower()

def accepts_text(value):
    """Keep multilingual subtitles; explicit Chinese-only mode remains optional."""
    text = re.sub(r"\s+", "", str(value))
    if not text:
        return False
    if TEXT_MODE != "chinese":
        return bool(re.search(r"[A-Za-z\u00c0-\u024f\u1e00-\u1eff\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]", text))
    return bool(re.search(r"[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]", text))


def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)

def error_chain(error):
    messages = []
    current = error
    while current is not None and len(messages) < 6:
        messages.append(f"{type(current).__name__}: {current}")
        current = current.__cause__ or current.__context__
    return " <- ".join(messages)


def verify_gpu_compute():
    """Return GPU only after a CUDA operation synchronizes successfully."""
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


def create_ocr(**extra):
    """Use quiet kwargs where supported; never silently use an empty fallback."""
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


def make_ocr():
    last_error = None
    candidates = []
    gpu_ok, gpu_error = verify_gpu_compute()
    if gpu_ok:
        candidates.append(({"device": "gpu:0"}, "gpu:0"))
    candidates.extend([
        ({"device": "cpu", "enable_mkldnn": False}, "cpu"),
        ({"device": "cpu"}, "cpu"),
        ({}, "cpu"),
    ])
    for kwargs, device in candidates:
        try:
            return create_ocr(**kwargs), device, gpu_error
        except Exception as error:
            last_error = error
    raise RuntimeError(f"Không khởi tạo được PaddleOCR: {error_chain(last_error)}")


def result_data(item):
    if isinstance(item, dict):
        return item.get("res", item) if isinstance(item.get("res", item), dict) else item
    data = getattr(item, "json", None)
    if callable(data):
        data = data()
    if not isinstance(data, dict):
        return {}
    return data.get("res", data) if isinstance(data.get("res", data), dict) else data


def prediction_items(ocr, image):
    """Support both PaddleOCR v3 ``predict`` and v2 ``ocr`` APIs."""
    predict = getattr(ocr, "predict", None)
    return predict(image) if callable(predict) else ocr.ocr(image, cls=False)


def normalized_results(result):
    """Yield v3 dicts or normalize v2 [[box, [text, score]]] records."""
    for item in result or []:
        data = result_data(item)
        if data:
            yield data
            continue
        # PaddleOCR v2: one image -> [[polygon, [text, confidence]], ...]
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


def recognize(ocr, request):
    raw = request.get("image", "")
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    image = cv2.imdecode(np.frombuffer(base64.b64decode(raw), np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Ảnh OCR không hợp lệ.")
    height, width = image.shape[:2]
    regions = request.get("regions") or [{"id": "full-frame", "x": 0, "y": 0, "width": 100, "height": 100}]
    minimum = float(request.get("minConfidence", 0.25))
    scan_watermarks = bool(request.get("scanWatermarks"))
    detections = []
    for region in regions:
        x1 = max(0, int(width * float(region.get("x", 0)) / 100))
        y1 = max(0, int(height * float(region.get("y", 0)) / 100))
        x2 = min(width, int(width * (float(region.get("x", 0)) + float(region.get("width", 100))) / 100))
        y2 = min(height, int(height * (float(region.get("y", 0)) + float(region.get("height", 100))) / 100))
        crop = image[y1:y2, x1:x2]
        if crop.size == 0:
            continue
        source_width = crop.shape[1]
        if source_width > 960:
            crop = cv2.resize(crop, None, fx=960 / source_width, fy=960 / source_width, interpolation=cv2.INTER_AREA)
        elif source_width < 640:
            crop = cv2.resize(crop, None, fx=640 / source_width, fy=640 / source_width, interpolation=cv2.INTER_CUBIC)
        scale_x, scale_y = (x2 - x1) / crop.shape[1], (y2 - y1) / crop.shape[0]
        for data in normalized_results(prediction_items(ocr, crop)):
            texts, scores = data.get("rec_texts", []), data.get("rec_scores", [])
            boxes = data.get("rec_polys", data.get("dt_polys", []))
            for index, (text, score) in enumerate(zip(texts, scores)):
                # Watermarks commonly are Latin handles (e.g. @creator). OCR
                # subtitle mode intentionally rejects these, scan mode must not.
                if not str(text).strip() or float(score) < minimum or (not scan_watermarks and not accepts_text(text)):
                    continue
                box = None
                bbox = None
                if index < len(boxes):
                    points = boxes[index]
                    mapped = [[round((x1 + point[0] * scale_x) / width * 100, 2), round((y1 + point[1] * scale_y) / height * 100, 2)] for point in points]
                    xs, ys = [p[0] for p in mapped], [p[1] for p in mapped]
                    bbox = mapped
                    box = {"x": min(xs), "y": min(ys), "width": max(xs) - min(xs), "height": max(ys) - min(ys)}
                detections.append({"text": str(text).strip(), "confidence": round(float(score), 4), "region_id": region.get("id", "full-frame"), "box": box, "bbox": bbox})
    return {"timestamp": float(request.get("timestamp", 0)), "detections": detections}


def main():
    ocr, device, gpu_error = make_ocr()
    emit({
        "type": "ready",
        "device": device,
        "cuda": bool(paddle.is_compiled_with_cuda()),
        "gpu_count": paddle.device.cuda.device_count() if paddle.is_compiled_with_cuda() else 0,
        "gpu_verified": device == "gpu:0",
        "gpu_error": gpu_error,
        "python": sys.executable,
        "paddleVersion": paddle.__version__,
        "paddle_device": paddle.device.get_device(),
    })
    for line in sys.stdin:
        request_id = ""
        try:
            request = json.loads(line)
            request_id = str(request.get("requestId") or "")
            if request.get("action") == "shutdown":
                emit({"type": "response", "requestId": request_id, "ok": True, "shutdown": True})
                return
            if request.get("action") == "verify":
                result = {"ok": True, "device": device, "cuda_compiled": bool(paddle.is_compiled_with_cuda()), "gpu_count": paddle.device.cuda.device_count() if paddle.is_compiled_with_cuda() else 0, "gpu_verified": device == "gpu:0", "gpu_error": gpu_error}
            elif request.get("action") == "batch":
                result = {"frames": [recognize(ocr, frame) for frame in request.get("frames", [])], "device": device}
            else:
                result = {"frame": recognize(ocr, request), "device": device}
            emit({"type": "response", "requestId": request_id, "ok": True, "result": result})
        except Exception as error:
            emit({"type": "response", "requestId": request_id, "ok": False, "error": str(error)})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"type": "startup_error", "error": str(error)})
        sys.exit(1)
