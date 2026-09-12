from __future__ import annotations

import os
import shutil
import struct
import subprocess
import tempfile
import wave

import numpy as np


class ProviderError(Exception):
    def __init__(self, *args, code="UNAVAILABLE", message=""):
        if args and not message:
            message = str(args[0])
        super().__init__(message or code)
        self.code = code
        self.message = message or str(super().__str__())


class WakeWordDetector:
    def listen(self, frame: bytes) -> bool:
        raise NotImplementedError


class StubWake(WakeWordDetector):
    def __init__(self, always: bool = False):
        self.always = always

    def listen(self, frame: bytes) -> bool:
        return self.always


class OpenWakeWord(WakeWordDetector):
    def __init__(self, detector=None, model: str = "hey_jarvis", threshold: float = 0.5, sample_rate: int = 16000):
        self.detector = detector
        self.model = model
        self.threshold = threshold
        self.sample_rate = sample_rate
        self._err: Exception | None = None
        if detector is None:
            try:
                from openwakeword.model import Model as _OWWModel
                self.detector = _OWWModel(wakeword_models=[model])
            except Exception as e:
                self._err = e
                self.detector = None

    def listen(self, frame: bytes) -> bool:
        if self._err is not None or self.detector is None:
            raise ProviderError(code="WAKE_UNAVAILABLE", message=f"openwakeword model {self.model} unavailable: {self._err}")
        try:
            audio = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0
            scores = self.detector.predict(audio)
        except ProviderError:
            raise
        except Exception as e:
            raise ProviderError(code="WAKE_UNAVAILABLE", message=f"openwakeword predict failed: {e}")
        if isinstance(scores, dict):
            for v in scores.values():
                try:
                    s = float(v[-1] if isinstance(v, (list, tuple, np.ndarray)) and len(v) else v)
                except Exception:
                    continue
                if s >= self.threshold:
                    return True
            return False
        try:
            return float(scores) >= self.threshold
        except Exception:
            return False


class VAD:
    def speech(self, frame: bytes, sample_rate: int = 16000) -> bool:
        raise NotImplementedError


def _rms_fallback(frame: bytes) -> float:
    n = len(frame) // 2
    if n == 0:
        return 0.0
    vals = struct.unpack("<" + "h" * n, frame[: n * 2])
    return (sum(v * v for v in vals) / n) ** 0.5


class EnergyVAD(VAD):
    def __init__(self, threshold: float = 500.0):
        self.threshold = threshold

    def speech(self, frame: bytes, sample_rate: int = 16000) -> bool:
        try:
            mod = __import__("services.voice.audio", fromlist=["rms"])
            return float(mod.rms(frame)) >= self.threshold
        except Exception:
            return _rms_fallback(frame) >= self.threshold


class SileroVAD(VAD):
    """Silero VAD over 30ms windows at 16kHz (480 samples)."""

    def __init__(self, threshold: float = 0.5, sample_rate: int = 16000):
        self.threshold = threshold
        self.sample_rate = sample_rate
        self._model = None
        self._err: Exception | None = None

    def _ensure(self):
        if self._model is not None:
            return
        if self._err is not None:
            raise ProviderError(code="VAD_UNAVAILABLE", message=f"silero vad unavailable: {self._err}")
        try:
            torch = __import__("torch")
        except Exception as e:
            self._err = e
            raise ProviderError(code="VAD_UNAVAILABLE", message=f"torch unavailable: {e}")
        try:
            model, _ = torch.hub.load("snakers4/silero-vad", "silero_vad", force_reload=False, trust_repo=True)
            model.eval()
            self._model = model
        except Exception as e:
            self._err = e
            raise ProviderError(code="VAD_UNAVAILABLE", message=f"silero model load failed: {e}")

    def speech(self, frame: bytes, sample_rate: int = 16000) -> bool:
        self._ensure()
        try:
            torch = __import__("torch")
            audio = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0
            t = torch.from_numpy(audio).unsqueeze(0)
            with torch.no_grad():
                prob = self._model(t, sample_rate).item()
            return float(prob) >= self.threshold
        except ProviderError:
            raise
        except Exception as e:
            raise ProviderError(code="VAD_UNAVAILABLE", message=f"silero vad failed: {e}")


