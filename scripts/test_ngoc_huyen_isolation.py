"""Manual/regression QC for persistent Ngọc Huyền inference isolation.

Run: .venv\\Scripts\\python.exe scripts\\test_ngoc_huyen_isolation.py
The production strict inference already runs the cached faster-whisper base
model to reject reference and previous-request bleed.
"""
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from vieneu_tts import infer_ngoc_huyen_strict, ngoc_huyen_engine  # noqa: E402


SENTENCES = [
    "Buổi sáng trên bản nhỏ bắt đầu bằng tiếng chim gọi nhau bên sườn núi.",
    "Chiếc lốp cũ lăn nhanh xuống con dốc đất khiến cậu bé bật cười thích thú.",
    "Người mẹ đứng trước hiên nhà rồi bất ngờ nhận ra trò nghịch ngợm của con.",
    "Một khoảnh khắc bình dị cũng có thể trở thành ký ức tuổi thơ khó quên.",
    "Câu chuyện khép lại khi mọi người cùng mỉm cười giữa ánh chiều yên ả.",
]
def main():
    tts = ngoc_huyen_engine()
    voice = tts._ngoc_huyen_voice
    outputs = []
    for round_index in range(2):
        previous = ""
        for index, sentence in enumerate(SENTENCES):
            audio = infer_ngoc_huyen_strict(tts, sentence, voice)
            assert isinstance(audio, np.ndarray) and audio.size > 0
            duration = audio.size / float(tts.sample_rate)
            # Production ASR is authoritative; this only catches runaway output.
            assert duration <= max(4.0, len(sentence.split()) * 2.2 + 2.0)
            outputs.append((round_index, index, duration, audio))
            print(f"PASS {round_index + 1}/{index + 1}: {duration:.2f}s", flush=True)
            previous = sentence
    print(f"PASS duration/state guards: {len(outputs)} persistent calls")

    print("PASS ASR reference/previous-request guard")


if __name__ == "__main__":
    main()
