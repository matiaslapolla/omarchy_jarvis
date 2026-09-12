"""FastAPI entrypoint for the voice service skeleton (ADR-0001 Phase 3).

WS + state contract lives in session.py; this module only wires sockets to
VoiceSession. Provider construction lives in providers.py (owned by another
worker), so this file deliberately does NOT import it: sessions are built
from session.py plus the tiny inline Null* stubs below (silent TTS, stub
STT/bridge) that keep the service importable and testable with zero ML deps.

Env:
  VOICE_PORT      default 11422
  JARVIS_GATEWAY  default http://127.0.0.1:8787 (used by the bridge worker;
                  ignored here)
"""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:  # package import style (repo root / pytest)
    from services.voice.audio import TTS_RATE
    from services.voice.session import VoiceSession
except ImportError:  # top-level style (uvicorn app:app from services/voice/)
    from audio import TTS_RATE  # type: ignore[no-redef]
    from session import VoiceSession  # type: ignore[no-redef]

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

VOICE_PORT = int(os.environ.get("VOICE_PORT", "11422"))
JARVIS_GATEWAY = os.environ.get("JARVIS_GATEWAY", "http://127.0.0.1:8787")

app = FastAPI(title="jarvis-voice-skeleton")


class NullSTT:
    """Placeholder STT until the provider worker lands faster-whisper."""

    async def transcribe(self, pcm: bytes) -> str:
        return "(voice stub: providers not installed)"


class NullTTS:
    """Silent TTS: no audio chunks, but the tts.done lifecycle still flows."""

    sample_rate = TTS_RATE

    async def synthesize_stream(self, text: str):
        if False:  # pragma: no cover - keep this an async generator
            yield b""
        return


class NullBridge:
    """Stub runtime bridge: single fixed response chunk per turn."""

    async def run_turn(self, text: str, traceId: str):
        yield "(voice stub)"


def create_session() -> VoiceSession:
    """Build a VoiceSession with Null providers (real ones plug in later)."""
    return VoiceSession(stt=NullSTT(), tts=NullTTS(), bridge=NullBridge())


@app.get("/health")
async def health():
    return {"ok": True, "service": "voice"}


@app.websocket("/v1/voice/stream")
async def voice_stream(ws: WebSocket):
    await ws.accept()
    session = create_session()
    try:
        while True:
            try:
                raw = await ws.receive_text()
            except WebSocketDisconnect:
                break
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                await ws.send_json(
                    {
                        "type": "error",
                        "code": "VALIDATION_ERROR",
                        "message": "message must be JSON",
                    }
                )
                continue
            try:
                outbox = await session.handle_message(msg)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # stay connected on logic errors
                await ws.send_json(
                    {"type": "error", "code": "INTERNAL_ERROR", "message": str(exc)}
                )
                continue
            for m in outbox:
                await ws.send_json(m)
    except WebSocketDisconnect:
        pass
    finally:
        session.interrupt()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=VOICE_PORT)
