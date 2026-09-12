"""Voice turn orchestration (ADR-0001 Phase 3 skeleton).

No sockets here: :meth:`VoiceSession.handle_message`, :meth:`audio_frame`
and :meth:`text_turn` are pure async logic returning outbox message dicts,
so they are unit-testable without FastAPI or any provider installed.

Provider protocols (all duck-typed, all optional/None-able, imported lazily
or not at all so this module imports WITHOUT providers installed):

- wake:   ``detect(frame: bytes) -> bool`` (optional; when absent, any
  speech frame counts as the wake trigger).
- vad:    ``is_speech(frame: bytes) -> bool`` or a plain ``(bytes) -> bool``
  callable (optional; falls back to :func:`audio.is_speech` energy stub).
- stt:    ``transcribe(pcm: bytes) -> str`` (sync or async) and/or
  ``transcribe_stream(pcm: bytes) -> AsyncIterator[str]`` yielding partials.
- tts:    ``synthesize_stream(text: str) -> AsyncIterator[bytes]`` yielding
  int16 mono PCM chunks, optional ``sample_rate`` attribute (else 22050).
- bridge: ``run_turn(text: str, traceId: str) -> AsyncIterator[str]`` async
  generator yielding response text chunks. (Sync/async single-string or
  list/tuple returns are also tolerated.) The bridge worker implements
  against this protocol.
"""

import asyncio
import base64
import inspect
import uuid

try:  # package import: python -m services.voice.app / pytest from repo root
    from .audio import (
        FRAME_BYTES,
        SAMPLE_RATE,
        TTS_RATE,
        EchoCanceller,
        decode_pcm16,
        is_speech,
    )
    from .state import StateMachine, VoiceState
except ImportError:  # top-level import: uvicorn app:app from services/voice/
    from audio import (  # type: ignore[no-redef]
        FRAME_BYTES,
        SAMPLE_RATE,
        TTS_RATE,
        EchoCanceller,
        decode_pcm16,
        is_speech,
    )
    from state import StateMachine, VoiceState  # type: ignore[no-redef]

# Utterance segmentation (20 ms frames assumed, 640 bytes @ 16k int16 mono).
SILENCE_FRAMES_END = 60  # 60 x 20 ms = 1.2 s of silence ends the utterance
MIN_SPEECH_FRAMES = 10  # fewer speech frames -> discard as noise
MAX_FRAMES = 400  # 400 x 20 ms = 8 s cap per utterance

STUB_TRANSCRIPT = "(voice stub: providers not installed)"
STUB_RESPONSE = "(voice stub)"


def _new_trace_id() -> str:
    return uuid.uuid4().hex


