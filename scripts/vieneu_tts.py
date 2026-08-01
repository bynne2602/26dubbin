"""Persistent NDJSON bridge for local VieNeu TTS."""
import base64
import json
import os
import re
import sys
import tempfile
import traceback
import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")

_engine = None
_ngoc_huyen_engine = None
_ngoc_huyen_asr = None
_previous_ngoc_huyen_text = ""

NGOC_HUYEN_VOICE = "Ngọc Huyền · Tin tức (Fine-tune)"
NGOC_HUYEN_REPO = "pnnbao-ump/VieNeu-TTS-0.3B-lora-ngoc-huyen"
NGOC_HUYEN_BASE = "pnnbao-ump/VieNeu-TTS-0.3B"
# The LoRA was trained against the original 512-wide Qwen backbone. The model
# repo was replaced by a 768-wide build in May 2026, so `main` is incompatible.
NGOC_HUYEN_BASE_REVISION = "d793f8d0c7bde5f6d4ef61b47f412390d596ccff"
NGOC_HUYEN_ADAPTER_REVISION = "85143549167454f9eeb766dca392c51c58fdf706"


def _ngoc_huyen_chunks(text, max_chars=160):
    from vieneu_utils.phonemize_text import normalize_to_chunks
    return normalize_to_chunks(text, max_chars=max_chars, skip_normalize=False)


def _chunk_duration_limit(text):
    """Conservative ceiling that catches the known 10s+ reference phrase bleed."""
    word_count = max(1, len(re.findall(r"\w+", text, flags=re.UNICODE)))
    return max(3.5, word_count * 1.05 + 1.5)


def _normalize_check_text(value):
    value = value.lower()
    value = re.sub(r"[^\w\s]", " ", value, flags=re.UNICODE)
    return re.sub(r"\s+", " ", value).strip()


def _asr_model():
    global _ngoc_huyen_asr
    if _ngoc_huyen_asr is None:
        from faster_whisper import WhisperModel
        # `base` misrecognizes the fine-tuned Vietnamese news timbre often
        # enough to reject clean takes. `small` remains CPU/int8 and is cached
        # locally, while providing reliable lexical bleed detection.
        _ngoc_huyen_asr = WhisperModel("small", device="cpu", compute_type="int8", local_files_only=True)
    return _ngoc_huyen_asr


def _verify_no_voice_bleed(audio, requested_text, commit=True):
    """Reject known reference speech and a strong previous-request prefix match."""
    global _previous_ngoc_huyen_text
    model = _asr_model()
    segments, _ = model.transcribe(audio, language="vi", vad_filter=True, beam_size=1)
    transcript = _normalize_check_text(" ".join(segment.text for segment in segments))
    # Silero VAD can occasionally discard a short/quiet valid take. Re-run the
    # same immutable waveform without VAD before deciding that synthesis failed.
    if not transcript:
        segments, _ = model.transcribe(audio, language="vi", vad_filter=False, beam_size=3)
        transcript = _normalize_check_text(" ".join(segment.text for segment in segments))
    requested = _normalize_check_text(requested_text)
    reference_signatures = (
        "tính khoa học", "tính đảng", "tính chiến đấu", "tính định hướng",
        "trong phòng rất tù mù", "che dấu nó",
    )
    leaked_reference = [phrase for phrase in reference_signatures if phrase in transcript and phrase not in requested]
    if leaked_reference:
        raise RuntimeError(f"ASR phát hiện câu reference lọt vào TTS: {', '.join(leaked_reference)}")
    previous_words = {word for word in _normalize_check_text(_previous_ngoc_huyen_text).split() if len(word) >= 5}
    requested_words = set(requested.split())
    prefix_words = {word for word in transcript.split()[:14] if len(word) >= 5}
    previous_only = (prefix_words & previous_words) - requested_words
    if len(previous_only) >= 3:
        raise RuntimeError("ASR phát hiện phần đầu voice lặp lại nội dung của request trước.")
    requested_content = {word for word in requested.split() if len(word) >= 4}
    transcript_words = set(transcript.split())
    if requested_content and len(requested_content & transcript_words) / len(requested_content) < 0.35:
        raise RuntimeError(f"ASR xác nhận voice không khớp đủ script. Nghe được: {transcript[:240]}")
    if commit:
        _previous_ngoc_huyen_text = requested_text
    return transcript


def infer_ngoc_huyen_strict(tts, text, voice_data):
    """Read one script continuously and reject any contaminated final take.

    The adapter preset contains 227 unverified reference codes and the transcript
    "Tác phẩm dự thi... tính chiến đấu, tính định hướng", but no source audio.
    VieNeu correctly slices generated tokens after the padded prompt length and
    no mutable KV state survives `generate()`. The bleed was caused by its repo-
    name heuristic disabling the required legacy chat prompt for our pinned local
    snapshot path; ngoc_huyen_engine() now enables that format explicitly and
    merges the LoRA exactly like the official Custom Model loader. ASR validation
    remains the final guard preventing a contaminated take from escaping.
    Revision changes must run scripts/test_ngoc_huyen_isolation.py before shipping.
    """
    normalized = " ".join(str(text or "").split()).strip()
    if not normalized:
        raise ValueError("Nội dung Ngọc Huyền trống sau khi chuẩn hóa.")
    last_error = None
    for temperature, top_k in ((0.90, 45), (1.0, 50)):
        # One public infer call represents one paragraph. VieNeu may split only
        # to respect its context window, then joins chunks with no artificial
        # silence and a tiny crossfade so narration remains continuous.
        output = np.asarray(tts.infer(
            normalized,
            voice=voice_data,
            max_chars=180,
            silence_p=0.0,
            crossfade_p=0.035,
            temperature=temperature,
            top_k=top_k,
            apply_watermark=False,
        ), dtype=np.float32)
        try:
            if output.size == 0 or not np.isfinite(output).all():
                raise RuntimeError("Audio rỗng hoặc chứa giá trị không hợp lệ.")
            _verify_no_voice_bleed(output, normalized)
            apply_watermark = getattr(tts, "_apply_watermark", None)
            return apply_watermark(output) if callable(apply_watermark) else output
        except RuntimeError as error:
            last_error = error
    raise RuntimeError(
        "Ngọc Huyền không tạo được bản đọc khớp nguyên văn sau 2 lần thử; "
        f"đã chặn audio sai để không lọt vào video. {last_error or ''}"
    )


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def engine():
    global _engine
    if _engine is None:
        from vieneu import Vieneu
        _engine = Vieneu()
    return _engine


