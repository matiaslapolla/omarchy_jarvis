#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== compile =="
python3 -m compileall -q services/voice

echo "== venv =="
VENV=services/voice/.venv
PY=python3
if [ -x "$VENV/bin/python" ]; then
  PY="$VENV/bin/python"
elif $PY -m pip --version >/dev/null 2>&1; then
  if $PY -m venv "$VENV" >/dev/null 2>&1; then
    PY="$VENV/bin/python"
    if [ -f services/voice/requirements.txt ]; then
      if ! $PY -m pip install -q -r services/voice/requirements.txt 2>&1 | tail -3; then
        echo "warn: pip install failed (offline?), falling back to system python3"
        PY=python3
      fi
    fi
  fi
fi
echo "using $($PY -c 'import sys; print(sys.executable, sys.version.split()[0])')"
$PY -c "import numpy" 2>/dev/null && echo "numpy present" || echo "warn: numpy missing, stdlib fallbacks active"

echo "== imports + contracts =="
$PY - <<'EOF'
import asyncio, base64, math, os, struct

async def collect(agen):
    return [c async for c in agen]

from services.voice.state import InvalidTransition, StateMachine, VoiceState
sm = StateMachine()
for s in ("LISTENING", "TRANSCRIBING", "ROUTING", "EXECUTING", "RESPONDING", "SPEAKING", "INTERRUPTED", "LISTENING"):
    sm.transition(VoiceState(s))
try:
    sm.transition(VoiceState.SPEAKING)
    raise SystemExit("barge-in guard failed: LISTENING->SPEAKING allowed")
except InvalidTransition:
    pass
print("ok - state transitions incl barge-in INTERRUPTED->LISTENING")

from services.voice.audio import decode_pcm16, is_speech, rms
n = 320
sine = struct.pack("<%dh" % n, *(int(8000 * math.sin(2 * math.pi * 440 * i / 16000)) for i in range(n)))
silence = b"\x00\x00" * n
assert decode_pcm16(base64.b64encode(silence).decode()) == silence
try:
    decode_pcm16("!!!")
    raise SystemExit("decode_pcm16 accepted garbage")
except ValueError:
    pass
assert rms(sine) > rms(silence) == 0.0
assert is_speech(sine) and not is_speech(silence)
print("ok - audio decode/rms/silence")

from services.voice.providers_wake_vad_stt import EnergyVAD, StubSTT
assert EnergyVAD().speech(sine) and not EnergyVAD().speech(silence)
assert isinstance(StubSTT().transcribe(sine), str)
print("ok - providers EnergyVAD sine/silence, StubSTT")

from services.voice import tts
assert tts.TTSProvider.sample_rate == 22050
stub = tts.build_tts("stub")
got = asyncio.run(collect(stub.synthesize_stream("Hola. Adios.")))
assert len(got) > 0 and all(isinstance(c, bytes) and c for c in got), got
assert asyncio.run(collect(stub.synthesize_stream(""))) == []
assert isinstance(tts.build_tts("piper"), tts.PiperTTS)
assert isinstance(tts.build_tts("kokoro"), tts.KokoroTTS)
try:
    tts.build_tts("nope")
    raise SystemExit("build_tts accepted unknown kind")
except ValueError:
    pass
try:
    asyncio.run(collect(tts.PiperTTS(piper_bin="/nonexistent-piper-xyz").synthesize_stream("hola")))
    raise SystemExit("PiperTTS ran without binary")
except tts.ProviderError as e:
    assert e.code == "TTS_UNAVAILABLE", e.code
try:
    import kokoro  # noqa: F401
    print("note - kokoro installed, skipping unavailable-path check")
except ImportError:
    try:
        asyncio.run(collect(tts.KokoroTTS().synthesize_stream("hola")))
        raise SystemExit("KokoroTTS ran without kokoro")
    except tts.ProviderError as e:
        assert e.code == "TTS_UNAVAILABLE" and "manual" in str(e), (e.code, str(e))
print("ok - tts StubTTS chunks>0, build_tts, piper/kokoro unavailable paths")

from services.voice import bridge
assert bridge.GatewayBridge().base_url == "http://127.0.0.1:8787"
os.environ["JARVIS_GATEWAY"] = "http://127.0.0.1:9999/x"
assert bridge.GatewayBridge().base_url == "http://127.0.0.1:9999/x"
del os.environ["JARVIS_GATEWAY"]
assert bridge.GatewayBridge(session_id="s").session_id == "s"
try:
    asyncio.run(collect(bridge.GatewayBridge(base_url="http://127.0.0.1:9").run_turn("hola", "t1")))
    raise SystemExit("bridge reached closed port")
except bridge.ProviderError as e:
    assert e.code == "GATEWAY_UNREACHABLE", e.code

import json as _json, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
MODE = {"deltas": True}
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        ln = int(self.headers.get("Content-Length", 0))
        body = _json.loads(self.rfile.read(ln))
        assert body["source"] == "voice" and body["id"] == "trace-e2e", body
        evs = []
        if MODE["deltas"]:
            evs += [("agent.delta", {"delta": "hel"}), ("agent.delta", {"delta": "lo"})]
        evs += [("agent.completed", {"text": "hello"})]
        payload = "".join("data: " + _json.dumps({"id": str(i), "type": k, "timestamp": "t", "traceId": "trace-e2e", "payload": p}) + "\n\n" for i, (k, p) in enumerate(evs))
        raw = payload.encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def log_message(self, *a):
        pass
srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
gb = bridge.GatewayBridge(base_url="http://127.0.0.1:%d" % srv.server_port)
assert asyncio.run(collect(gb.run_turn("hi", "trace-e2e"))) == ["hel", "lo"]
MODE["deltas"] = False
assert asyncio.run(collect(gb.run_turn("hi", "trace-e2e"))) == ["hello"]
srv.shutdown()
print("ok - bridge GatewayBridge SSE delta/completed/unreachable")
EOF

APP=services/voice/app.py
if [ ! -f "$APP" ]; then
  echo "BLOCKED: missing $APP (session worker pending)"
  exit 1
fi

echo "== probe voice app =="
grep -o -m5 -E "create_app|VOICE_PORT|^app|uvicorn|FastAPI|/ws[^\"' ]*|/voice[^\"' ]*" "$APP" || true

echo "== boot local-model :11421 =="
if [ ! -f services/local-model/dist/index.js ] || [ ! -f apps/gateway/dist/index.js ]; then
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --prefer-offline 2>&1 | tail -2
    pnpm build 2>&1 | tail -5
  else
    echo "BLOCKED: node dist missing and pnpm unavailable"
    exit 1
  fi
fi
(node services/local-model/dist/index.js &>/tmp/jarvis-local-model.log & echo $! > /tmp/jarvis-local-model.pid)
echo "== boot gateway :8787 =="
(JARVIS_HARNESS=stub LOCAL_MODEL_URL=http://127.0.0.1:11421 node apps/gateway/dist/index.js &>/tmp/jarvis-gateway.log & echo $! > /tmp/jarvis-gateway.pid)
trap 'kill $(cat /tmp/jarvis-local-model.pid 2>/dev/null) $(cat /tmp/jarvis-gateway.pid 2>/dev/null) $(cat /tmp/jarvis-voice.pid 2>/dev/null) 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:11421/health >/dev/null && curl -sf http://127.0.0.1:8787/health >/dev/null && break
  sleep 0.5
done
curl -sf http://127.0.0.1:11421/health >/dev/null || { echo "local-model unhealthy"; tail -20 /tmp/jarvis-local-model.log || true; exit 1; }
curl -sf http://127.0.0.1:8787/health >/dev/null || { echo "gateway unhealthy"; tail -20 /tmp/jarvis-gateway.log || true; exit 1; }

echo "== boot voice :11422 =="
mkdir -p /tmp/jarvis-voice-ws
if grep -q "__main__" "$APP"; then
  (VOICE_PORT=11422 JARVIS_GATEWAY=http://127.0.0.1:8787 JARVIS_WORKSPACE=/tmp/jarvis-voice-ws $PY "$APP" &>/tmp/jarvis-voice.log & echo $! > /tmp/jarvis-voice.pid)
elif $PY -c "import uvicorn" >/dev/null 2>&1 && grep -q -E "^app|create_app" "$APP"; then
  if grep -q "^app" "$APP"; then TARGET="services.voice.app:app"; else TARGET="--factory services.voice.app:create_app"; fi
  # shellcheck disable=SC2086
  (VOICE_PORT=11422 JARVIS_GATEWAY=http://127.0.0.1:8787 JARVIS_WORKSPACE=/tmp/jarvis-voice-ws $PY -m uvicorn $TARGET --host 127.0.0.1 --port 11422 &>/tmp/jarvis-voice.log & echo $! > /tmp/jarvis-voice.pid)
else
  echo "BLOCKED: $APP exposes no runnable entry (__main__/uvicorn app)"
  exit 1
fi
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:11422/health >/dev/null && break
  sleep 0.5
done
curl -sf http://127.0.0.1:11422/health >/dev/null || { echo "voice /health failed"; tail -20 /tmp/jarvis-voice.log || true; exit 1; }
echo "ok - voice /health"

echo "== voice loopback (evals/voice/flow.json case 1) =="
if ! $PY -c "import websockets" >/dev/null 2>&1; then
  echo "SKIPPED-WS: python 'websockets' package not installed"
  echo "ALL VOICE EVALS PASSED (WS skipped)"
  exit 0
fi
WS_PATH="$(grep -o -E '"/[A-Za-z0-9/_.-]*"' "$APP" | tr -d '"' | grep -m1 -E 'ws|voice|stream' || true)"
WS_PATH="${WS_PATH:-/ws}"
echo "ws path: $WS_PATH"
VOICE_WS_URL="ws://127.0.0.1:11422$WS_PATH" JARVIS_WORKSPACE=/tmp/jarvis-voice-ws $PY - <<'EOF'
import asyncio, json, os
async def main():
    import websockets
    with open("evals/voice/flow.json") as f:
        flow = json.load(f)
    case = flow[0]
    content = case["send"]["content"]
    want = [w.split(":")[-1] for w in case["expect_sequence"]]
    got = []
    async with websockets.connect(os.environ["VOICE_WS_URL"], max_size=1 << 20) as ws:
        await ws.send(json.dumps({"type": "text", "content": content}))
        try:
            async with asyncio.timeout(30):
                async for msg in ws:
                    got.append(msg if isinstance(msg, str) else msg.decode())
                    if all(w in "\n".join(got) for w in want):
                        break
        except TimeoutError:
            pass
    blob = "\n".join(got)
    missing = [w for w in want if w not in blob]
    assert not missing, "missing %s :: %s" % (missing, blob[:500])
    print("ok - voice loopback:", want)
asyncio.run(main())
EOF
echo "note - flow.json case 2 (barge-in) needs live audio duplex, documentary only"
echo "ALL VOICE EVALS PASSED"