class VoiceSession:
    """One realtime voice conversation over the WS contract."""

    def __init__(
        self,
        wake=None,
        vad=None,
        stt=None,
        tts=None,
        bridge=None,
        wake_enabled: bool = False,
        vad_threshold: float = 500.0,
    ):
        self.sm = StateMachine()
        self.echo = EchoCanceller()
        self.wake = wake
        self.vad = vad
        self.stt = stt
        self.tts = tts
        self.bridge = bridge
        self.wake_enabled = wake_enabled
        self.vad_threshold = vad_threshold
        self._buf = bytearray()
        self._carry = b""
        self._speech_frames = 0
        self._silence_frames = 0
        self._total_frames = 0
        self._tts_task: asyncio.Task | None = None
        self.trace_id: str | None = None

    # -- small helpers -------------------------------------------------

    def _emit(self, outbox: list, state: VoiceState) -> None:
        outbox.append({"type": "state", "state": state.value})

    def _go(self, outbox: list, to: VoiceState) -> None:
        self.sm.transition(to)
        self._emit(outbox, to)

    def _reset_to_idle(self, outbox: list) -> None:
        if self.sm.state != VoiceState.IDLE:
            self.sm.reset()
            self._emit(outbox, VoiceState.IDLE)

    def _clear_buffer(self) -> None:
        del self._buf[:]
        self._carry = b""
        self._speech_frames = 0
        self._silence_frames = 0
        self._total_frames = 0

    def _frame_is_speech(self, frame: bytes) -> bool:
        vad = self.vad
        if vad is None:
            return is_speech(frame, threshold=self.vad_threshold)
        if callable(vad):
            return bool(vad(frame))
        fn = getattr(vad, "is_speech", None)
        if callable(fn):
            return bool(fn(frame))
        return is_speech(frame, threshold=self.vad_threshold)

    def _wake_triggered(self, frame: bytes) -> bool:
        if self.wake is None:
            return self._frame_is_speech(frame)
        detect = getattr(self.wake, "detect", None)
        if callable(detect):
            result = detect(frame)
            if inspect.isawaitable(result):
                return False  # async wake not polled here; fall back below
            if result:
                return True
        return self._frame_is_speech(frame)

    def interrupt(self) -> bool:
        """Cancel the in-flight TTS stream task, if any."""
        task = self._tts_task
        if task is not None and not task.done():
            task.cancel()
            return True
        return False

    # -- provider stages ------------------------------------------------

    async def _stt_transcribe(self, pcm: bytes, outbox: list) -> str:
        """Run STT, emitting partials when the provider streams them."""
        stt = self.stt
        if stt is None:
            return STUB_TRANSCRIPT
        stream_fn = getattr(stt, "transcribe_stream", None)
        if callable(stream_fn):
            text = ""
            result = stream_fn(pcm)
            if inspect.isasyncgen(result):
                async for partial in result:
                    if partial:
                        text = str(partial)
                        outbox.append({"type": "partial", "text": text})
            elif inspect.isawaitable(result):
                awaited = await result
                if awaited:
                    text = str(awaited)
                    outbox.append({"type": "partial", "text": text})
            elif result:
                text = str(result)
                outbox.append({"type": "partial", "text": text})
            if text:
                return text
            # streaming provider yielded nothing: fall through to transcribe()
        transcribe_fn = getattr(stt, "transcribe", None)
        if callable(transcribe_fn):
            result = transcribe_fn(pcm)
            if inspect.isawaitable(result):
                result = await result
            return str(result) if result is not None else ""
        return STUB_TRANSCRIPT

    async def _bridge_text(self, text: str, trace_id: str) -> str:
        """Collect bridge response chunks into a single string."""
        if self.bridge is None:
            return STUB_RESPONSE
        result = self.bridge.run_turn(text, trace_id)
        if inspect.isasyncgen(result):
            return "".join([str(c) async for c in result])
        if inspect.isawaitable(result):
            result = await result
        if isinstance(result, (list, tuple)):
            return "".join(str(c) for c in result)
        if isinstance(result, str):
            return result
        return str(result)

    async def _tts_stream(self, text: str, outbox: list) -> None:
        """SPEAKING -> tts.audio* -> tts.done -> IDLE (cancellable via barge-in).

        Raises asyncio.CancelledError when interrupted; the caller must NOT
        continue to tts.done/IDLE then (the barge-in path owns the state).
        """

        async def _collect() -> list:
            msgs = []
            if self.tts is None:
                return msgs
            rate = getattr(self.tts, "sample_rate", TTS_RATE) or TTS_RATE
            gen = self.tts.synthesize_stream(text)
            if inspect.isasyncgen(gen):
                async for pcm in gen:
                    if pcm:
                        msgs.append(
                            {
                                "type": "tts.audio",
                                "pcm_b64": base64.b64encode(bytes(pcm)).decode(),
                                "sample_rate": rate,
                            }
                        )
            elif inspect.isawaitable(gen):
                pcm = await gen
                if pcm:
                    msgs.append(
                        {
                            "type": "tts.audio",
                            "pcm_b64": base64.b64encode(bytes(pcm)).decode(),
                            "sample_rate": rate,
                        }
                    )
            return msgs

        self._go(outbox, VoiceState.SPEAKING)
        self._tts_task = asyncio.create_task(_collect())
        try:
            audio_msgs = await self._tts_task
        finally:
            self._tts_task = None
        outbox.extend(audio_msgs)
        outbox.append({"type": "tts.done"})
        self._go(outbox, VoiceState.IDLE)

    async def _run_turn(self, transcript: str, trace_id: str, outbox: list) -> list:
        """Shared ROUTING -> EXECUTING -> RESPONDING -> SPEAKING -> IDLE pipeline."""
        self._go(outbox, VoiceState.ROUTING)
        self._go(outbox, VoiceState.EXECUTING)
        response = await self._bridge_text(transcript, trace_id)
        self._go(outbox, VoiceState.RESPONDING)
        try:
            await self._tts_stream(response, outbox)
        except asyncio.CancelledError:
            # Barge-in cancelled the TTS task and already emitted
            # INTERRUPTED -> LISTENING; stop here, no tts.done/IDLE.
            pass
        return outbox

    async def _finalize_utterance(self, outbox: list) -> list:
        """Transcribe the buffered utterance and run the turn (or discard noise)."""
        pcm = bytes(self._buf)
        speech_frames = self._speech_frames
        self._clear_buffer()
        if speech_frames < MIN_SPEECH_FRAMES or not pcm:
            return outbox  # noise: stay LISTENING, no state change
        trace_id = _new_trace_id()
        self.trace_id = trace_id
        self._go(outbox, VoiceState.TRANSCRIBING)
        transcript = await self._stt_transcribe(pcm, outbox)
        if not transcript.strip():
            self._go(outbox, VoiceState.LISTENING)
            return outbox
        outbox.append({"type": "final", "text": transcript, "traceId": trace_id})
        await self._run_turn(transcript, trace_id, outbox)
        return outbox

    async def _barge_in(self, outbox: list) -> list:
        """Cancel TTS, clear the buffer, emit INTERRUPTED -> LISTENING."""
        self.interrupt()
        # Give a cancelled TTS task a chance to settle before moving on.
        await asyncio.sleep(0)
        self._go(outbox, VoiceState.INTERRUPTED)
        self._clear_buffer()
        self._go(outbox, VoiceState.LISTENING)
        return outbox

    # -- public entry points --------------------------------------------

    async def audio_frame(self, pcm: bytes) -> list:
        """Feed raw 16 kHz int16 mono PCM; returns outbox messages."""
        return await self._audio_bytes(bytes(pcm), [])

    async def _audio_bytes(self, pcm: bytes, outbox: list) -> list:
        data = self.echo.process(self._carry + pcm)
        self._carry = b""
        frames = [data[i : i + FRAME_BYTES] for i in range(0, len(data), FRAME_BYTES)]
        if frames and len(frames[-1]) < FRAME_BYTES:
            self._carry = frames.pop()
        for frame in frames:
            if len(frame) < FRAME_BYTES:
                continue
            speech = self._frame_is_speech(frame)
            state = self.sm.state

            if state == VoiceState.IDLE:
                self._go(
                    outbox, VoiceState.WAKE if self.wake_enabled else VoiceState.LISTENING
                )
                state = self.sm.state

            if state == VoiceState.WAKE:
                if self._wake_triggered(frame):
                    self._go(outbox, VoiceState.LISTENING)
                    state = self.sm.state
                else:
                    continue

            if state in (
                VoiceState.SPEAKING,
                VoiceState.RESPONDING,
                VoiceState.EXECUTING,
            ):
                if speech:
                    await self._barge_in(outbox)
                continue

            if state == VoiceState.LISTENING:
                self._buf.extend(frame)
                self._total_frames += 1
                if speech:
                    self._speech_frames += 1
                    self._silence_frames = 0
                else:
                    self._silence_frames += 1
                ended = self._silence_frames >= SILENCE_FRAMES_END
                too_long = self._total_frames >= MAX_FRAMES
                if (ended and self._speech_frames > 0) or too_long:
                    await self._finalize_utterance(outbox)
            # Audio in TRANSCRIBING/ROUTING/INTERRUPTED: ignored.
        return outbox

    async def text_turn(self, content: str) -> list:
        """Desktop/test entry: run a full turn from text (skips audio/STT)."""
        outbox: list = []
        self._reset_to_idle(outbox)
        self._clear_buffer()
        trace_id = _new_trace_id()
        self.trace_id = trace_id
        self._go(outbox, VoiceState.LISTENING)
        self._go(outbox, VoiceState.TRANSCRIBING)
        outbox.append({"type": "final", "text": content, "traceId": trace_id})
        await self._run_turn(content, trace_id, outbox)
        return outbox

    async def handle_message(self, msg: dict) -> list:
        """Route one client JSON message to logic; errors stay connected."""
        outbox: list = []
        if not isinstance(msg, dict):
            return [
                {
                    "type": "error",
                    "code": "VALIDATION_ERROR",
                    "message": "message must be JSON object",
                }
            ]
        mtype = msg.get("type")
        if mtype == "audio":
            b64 = msg.get("pcm_b64")
            if not isinstance(b64, str):
                return [
                    {
                        "type": "error",
                        "code": "VALIDATION_ERROR",
                        "message": "audio requires pcm_b64 string",
                    }
                ]
            if msg.get("sample_rate", SAMPLE_RATE) != SAMPLE_RATE:
                return [
                    {
                        "type": "error",
                        "code": "VALIDATION_ERROR",
                        "message": f"sample_rate must be {SAMPLE_RATE}",
                    }
                ]
            try:
                pcm = decode_pcm16(b64)
            except ValueError as exc:
                return [{"type": "error", "code": "VALIDATION_ERROR", "message": str(exc)}]
            return await self._audio_bytes(pcm, outbox)
        if mtype == "interrupt":
            if self.sm.state in (
                VoiceState.SPEAKING,
                VoiceState.RESPONDING,
                VoiceState.EXECUTING,
            ):
                return await self._barge_in(outbox)
            self._reset_to_idle(outbox)
            self._clear_buffer()
            return outbox
        if mtype == "text":
            content = msg.get("content")
            if not isinstance(content, str) or not content.strip():
                return [
                    {
                        "type": "error",
                        "code": "VALIDATION_ERROR",
                        "message": "text requires non-empty content",
                    }
                ]
            return await self.text_turn(content)
        if mtype == "config":
            wake = msg.get("wake")
            if wake is not None:
                if not isinstance(wake, bool):
                    return [
                        {
                            "type": "error",
                            "code": "VALIDATION_ERROR",
                            "message": "config.wake must be bool",
                        }
                    ]
                self.wake_enabled = wake
            return outbox
        return [
            {
                "type": "error",
                "code": "VALIDATION_ERROR",
                "message": f"unknown message type: {mtype!r}",
            }
        ]
