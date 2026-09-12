#!/usr/bin/env bash
# Local models acceptance: Ollama backend (chat/embed/load/unload/swap) with stub fallback.
# Skips cleanly when Ollama is down. No tokens spent (fully local).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LM="${LOCAL_MODEL_URL:-http://127.0.0.1:11421}"

echo "== build local-model =="
pnpm --filter @jarvis/local-model build 2>&1 | tail -2

echo "== boot local-model :11421 =="
(node services/local-model/dist/index.js &>/tmp/jarvis-lm-models.log & echo $! > /tmp/jarvis-lm-models.pid)
trap 'kill $(cat /tmp/jarvis-lm-models.pid) 2>/dev/null || true' EXIT
for i in $(seq 1 20); do curl -sf "$LM/health" >/dev/null && break; sleep 0.5; done

HEALTH="$(curl -s "$LM/health")"
echo "health: $HEALTH"
if ! python3 -c "import json,sys; d=json.load(open('/tmp/jarvis-h.json','w'))" 2>/dev/null; then true; fi
echo "$HEALTH" > /tmp/jarvis-health.json
if ! python3 -c "import json; assert json.load(open('/tmp/jarvis-health.json'))['ollama'] is True"; then
  echo "SKIP ollama-backed checks (ollama down) — stub fallback only"
  curl -s -X POST "$LM/chat" -H "content-type: application/json" -d '{"messages":[{"role":"user","content":"hola"}]}'
  echo; exit 0
fi

echo "== /models =="
curl -s "$LM/models"; echo

echo "== /embed bge-m3 =="
curl -s -X POST "$LM/embed" -H "content-type: application/json" -d '{"input":"mi editor es cursor"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['dims']>=512, d; print('embed dims:', d['dims'], '| backend:', d['backend'])"

echo "== /chat default model (no <think> leak) =="
curl -s -m 300 -X POST "$LM/chat" -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Responde con exactamente: hola"}]}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); assert '<think>' not in d['text'], d['text'][:200]; assert len(d['text'])>0; print('chat ok:', d['model'], '|', d['text'][:120].replace(chr(10),' '), '| usage:', d['usage'])"

echo "== swap demo: unload chat, embed stays =="
curl -s -X POST "$LM/unload" -H "content-type: application/json" -d '{"model":"lfm2.5:8b"}'; echo
curl -s "$LM/models" | python3 -c "import json,sys; d=json.load(sys.stdin); print('resident after unload:', d['resident'])"
curl -s -X POST "$LM/load" -H "content-type: application/json" -d '{"model":"lfm2.5:8b","keep_alive":"5m"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['ok']; print('reloaded:', d['model'])"

echo "ALL LOCAL-MODEL CHECKS PASSED"

if curl -sf -m 3 "${LLAMA_URL:-http://127.0.0.1:11423}/health" >/dev/null 2>&1; then
  echo "== llama-server backend (BACKEND=llama, :11424) =="
  LM2="http://127.0.0.1:11424"
  (BACKEND=llama LOCAL_MODEL_PORT=11424 node services/local-model/dist/index.js &>/tmp/jarvis-lm-llama.log & echo $! > /tmp/jarvis-lm-llama.pid)
  for i in $(seq 1 20); do curl -sf "$LM2/health" >/dev/null && break; sleep 0.5; done
  curl -s -m 120 -X POST "$LM2/chat" -H "content-type: application/json" \
    -d '{"messages":[{"role":"user","content":"Responde con exactamente: hola"}]}' \
    | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['backend']=='llama', d; assert len(d['text'])>0; print('llama chat ok:', d['text'][:80])"
  kill "$(cat /tmp/jarvis-lm-llama.pid)" 2>/dev/null || true
  echo "ALL LLAMA-BACKEND CHECKS PASSED"
else
  echo "SKIP llama backend (no llama-server on :11423)"
fi
