#!/usr/bin/env bash
# Phase-4 acceptance: ADR-0001 delegation wired into runtime + gateway + evals.
# CONSTRAINT: zero real CLI invocations anywhere. All harness traffic runs
# through JARVIS_HARNESS=stub (token-free). The only CLI-harness check
# constructs OpencodeHarness with a nonexistent bin and asserts
# tool.failed/HARNESS_UNAVAILABLE without spawning anything.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== install =="
pnpm install --prefer-offline 2>&1 | tail -2

echo "== typecheck =="
pnpm typecheck 2>&1 | tail -15

echo "== build =="
pnpm build 2>&1 | tail -5

echo "== unit: route mapping + harnessFor =="
node --input-type=module -e '
import assert from "node:assert/strict";
const core = await import("./packages/core/dist/index.js");
assert.equal(core.selectRoute("coding"), "opencode");
assert.equal(core.selectRoute("research"), "background");
assert.equal(core.selectRoute("task"), "background");
assert.equal(core.selectRoute("question"), "local");
assert.equal(core.harnessFor("local"), "local");
assert.equal(core.harnessFor("opencode"), "opencode");
assert.equal(core.harnessFor("claudecode"), "claudecode");
assert.equal(core.harnessFor("background"), "opencode");
assert.equal(core.harnessFor("deterministic"), "local");
process.env.JARVIS_HARNESS = "stub";
assert.equal(core.harnessFor("opencode"), "stub");
assert.equal(core.harnessFor("local"), "stub");
delete process.env.JARVIS_HARNESS;
console.log("ok - route mapping + harnessFor (+stub override)");
'

echo "== unit: StubHarness yields >=3 events, all traceId =="
node --input-type=module -e '
import assert from "node:assert/strict";
import crypto from "node:crypto";
const { StubHarness } = await import("./packages/harness/dist/index.js");
const traceId = crypto.randomUUID();
const task = { id: crypto.randomUUID(), traceId, kind: "research", prompt: "x", workspace: process.cwd(), harness: "stub" };
const events = [];
for await (const e of new StubHarness().execute(task)) events.push(e);
assert.ok(events.length >= 3, `expected >=3 events, got ${events.length}`);
for (const e of events) assert.equal(e.traceId, traceId, "traceId must propagate");
console.log(`ok - StubHarness ${events.length} events, trace ${traceId.slice(0, 8)}`);
'

echo "== unit: OpencodeHarness bad bin yields HARNESS_UNAVAILABLE (no spawn) =="
node --input-type=module -e '
import assert from "node:assert/strict";
import crypto from "node:crypto";
const { OpencodeHarness } = await import("./packages/harness/dist/index.js");
const traceId = crypto.randomUUID();
const task = { id: crypto.randomUUID(), traceId, kind: "coding", prompt: "x", workspace: process.cwd(), harness: "opencode" };
const events = [];
for await (const e of new OpencodeHarness("/nonexistent-bin-xyz").execute(task)) events.push(e);
assert.ok(events.some((e) => e.type === "tool.failed" && JSON.stringify(e.payload).includes("HARNESS_UNAVAILABLE")), `missing HARNESS_UNAVAILABLE :: ${JSON.stringify(events).slice(0, 300)}`);
console.log("ok - OpencodeHarness bad bin -> tool.failed HARNESS_UNAVAILABLE");
'

echo "== unit: detectProject(repo root) =="
node --input-type=module -e '
import assert from "node:assert/strict";
const { detectProject } = await import("./packages/harness/dist/index.js");
const p = detectProject(process.cwd());
assert.equal(p.isGit, true);
assert.equal(p.packageManager, "pnpm");
console.log("ok - detectProject isGit + pnpm");
'

echo "== unit: delegation import surface (DRY, no live harness) =="
node --input-type=module -e '
import assert from "node:assert/strict";
const rt = await import("./services/runtime/dist/index.js");
assert.equal(typeof rt.runDelegated, "function");
assert.equal(typeof rt.harnessForRoute, "function");
assert.equal(typeof rt.runInput, "function");
console.log("ok - runtime exports runDelegated/harnessForRoute/runInput");
'

echo "== boot local-model :11421 =="
(node services/local-model/dist/index.js &>/tmp/jarvis-local-model.log & echo $! > /tmp/jarvis-local-model.pid)
echo "== boot gateway :8787 (JARVIS_HARNESS=stub) =="
(JARVIS_HARNESS=stub LOCAL_MODEL_URL=http://127.0.0.1:11421 node apps/gateway/dist/index.js &>/tmp/jarvis-gateway.log & echo $! > /tmp/jarvis-gateway.pid)
trap 'kill $(cat /tmp/jarvis-local-model.pid) $(cat /tmp/jarvis-gateway.pid) 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:11421/health >/dev/null && curl -sf http://127.0.0.1:8787/health >/dev/null && break
  sleep 0.5
done

echo "== evals/harness fixtures over POST /v1/input (stub) =="
node -e '
const fs = require("fs");
const fixtures = JSON.parse(fs.readFileSync("evals/harness/fixtures.json", "utf8"));
const { execSync } = require("child_process");
const crypto = require("crypto");
for (const f of fixtures) {
  const id = crypto.randomUUID();
  const body = JSON.stringify({ id, sessionId: "eval-4", source: "cli", content: f.input });
  fs.writeFileSync("/tmp/jarvis-eval-body.json", body);
  const out = execSync(`curl -sN -X POST http://127.0.0.1:8787/v1/input -H "content-type: application/json" --data @/tmp/jarvis-eval-body.json`, { encoding: "utf8", maxBuffer: 1 << 20 });
  const events = out.split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
  const assert = require("assert");
  assert(events.length > 0, `no events for ${f.input}`);
  for (const e of events) assert.equal(e.traceId, id, "traceId must propagate");
  assert(events.some((e) => e.type === f.expectEvent), `missing ${f.expectEvent} for "${f.input}" :: ${out.slice(0, 300)}`);
  console.log(`ok - "${f.input}" -> ${f.expectEvent} (${events.length} events, trace ${id.slice(0, 8)})`);
}
'

echo "== POST /v1/tasks asserts task.created SSE =="
node -e '
const { execSync } = require("child_process");
const assert = require("assert");
const fs = require("fs");
fs.writeFileSync("/tmp/jarvis-task-body.json", JSON.stringify({ kind: "research", prompt: "x" }));
const out = execSync(`curl -sN -X POST http://127.0.0.1:8787/v1/tasks -H "content-type: application/json" --data @/tmp/jarvis-task-body.json`, { encoding: "utf8", maxBuffer: 1 << 20 });
const events = out.split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
assert(events.length > 0, "no events for /v1/tasks");
const created = events.find((e) => e.type === "task.created");
assert(created, `missing task.created :: ${out.slice(0, 300)}`);
for (const e of events) assert.equal(e.traceId, created.traceId, "traceId must propagate");
console.log(`ok - POST /v1/tasks -> task.created (${events.length} events, trace ${created.traceId.slice(0, 8)})`);
fs.writeFileSync("/tmp/jarvis-task-bad.json", JSON.stringify({ kind: "nope", prompt: "" }));
const bad = execSync(`curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:8787/v1/tasks -H "content-type: application/json" --data @/tmp/jarvis-task-bad.json`, { encoding: "utf8" });
assert.equal(bad.trim(), "400", `expected 400, got ${bad}`);
console.log("ok - POST /v1/tasks invalid body -> 400 VALIDATION_ERROR");
'

echo "ALL HARNESS EVALS PASSED"
