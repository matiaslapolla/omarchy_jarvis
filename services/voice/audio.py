"""Audio helpers for the voice service (ADR-0001 Phase 3 skeleton).

Lightweight only: stdlib + optional numpy. No torch / whisper / piper here.
Real VAD (Silero) and AEC adapters are another worker's job; this module
exposes the seams (threshold param, EchoCanceller hooks) they will plug into.
"""

import base64
import struct

SAMPLE_RATE = 16000
TTS_RATE = 22050

# One 20 ms frame of 16 kHz int16 mono PCM.
FRAME_BYTES = 640


def decode_pcm16(b64: str) -> bytes:
    """Base64-decode a PCM16 mono frame; ValueError if not 16-bit aligned."""
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception as exc:
        raise ValueError(f"invalid pcm_b64: {exc}") from exc
    if len(raw) % 2 != 0:
        raise ValueError(f"pcm length {len(raw)} is not 16-bit aligned")
    return raw


def rms(frame: bytes) -> float:
    """Root-mean-square energy of an int16 mono PCM frame."""
    if len(frame) % 2 != 0:
        raise ValueError("frame length must be 16-bit aligned")
    if not frame:
        return 0.0
    try:
        import numpy as np

        samples = np.frombuffer(frame, dtype=np.int16).astype(np.float64)
        return float(np.sqrt(np.mean(samples * samples)))
    except ImportError:
        count = len(frame) // 2
        samples = struct.unpack(f"<{count}h", frame)
        return (sum(float(s) * s for s in samples) / count) ** 0.5


def is_speech(frame: bytes, threshold: float = 500.0) -> bool:
    """Energy-stub VAD: True when frame RMS exceeds ``threshold``."""
    return rms(frame) > threshold


class EchoCanceller:
    """Independent audio layer per ADR-0001 §31. Passthrough until real AEC lands."""

    def __init__(self) -> None:
        self._reference: bytes = b""

    def reference(self, tts_frame: bytes) -> None:
        """Feed a TTS output frame so future AEC can subtract it (no-op stub)."""
        self._reference = tts_frame

    def process(self, frame: bytes) -> bytes:
        """Return the (echo-cancelled) input frame; currently passthrough."""
        return frame
