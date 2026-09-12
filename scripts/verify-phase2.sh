#!/usr/bin/env bash
# Phase-2 acceptance: ADR-0001 tools wired into runtime + gateway SSE evals.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== install =="
pnpm install --prefer-offline 2>&1 | tail -2

echo "== typecheck =="
pnpm typecheck 2>&1 | tail -15

echo "== build =="
pnpm build 2>&1 | tail -5

echo "== unit: permissions decide() matrix =="
node --input-type=module -e '
import assert from "node:assert/strict";
const { decide, PermissionLevel, loadToolContext } = await import("./packages/permissions/dist/index.js");
const ctx = loadToolContext("verify-phase2");
assert.equal(decide(PermissionLevel.SAFE, ctx), "allow");
assert.equal(decide(PermissionLevel.LOW, ctx), "allow");
assert.equal(decide(PermissionLevel.CONFIRM, ctx), "confirm");
assert.equal(decide(PermissionLevel.DANGEROUS, ctx), "deny");
assert.equal(decide(PermissionLevel.DANGEROUS, { ...ctx, allowDestructive: true }), "confirm");
console.log("ok - decide() matrix");
'

echo "== unit: tools executeTool paths =="
node --input-type=module -e '
import assert from "node:assert/strict";
const { Registry, executeTool } = await import("./packages/tools/dist/index.js");
const { registerSystemTools } = await import("./packages/tools/dist/system.js");
const { registerFileTools } = await import("./packages/tools/dist/files.js");
const { registerTerminalTools } = await import("./packages/tools/dist/terminal.js");
const { registerBrowserTools } = await import("./packages/tools/dist/browser.js");
const { loadToolContext } = await import("./packages/permissions/dist/index.js");
const reg = new Registry();
registerSystemTools(reg);
registerFileTools(reg);
registerTerminalTools(reg);
const ctx = loadToolContext("verify-phase2");
const unknown = await executeTool(reg, "nope.missing", {}, ctx);
assert.equal(unknown.status, "unknown-tool");
const invalid = await executeTool(reg, "system.volume", { level: "loud" }, ctx);
assert.equal(invalid.status, "invalid");
const approval = await executeTool(reg, "files.write", { path: "notes.txt", content: "hi" }, ctx);
assert.equal(approval.status, "approval-required");
const outside = await executeTool(reg, "files.read", { path: "/etc/jarvis-evil.txt" }, ctx);
assert.equal(outside.status, "done");
assert.equal(outside.result.ok, false);
assert.equal(outside.result.code, "PERMISSION_ERROR");
const gate = await executeTool(reg, "terminal.run", { cmd: "sudo ls" }, ctx);
assert.equal(gate.status, "approval-required");
const deny = await reg.get("terminal.run").execute({ cmd: "sudo ls", timeoutMs: 30000 }, ctx);
assert.equal(deny.ok, false);
assert.equal(deny.code, "PERMISSION_ERROR");
console.log("ok - executeTool unknown/invalid/approval/denied paths");
'

echo "== unit: browser memory backend roundtrip =="
node --input-type=module -e '
import assert from "node:assert/strict";
const { createBackend } = await import("./services/browser/dist/index.js");
const backend = createBackend("memory");
await backend.navigate("https://example.com");
const page = await backend.extract();
assert.equal(page.url, "https://example.com");
assert.ok(typeof page.title === "string" && typeof page.text === "string" && Array.isArray(page.links));
console.log("ok - browser memory navigate+extract roundtrip");
'

echo "== boot local-model :11421 =="
(node services/local-model/dist/index.js &>/tmp/jarvis-local-model.log & echo $! > /tmp/jarvis-local-model.pid)
echo "== boot gateway :8787 =="
(LOCAL_MODEL_URL=http://127.0.0.1:11421 node apps/gateway/dist/index.js &>/tmp/jarvis-gateway.log & echo $! > /tmp/jarvis-gateway.pid)
trap 'kill $(cat /tmp/jarvis-local-model.pid) $(cat /tmp/jarvis-gateway.pid) 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:11421/health >/dev/null && curl -sf http://127.0.0.1:8787/health >/dev/null && break
  sleep 0.5
done

echo "== evals/tools fixtures =="
node -e '
const fs = require("fs");
const fixtures = JSON.parse(fs.readFileSync("evals/tools/fixtures.json", "utf8"));
const { execSync } = require("child_process");
const crypto = require("crypto");
for (const f of fixtures) {
  const id = crypto.randomUUID();
  const body = JSON.stringify({ id, sessionId: "eval-2", source: "cli", content: f.input });
  fs.writeFileSync("/tmp/jarvis-eval-body.json", body);
  const out = execSync(`curl -sN -X POST http://127.0.0.1:8787/v1/input -H "content-type: application/json" --data @/tmp/jarvis-eval-body.json`, { encoding: "utf8", maxBuffer: 1 << 20 });
  const events = out.split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
  const assert = require("assert");
  assert(events.length > 0, `no events for ${f.input}`);
  for (const e of events) assert.equal(e.traceId, id, "traceId must propagate");
  const wantFamily = f.expectEvent.split(".")[0] + ".";
  assert(events.some((e) => e.type === f.expectEvent || e.type.startsWith(wantFamily)), `missing ${f.expectEvent} family for "${f.input}" :: ${out.slice(0, 300)}`);
  console.log(`ok - "${f.input}" -> ${f.expectEvent} (${events.length} events, trace ${id.slice(0, 8)})`);
}
console.log("ALL TOOLS EVALS PASSED");
'
