#!/usr/bin/env bash
# Phase-1 acceptance: typed protocol, event flow, streaming, runtime boundaries,
# provider abstraction, observability (traceId). ADR-0001 §66.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== install =="
pnpm install --prefer-offline 2>&1 | tail -2

echo "== typecheck =="
pnpm typecheck 2>&1 | tail -15

echo "== build =="
pnpm build 2>&1 | tail -5

echo "== boot local-model :11421 =="
(node services/local-model/dist/index.js &>/tmp/jarvis-local-model.log & echo $! > /tmp/jarvis-local-model.pid)
echo "== boot gateway :8787 =="
(LOCAL_MODEL_URL=http://127.0.0.1:11421 node apps/gateway/dist/index.js &>/tmp/jarvis-gateway.log & echo $! > /tmp/jarvis-gateway.pid)
trap 'kill $(cat /tmp/jarvis-local-model.pid) $(cat /tmp/jarvis-gateway.pid) 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:11421/health >/dev/null && curl -sf http://127.0.0.1:8787/health >/dev/null && break
  sleep 0.5
done

echo "== evals/routing fixtures =="
node -e '
const fs = require("fs");
const fixtures = JSON.parse(fs.readFileSync("evals/routing/fixtures.json", "utf8"));
const { execSync } = require("child_process");
const crypto = require("crypto");
for (const f of fixtures) {
  const id = crypto.randomUUID();
  const body = JSON.stringify({ id, sessionId: "eval-1", source: "cli", content: f.input });
  fs.writeFileSync("/tmp/jarvis-eval-body.json", body);
  const out = execSync(`curl -sN -X POST http://127.0.0.1:8787/v1/input -H "content-type: application/json" --data @/tmp/jarvis-eval-body.json`, { encoding: "utf8", maxBuffer: 1 << 20 });
  const events = out.split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
  const assert = require("assert");
  assert(events.length > 0, `no events for ${f.input}`);
  for (const e of events) assert.equal(e.traceId, id, "traceId must propagate");
  const wantFamily = f.expectEvent.split(".")[0] + ".";
  assert(events.some((e) => e.type === f.expectEvent || e.type.startsWith(wantFamily)), `missing ${f.expectEvent} family for "${f.input}" :: ${out.slice(0, 300)}`);
  const done = events.find((e) => e.type === "agent.completed" || e.type === "tool.completed");
  if (f.expectRoute === "deterministic") assert.equal(done?.payload?.ok ?? done?.payload?.route === "deterministic" ? true : done?.payload?.ok, true);
  console.log(`ok - "${f.input}" -> ${f.expectEvent} (${events.length} events, trace ${id.slice(0, 8)})`);
}
console.log("ALL ROUTING EVALS PASSED");
'
