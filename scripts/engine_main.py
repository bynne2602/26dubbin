"""Single PyInstaller entry point for all local DubbinTool native workloads."""
from __future__ import annotations

import os
import runpy
import sys
from pathlib import Path

COMMANDS = {
    "ocr_frame": "ocr_frame.py",
    "ocr_video": "ocr_video_stream.py",
    "render_video": "render_video.py",
    "vieneu_tts": "vieneu_tts.py",
}


def scripts_dir() -> Path:
    """Locate bundled scripts in PyInstaller and direct Python development modes."""
    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        return Path(bundle_root) / "scripts"
    return Path(__file__).resolve().parent


def main() -> None:
    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        model_cache = Path(bundle_root) / "hf"
        paddlex_cache = Path(bundle_root) / "paddlex"
        os.environ.setdefault("HF_HOME", str(model_cache))
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(model_cache / "hub"))
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(paddlex_cache))
        os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

    # Compatibility: older desktop bridges launch the OCR engine with no args.
    if len(sys.argv) == 1:
        sys.argv.append("ocr_frame")

    if sys.argv[1] not in COMMANDS:
        available = ", ".join(COMMANDS)
        print(f"Usage: ocr_engine.exe <{available}> [args...]", file=sys.stderr)
        raise SystemExit(2)

    command = sys.argv[1]
    script = scripts_dir() / COMMANDS[command]
    if not script.is_file():
        print(f"Bundled engine script missing: {script}", file=sys.stderr)
        raise SystemExit(1)

    # Existing scripts retain their tested command-line/NDJSON protocols.
    sys.argv = [str(script), *sys.argv[2:]]
    os.environ.setdefault("DUBBIN_ENGINE_COMMAND", command)
    runpy.run_path(str(script), run_name="__main__")


if __name__ == "__main__":
    main()