class STTProvider:
    def transcribe(self, pcm: bytes, sample_rate: int = 16000) -> str:
        raise NotImplementedError

    def transcribe_stream(self, pcm: bytes, sample_rate: int = 16000):
        yield self.transcribe(pcm, sample_rate)


class StubSTT(STTProvider):
    def __init__(self, fixed: str = "(stt stub)"):
        self.fixed = fixed

    def transcribe(self, pcm: bytes, sample_rate: int = 16000) -> str:
        return self.fixed


class FasterWhisperSTT(STTProvider):
    def __init__(self, model: str = "small", language: str = "es", device: str = "cuda", compute: str = "int8"):
        self.model = model
        self.language = language
        self.device = device
        self.compute = compute
        self._model = None
        self._err: Exception | None = None

    def _ensure(self):
        if self._model is not None:
            return
        if self._err is not None:
            raise ProviderError(code="STT_UNAVAILABLE", message=f"faster-whisper unavailable: {self._err}")
        try:
            from faster_whisper import WhisperModel
        except Exception as e:
            self._err = e
            raise ProviderError(code="STT_UNAVAILABLE", message=f"faster-whisper unavailable: {e}")
        try:
            self._model = WhisperModel(self.model, device=self.device, compute_type=self.compute)
        except Exception as e:
            self._err = e
            raise ProviderError(code="STT_UNAVAILABLE", message=f"faster-whisper load failed: {e}")

    def transcribe(self, pcm: bytes, sample_rate: int = 16000) -> str:
        self._ensure()
        try:
            audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
            segments, _ = self._model.transcribe(audio, language=self.language)
            return " ".join(s.text.strip() for s in segments).strip()
        except ProviderError:
            raise
        except Exception as e:
            raise ProviderError(code="STT_UNAVAILABLE", message=f"faster-whisper transcribe failed: {e}")


class WhisperCppSTT(STTProvider):
    def __init__(self, model_path: str = "", binary: str = "whisper-cpp", language: str = "es", timeout: int = 120):
        self.model_path = model_path
        self.binary = binary
        self.language = language
        self.timeout = timeout

    def _probe(self) -> str | None:
        if not self.model_path or not os.path.exists(self.model_path):
            return f"model missing: {self.model_path or '(empty)'}"
        if shutil.which(self.binary) is None:
            return f"binary missing: {self.binary}"
        return None

    def transcribe(self, pcm: bytes, sample_rate: int = 16000) -> str:
        missing = self._probe()
        if missing is not None:
            raise ProviderError(code="STT_UNAVAILABLE", message=f"whisper-cpp unavailable: {missing}")
        try:
            n = len(pcm) // 2
            sampwidth = 2
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                wav_path = f.name
            with wave.open(wav_path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(sampwidth)
                w.setframerate(sample_rate)
                w.writeframes(pcm[: n * 2])
            cmd = [self.binary, "-m", self.model_path, "-l", self.language, "-f", wav_path]
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=self.timeout)
            finally:
                try:
                    os.unlink(wav_path)
                except OSError:
                    pass
            if r.returncode != 0:
                raise ProviderError(code="STT_UNAVAILABLE", message=f"whisper-cpp exit {r.returncode}: {(r.stderr or r.stdout)[-500:]}")
            return (r.stdout or "").strip()
        except ProviderError:
            raise
        except Exception as e:
            raise ProviderError(code="STT_UNAVAILABLE", message=f"whisper-cpp failed: {e}")


def build_capture(kind: str = "stub", **kw):
    wake_kw = dict(kw.get("wake_kw") or {})
    vad_kw = dict(kw.get("vad_kw") or {})
    stt_kw = dict(kw.get("stt_kw") or {})
    if kind == "stub":
        return StubWake(**wake_kw), EnergyVAD(**vad_kw), StubSTT(**stt_kw)
    if kind == "local":
        return (
            OpenWakeWord(**wake_kw),
            SileroVAD(**vad_kw),
            FasterWhisperSTT(**{**{"model": kw.get("model", "small"), "language": "es"}, **stt_kw}),
        )
    if kind == "whispercpp":
        return (
            StubWake(**wake_kw),
            EnergyVAD(**vad_kw),
            WhisperCppSTT(**{**{"model_path": kw.get("model_path", kw.get("model", "")), "language": "es"}, **stt_kw}),
        )
    raise ValueError(f"unknown capture kind: {kind}")