def ngoc_huyen_engine():
    """Load the real Ngọc Huyền LoRA adapter lazily; never pretend it is a preset voice."""
    global _ngoc_huyen_engine
    if _ngoc_huyen_engine is None:
        try:
            import torch
            import peft  # noqa: F401 - explicit dependency check before model download
            import transformers  # noqa: F401
        except ImportError as error:
            raise RuntimeError(
                "Giọng Ngọc Huyền Fine-tune chưa có runtime PyTorch/Transformers/PEFT. "
                "Cần cài gói voice fine-tune trước khi sử dụng."
            ) from error
        from huggingface_hub import snapshot_download
        from vieneu.standard import VieNeuTTS
        device = "cuda" if torch.cuda.is_available() else "cpu"
        base_path = snapshot_download(NGOC_HUYEN_BASE, revision=NGOC_HUYEN_BASE_REVISION)
        adapter_path = snapshot_download(NGOC_HUYEN_REPO, revision=NGOC_HUYEN_ADAPTER_REVISION)
        tts = VieNeuTTS(
            backbone_repo=base_path,
            backbone_device=device,
            codec_device="cpu",
            gguf_filename=None,
        )
        # VieNeu detects the legacy Qwen chat prompt by checking whether the
        # backbone string ends with "pnnbao-ump/VieNeu-TTS". We intentionally
        # pass a pinned local snapshot path, so that heuristic incorrectly sets
        # use_chat_format=False and the model receives a malformed prompt. That
        # was the actual source of gibberish/reference-transcript continuation;
        # it was not an output-token trim or persistent KV-cache leak.
        tts.use_chat_format = True
        tts.load_lora_adapter(adapter_path)
        # Match VieNeu's official "Custom Model" loader exactly: the LoRA is
        # merged into the base backbone before inference. Keeping it as a live
        # PeftModel produced unstable continuation tokens with this adapter,
        # including regeneration of the conditioning transcript. The official
        # app performs merge_and_unload() for the standard backend as well.
        if not hasattr(tts.backbone, "merge_and_unload"):
            raise RuntimeError("LoRA Ngọc Huyền không hỗ trợ merge_and_unload; từ chối chạy sai loader.")
        tts.backbone = tts.backbone.merge_and_unload()
        tts._lora_loaded = False
        tts._current_lora_repo = None
        if device == "cuda":
            # Keep this LoRA in FP32. Explicit `.half()` was regression-tested and
            # produced unstable codec tokens/gibberish on RTX 3060. TF32/SDPA still
            # accelerate safe FP32 matrix operations without changing weight dtype.
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
            torch.set_float32_matmul_precision("high")
            tts.backbone.eval()
        voices_path = os.path.join(adapter_path, "voices.json")
        with open(voices_path, "r", encoding="utf-8") as handle:
            tts._ngoc_huyen_voice = json.load(handle)["presets"]["NgocHuyen"]
        _ngoc_huyen_engine = tts
    return _ngoc_huyen_engine


def synthesize(request):
    text = str(request.get("text") or "").strip()
    if not text:
        raise ValueError("Thiếu nội dung cần tạo giọng đọc.")
    voice = str(request.get("voice") or "Phạm Tuyên")
    style = str(request.get("style") or "tu_nhien")
    if voice in (NGOC_HUYEN_VOICE, "NgocHuyen", "ngoc-huyen-news"):
        tts = ngoc_huyen_engine()
        voice_data = getattr(tts, "_ngoc_huyen_voice", None)
        if not voice_data:
            raise RuntimeError("Adapter Ngọc Huyền đã tải nhưng không tìm thấy preset NgocHuyen.")
        audio = infer_ngoc_huyen_strict(tts, text, voice_data)
    else:
        tts = engine()
        audio = tts.infer(text, voice=voice, style=style)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as output:
        output_path = output.name
    try:
        tts.save(audio, output_path)
        with open(output_path, "rb") as wav_file:
            encoded = base64.b64encode(wav_file.read()).decode("ascii")
        return {"audio": encoded, "format": "wav", "sampleRate": 48000}
    finally:
        try:
            os.remove(output_path)
        except OSError:
            pass


def main():
    for line in sys.stdin:
        try:
            request = json.loads(line)
            action = request.get("action", "synthesize")
            if action == "verify":
                tts = engine()
                voices = tts.list_preset_voices()
                voices.append(("Ngọc Huyền · Tin tức (LoRA, CC BY-NC 4.0)", NGOC_HUYEN_VOICE))
                emit({"ok": True, "voices": voices})
            elif action == "preload_ngoc_huyen":
                ngoc_huyen_engine()
                emit({"ok": True, "ready": True})
            elif action == "synthesize":
                emit({"ok": True, **synthesize(request)})
            else:
                raise ValueError(f"Unsupported action: {action}")
        except Exception as error:
            emit({"ok": False, "error": str(error), "details": traceback.format_exc()})


if __name__ == "__main__":
    main()
