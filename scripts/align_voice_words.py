"""Emit word timestamps for a synthesized narration WAV/MP3 as JSON."""
import json
import sys

from faster_whisper import WhisperModel


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: align_voice_words.py <audio>")
    model = WhisperModel("small", device="cpu", compute_type="int8", local_files_only=True)
    segments, _ = model.transcribe(
        sys.argv[1], language="vi", beam_size=3, vad_filter=False, word_timestamps=True,
    )
    words = []
    for segment in segments:
        for word in segment.words or []:
            if word.start is None or word.end is None or not word.word.strip():
                continue
            words.append({"start": float(word.start), "end": float(word.end), "text": word.word.strip()})
    print(json.dumps(words, ensure_ascii=False))


if __name__ == "__main__":
    main()
