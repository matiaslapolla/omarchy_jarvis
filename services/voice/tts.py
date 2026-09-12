from __future__ import annotations

import asyncio
import math
import re
import struct
from collections.abc import AsyncIterator


class ProviderError(Exception):
    def __init__(self, message="", code="TTS_ERROR"):
        super().__init__(message)
        self.code = code


class TTSProvider:
    sample_rate = 22050

    async def synthesize_stream(self, text: str) -> AsyncIterator[bytes]:
        if False:
            yield b""
        raise NotImplementedError

    def stop(self):
        pass


def _sentences(text):
    return [p for p in (s.strip() for s in re.split(r"[.!?..\n]+", text or "")) if p]


def _sine_sentence(sample_rate, freq=440.0, secs=0.1):
    n = int(sample_rate * secs)
    try:
        import numpy as np

        t = np.arange(n) / sample_rate
        return (np.sin(2.0 * math.pi * freq * t) * 12000).astype("<i2").tobytes()
    except ImportError:
        return struct.pack("<%dh" % n, *(int(12000 * math.sin(2.0 * math.pi * freq * i / sample_rate)) for i in range(n)))


def _chunks(pcm, sample_rate, ms=20):
    step = sample_rate * 2 * ms // 1000
    return [pcm[i : i + step] for i in range(0, len(pcm), step)]


class StubTTS(TTSProvider):
    def __init__(self, sample_rate=22050):
        self.sample_rate = sample_rate

    async def synthesize_stream(self, text: str) -> AsyncIterator[bytes]:
        for _ in _sentences(text):
            pcm = await asyncio.to_thread(_sine_sentence, self.sample_rate)
            for piece in _chunks(pcm, self.sample_rate):
                yield piece


class PiperTTS(TTSProvider):
    def __init__(self, voice="es_ES-davefx-medium", piper_bin="piper", sample_rate=22050):
        self.voice = voice
        self.piper_bin = piper_bin
        self.sample_rate = sample_rate
        self._proc = None

    async def synthesize_stream(self, text: str) -> AsyncIterator[bytes]:
        import shutil
        import subprocess

        if shutil.which(self.piper_bin) is None:
            raise ProviderError(self.piper_bin + " not found", code="TTS_UNAVAILABLE")
        proc = subprocess.Popen(
            [self.piper_bin, "--model", self.voice, "--output-raw"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self._proc = proc
        try:
            try:
                proc.stdin.write((text or "").encode("utf-8"))
                proc.stdin.close()
            except BrokenPipeError:
                raise ProviderError("piper rejected input", code="TTS_UNAVAILABLE")
            step = self.sample_rate * 2 // 50
            while True:
                data = await asyncio.to_thread(proc.stdout.read, step)
                if not data:
                    break
                yield data
        finally:
            self._proc = None
        rc = await asyncio.to_thread(proc.wait)
        if rc != 0:
            raise ProviderError("piper exited %d" % rc, code="TTS_UNAVAILABLE")

    def stop(self):
        proc, self._proc = self._proc, None
        if proc is not None:
            try:
                proc.terminate()
            except OSError:
                pass


def _clip_to_s16le(clip):
    raw = clip[2] if isinstance(clip, (list, tuple)) else clip
    try:
        import numpy as np

        return (np.asarray(raw).astype("float64") * 32767).astype("<i2").tobytes()
    except ImportError:
        vals = [max(-1.0, min(1.0, float(v))) for v in raw]
        return struct.pack("<%dh" % len(vals), *(int(v * 32767) for v in vals))


class KokoroTTS(TTSProvider):
    def __init__(self, voice="ef_dora", lang="e", sample_rate=24000):
        self.voice = voice
        self.lang = lang
        self.sample_rate = sample_rate

    async def synthesize_stream(self, text: str) -> AsyncIterator[bytes]:
        try:
            from kokoro import KPipeline
        except ImportError:
            raise ProviderError("kokoro install is manual, see README", code="TTS_UNAVAILABLE")
        pipe = await asyncio.to_thread(KPipeline, lang_code=self.lang)
        for sentence in _sentences(text):
            clips = await asyncio.to_thread(lambda: list(pipe(sentence, voice=self.voice)))
            for clip in clips:
                pcm = await asyncio.to_thread(_clip_to_s16le, clip)
                for piece in _chunks(pcm, self.sample_rate):
                    yield piece


def build_tts(kind="stub", **kw):
    if kind == "stub":
        return StubTTS(**kw)
    if kind == "piper":
        return PiperTTS(**kw)
    if kind == "kokoro":
        return KokoroTTS(**kw)
    raise ValueError("unknown tts kind: %s" % kind)
