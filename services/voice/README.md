# Voice service skeleton (ADR-0001 Phase 3)
Setup: `python3 -m venv services/voice/.venv && services/voice/.venv/bin/pip install -r services/voice/requirements.txt`
Run: `VOICE_PORT=11422 services/voice/.venv/bin/uvicorn app:app --app-dir services/voice --host 127.0.0.1 --port 11422`
Health: `GET /health` -> `{"ok": true, "service": "voice"}`; realtime: `WS /v1/voice/stream`.
Contract: client sends `audio{pcm_b64,sample_rate:16000}|interrupt|text|config{wake}`; server replies `state|partial|final{traceId}|tts.audio|tts.done|error`.
States: IDLE->(WAKE)->LISTENING->TRANSCRIBING->ROUTING->EXECUTING->RESPONDING->SPEAKING->IDLE; barge-in -> INTERRUPTED->LISTENING. Every turn gets uuid4-hex traceId; every state change emits `{"type":"state"}`.
Audio: 20 ms frames (640 B @16k int16 mono); 1.2 s silence or 8 s max ends utterance; <10 speech frames discarded.
Bridge protocol (bridge worker implements): `async run_turn(text, traceId)` async-generator of response chunks; see session.py docstring.
Stub vs real: NullSTT echoes "(voice stub: providers not installed)", NullTTS is silent (tts.done still sent), NullBridge replies "(voice stub)". Real wake/VAD/STT/TTS/bridge providers plug into VoiceSession(...) via providers.py (other worker) — no torch/whisper/piper here.
Verify: `python3 -m compileall services/voice` + drive VoiceSession with Nulls (text_turn, barge-in) asserting the state order above.
Env: VOICE_PORT=11422, JARVIS_GATEWAY=http://127.0.0.1:8787 (bridge worker; ignored by app.py).
Layout: state.py (stdlib FSM) | audio.py (pcm/rms/energy-VAD/EchoCanceller) | session.py (turn logic, no sockets) | app.py (FastAPI+WS wiring).
Limits: light deps only (fastapi, uvicorn, websockets, httpx, numpy); never install ML packages in this service skeleton.
Ports/other owners: do NOT touch services/runtime, apps/gateway, packages/*, evals/*, scripts/verify-*.sh (bridge/evals/verify worker).
Wake: `{"type":"config","wake":true}` arms IDLE->WAKE->LISTENING; any speech frame is the stub wake trigger.
Barge-in: speech audio (or `interrupt`) during SPEAKING/RESPONDING/EXECUTING cancels TTS, clears the buffer, emits INTERRUPTED->LISTENING.
Errors: malformed/unknown client JSON -> `{"type":"error","code":"VALIDATION_ERROR",...}`, connection stays open.
No persistence: sessions are in-memory per WS connection; traceId is the only cross-message correlation id.
Next: provider worker adds wake/VAD/STT/TTS adapters + real bridge run_turn against JARVIS_GATEWAY; gateway worker consumes this WS contract as-is.
Debug: `services/voice/.venv/bin/python -c "import sys; sys.path.insert(0,'services/voice'); import app, session, state, audio; print('imports ok')"`.
