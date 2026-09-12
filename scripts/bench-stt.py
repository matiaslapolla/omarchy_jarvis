#!/usr/bin/env python3
import argparse
import json
import os
import sys
import time
import wave

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def read_wav(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
        ch = w.getnchannels()
        sw = w.getsampwidth()
    if sw == 2 and ch == 2:
        import struct
        vals = struct.unpack("<" + "h" * (len(raw) // 2), raw)
        mono = vals[0::2]
        raw = struct.pack("<" + "h" * len(mono), *mono)
    elif sw != 2:
        raise ValueError(f"unsupported sampwidth={sw}, need 16-bit wav")
    return raw, sr


def wer(ref, hyp):
    r = ref.lower().split()
    h = hyp.lower().split()
    if not r:
        return 0.0 if not h else 1.0
    prev = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        cur = [i] + [0] * len(h)
        for j in range(1, len(h) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (0 if r[i - 1] == h[j - 1] else 1))
        prev = cur
    return prev[len(h)] / len(r)


def build_backend(backend, model):
    from services.voice.providers_wake_vad_stt import FasterWhisperSTT, StubSTT, WhisperCppSTT
    if backend == "stub":
        return StubSTT()
    if backend == "faster":
        return FasterWhisperSTT(model=model or "small", language="es")
    if backend == "whispercpp":
        return WhisperCppSTT(model_path=model or "", language="es")
    raise ValueError(f"unknown backend: {backend}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", required=True, choices=["stub", "faster", "whispercpp"])
    ap.add_argument("--wav", required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--model", default="")
    a = ap.parse_args()
    try:
        stt = build_backend(a.backend, a.model)
        pcm, sr = read_wav(a.wav)
        stt.transcribe(pcm, sr)
        lat = []
        text = ""
        for _ in range(3):
            t0 = time.perf_counter()
            text = stt.transcribe(pcm, sr)
            lat.append(time.perf_counter() - t0)
        print(json.dumps({"backend": a.backend, "latency_s": sum(lat) / len(lat), "wer": wer(a.ref, text), "text": text}))
    except Exception as e:
        code = getattr(e, "code", type(e).__name__)
        print(json.dumps({"skipped": True, "backend": a.backend, "reason": f"{code}: {e}"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
