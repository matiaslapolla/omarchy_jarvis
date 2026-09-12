#!/usr/bin/env bash
# Phase-7 acceptance: ADR-0001 advanced context wired into runtime + gateway + evals.
# CONSTRAINTS: no `pnpm install` (frozen while other workers land
# packages/context + services/vision). Typecheck/build run per-package via
# `pnpm exec tsc`, NOT turbo: turbo's ^build graph would pull the other
# workers' not-yet-installed packages and fail on their scope, not ours.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== typecheck (runtime, gateway) =="
pnpm --filter @jarvis/runtime exec tsc -p . --noEmit 2>&1 | tail -5
pnpm --filter @jarvis/gateway exec tsc -p . --noEmit 2>&1 | tail -5

echo "== build (runtime first, then gateway) =="
pnpm --filter @jarvis/runtime exec tsc -p . 2>&1 | tail -3
pnpm --filter @jarvis/gateway exec tsc -p . 2>&1 | tail -3

echo "== provider presence probe =="
MISSING=()
for p in \
  packages/context/package.json \
  packages/context/dist/index.js \
  packages/context/dist/system.js \
  packages/context/dist/project.js \
  packages/context/dist/types.js \
  packages/context/node_modules \
  services/vision/package.json \
  services/vision/dist/index.js \
  services/vision/dist/capture.js \
  services/vision/dist/providers.js \
  services/vision/node_modules \
; do
  [ -e "$p" ] || MISSING+=("$p")
done
if [ "${#MISSING[@]}" -eq 0 ]; then
  echo "providers present: @jarvis/context + @jarvis/vision resolve"
else
  echo "providers incomplete (owned by other workers) — provider units SKIP, live runs degraded:"
  for p in "${MISSING[@]}"; do echo "  - $p"; done
fi
export PROVIDERS_MISSING="${MISSING[*]:-}"

echo "== unit: runtime contextFor (degraded-safe, never throws) =="
ROOT="$ROOT" PROVIDERS_MISSING="$PROVIDERS_MISSING" node --input-type=module -e '
import assert from "node:assert/strict";
const { contextFor } = await import("./services/runtime/dist/context.js");
const ws = process.env.ROOT;
const empty = await contextFor({ content: "   ", intent: "conversation", workspace: ws });
assert.equal(empty.block, "");
assert.equal(empty.tokens, 0);
const hola = await contextFor({ content: "hola", intent: "conversation", workspace: ws });
assert.equal(typeof hola.block, "string");
assert.equal(typeof hola.tokens, "number");
assert.ok(hola.block.length <= 4000, "hard cap 4000 chars");
assert.ok(hola.tokens >= 0 && (hola.block === "" ? hola.tokens === 0 : true), "tokens consistent");
const hostile = await contextFor({ content: "fix the login bug", intent: "coding", workspace: "/nonexistent-ws-xyz" });
assert.equal(typeof hostile.block, "string");
assert.ok(hostile.block.length <= 4000, "hard cap holds on hostile workspace");
const vis = await contextFor({ content: "mira mi pantalla", intent: "question", workspace: ws });
assert.equal(typeof vis.block, "string");
if ((process.env.PROVIDERS_MISSING ?? "").trim() !== "") {
  console.log(`ok - contextFor degraded (providers absent): hola=${hola.block.length}ch vis=${vis.block.length}ch, never throws`);
} else {
  assert.ok(vis.block.includes("Screen") || vis.block.includes("os:"), `vision/system query should enrich :: ${vis.block.slice(0, 200)}`);
  console.log("ok - contextFor enriched (providers present)");
}
console.log("ok - contextFor shape + 4000 cap + never throws");
'

if [ "${#MISSING[@]}" -eq 0 ]; then
echo "== unit: context budget/truncate/dedupe/estimate =="
node --input-type=module -e '
import assert from "node:assert/strict";
const ctx = await import("./packages/context/dist/index.js");
assert.equal(ctx.estimateTokens("abcd"), 1, "estimate ceil(len/4)");
assert.equal(ctx.BUDGETS.local.system, 2000, "local system budget");
const item = (content) => ({ source: "system", content, priority: 1 });
assert.equal(ctx.rank([item("a"), item("a"), item("b")]).length, 2, "rank dedupes");
const over = ctx.assemble([item("x".repeat(100))], 5);
assert.ok(over.includes("…[truncated]"), "assemble truncates over budget");
assert.ok(over.length < 100, "truncated output shorter than input");
console.log("ok - budget/truncate/dedupe/estimate");
'

echo "== unit: shouldCollect gates =="
node --input-type=module -e '
import assert from "node:assert/strict";
const { shouldCollect } = await import("./packages/context/dist/system.js");
const screen = shouldCollect("mira mi pantalla");
assert.equal(screen.app, true, "screen query -> app true");
const clip = shouldCollect("muéstrame esto del portapapeles");
assert.equal(clip.clipboard, true, "clipboard query -> clipboard true");
const hola = shouldCollect("hola");
assert.equal(hola.app, false, "hola -> app false");
assert.equal(hola.clipboard, false, "hola -> clipboard false");
console.log("ok - shouldCollect gates");
'

echo "== unit: collectSystem headless (os+hostname, no throw) =="
node --input-type=module -e '
import assert from "node:assert/strict";
const { collectSystem, toItem } = await import("./packages/context/dist/system.js");
const info = collectSystem({});
assert.equal(typeof info.os, "string");
assert.ok(info.os.length > 0, "os present headless");
assert.equal(typeof info.hostname, "string");
assert.ok(info.hostname.length > 0, "hostname present headless");
const items = toItem(info);
assert.ok(Array.isArray(items) && items.length === 1 && items[0].source === "system", "toItem shape");
assert.ok(items[0].content.includes(info.os), "item mentions os");
console.log(`ok - collectSystem headless (os=${info.os} host=${info.hostname.slice(0, 12)})`);
'

echo "== unit: collectProject(repo) mentions pnpm|typescript =="
node --input-type=module -e '
import assert from "node:assert/strict";
const { collectProject, forWhom } = await import("./packages/context/dist/project.js");
assert.equal(forWhom("coding"), true);
assert.equal(forWhom("question"), true);
assert.equal(forWhom("research"), true);
assert.equal(forWhom("conversation"), false);
const item = collectProject(process.cwd());
assert.ok(item != null, "repo root must yield a project item");
assert.ok(/pnpm|typescript/i.test(item.content), `project item mentions pnpm|typescript :: ${item.content.slice(0, 200)}`);
assert.equal(item.source, "project");
console.log(`ok - collectProject :: ${item.content.slice(0, 120)}`);
'

echo "== unit: buildContextBlock smoke =="
node --input-type=module -e '
import assert from "node:assert/strict";
const ctx = await import("./packages/context/dist/index.js");
const sys = await import("./packages/context/dist/system.js");
const proj = await import("./packages/context/dist/project.js");
const out = ctx.buildContextBlock({
  system: sys.toItem(sys.collectSystem({})),
  project: proj.collectProject(process.cwd()),
  memory: ["prefers dark mode"],
});
assert.equal(typeof out.text, "string");
assert.equal(typeof out.tokens, "number");
assert.ok(out.text.includes("## System"), "system section headed");
console.log(`ok - buildContextBlock (${out.tokens} tokens)`);
'

echo "== unit: vision StubVision honesty + pngSize synthetic + ollama path + lookAtScreen shape =="
node --input-type=module -e '
import assert from "node:assert/strict";
import fs from "node:fs";
const vision = await import("./services/vision/dist/index.js");
const { StubVision, OllamaVision } = await import("./services/vision/dist/providers.js");
const { pngSize } = await import("./services/vision/dist/capture.js");
const stub = new StubVision();
const said = await stub.describe({ path: "/tmp/x.png", width: 800, height: 600 });
assert.ok(/not installed|no visual interpretation/i.test(said.text), `stub must be honest :: ${said.text.slice(0, 160)}`);
console.log("ok - StubVision honesty");
// synthetic 800x600 PNG: signature + IHDR only (pngSize needs first 24 bytes)
const buf = Buffer.alloc(33);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
buf.writeUInt32BE(13, 8);
buf.write("IHDR", 12);
buf.writeUInt32BE(800, 16);
buf.writeUInt32BE(600, 20);
fs.writeFileSync("/tmp/jarvis-synth-800x600.png", buf);
const size = pngSize("/tmp/jarvis-synth-800x600.png");
assert.deepEqual(size, { width: 800, height: 600 }, "pngSize reads synthetic IHDR");
assert.equal(pngSize("/tmp/does-not-exist-xyz.png"), undefined, "pngSize undefined on missing file");
console.log("ok - pngSize synthetic 800x600");
// unavailable ollama path: missing file -> VISION_ERROR (deterministic, no network)
const ollama = new OllamaVision();
const err = await ollama.describe({ path: "/tmp/does-not-exist-xyz.png", width: 1, height: 1 }).then(
  () => undefined,
  (e) => e,
);
assert.ok(err && err.code === "VISION_ERROR", `ollama missing-file path -> VISION_ERROR, got ${err?.code}`);
console.log("ok - unavailable ollama path (VISION_ERROR on unreadable image)");
// lookAtScreen shape: capture | description | code (headless -> CAPTURE_UNAVAILABLE code)
const shot = await vision.lookAtScreen({ describe: false });
assert.ok(shot != null && typeof shot === "object", "lookAtScreen returns object");
assert.ok("capture" in shot || "code" in shot, "lookAtScreen shape: capture or code");
if ("capture" in shot && shot.capture) {
  assert.ok(shot.capture.width > 0 && shot.capture.height > 0 && typeof shot.capture.path === "string", "capture dims+path");
  console.log(`ok - lookAtScreen capture ${shot.capture.width}x${shot.capture.height}`);
} else {
  console.log(`ok - lookAtScreen unavailable (code=${shot.code})`);
}
'
else
  echo "SKIP context/vision provider units (providers missing — see probe above)"
fi

echo "== boot local-model :11421 =="
(node services/local-model/dist/index.js &>/tmp/jarvis-local-model.log & echo $! > /tmp/jarvis-local-model.pid)
echo "== boot gateway :8787 =="
(JARVIS_WORKSPACE="$ROOT" LOCAL_MODEL_URL=http://127.0.0.1:11421 node apps/gateway/dist/index.js &>/tmp/jarvis-gateway.log & echo $! > /tmp/jarvis-gateway.pid)
trap 'kill $(cat /tmp/jarvis-local-model.pid) $(cat /tmp/jarvis-gateway.pid) 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:11421/health >/dev/null && curl -sf http://127.0.0.1:8787/health >/dev/null && break
  sleep 0.5
done

echo "== live: GET /v1/context rejects missing query with 400 =="
code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/v1/context)
[ "$code" = "400" ] || { echo "FAIL: /v1/context without query -> $code (want 400)"; exit 1; }
code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8787/v1/context?query=%20")
[ "$code" = "400" ] || { echo "FAIL: /v1/context blank query -> $code (want 400)"; exit 1; }
echo "ok - GET /v1/context missing/blank query -> 400"

echo "== live: context fixtures (loose family match) =="
PROVIDERS_MISSING="$PROVIDERS_MISSING" node --input-type=module -e '
import assert from "node:assert/strict";
import fs from "node:fs";
const fixtures = JSON.parse(fs.readFileSync("evals/context/fixtures.json", "utf8"));
const degraded = (process.env.PROVIDERS_MISSING ?? "").trim() !== "";
const hit = (low, fam) => (fam === "vision" ? low.includes("vision") || low.includes("screen") : low.includes(fam));
for (const f of fixtures) {
  const url = new URL("http://127.0.0.1:8787/v1/context");
  url.searchParams.set("query", f.query);
  url.searchParams.set("workspace", process.cwd());
  const res = await fetch(url);
  assert.equal(res.status, 200, `GET /v1/context must never 500 for "${f.query}"`);
  const body = await res.json();
  assert.equal(typeof body.block, "string", "block is string");
  assert.equal(typeof body.tokens, "number", "tokens is number");
  assert.equal(typeof body.traceId, "string", "traceId present");
  const families = String(f.expectSource).split("|");
  if (body.block.trim() === "") {
    assert.ok(families.includes("none") || degraded, `"${f.query}" empty block but expect ${f.expectSource}`);
    console.log(`ok - "${f.query}" -> empty block (degraded/none, tokens=0 trace=${String(body.traceId).slice(0, 8)})`);
    continue;
  }
  const low = body.block.toLowerCase();
  assert.ok(families.some((fam) => fam !== "none" && hit(low, fam)), `"${f.query}" block must mention one of ${f.expectSource} :: ${body.block.slice(0, 200)}`);
  console.log(`ok - "${f.query}" -> ${f.expectSource} (${body.tokens} tokens trace=${String(body.traceId).slice(0, 8)})`);
}
'

echo "== live: POST /v1/input coding question still streams agent.* (no regression) =="
node --input-type=module -e '
import assert from "node:assert/strict";
import crypto from "node:crypto";
const id = crypto.randomUUID();
const body = JSON.stringify({ id, sessionId: "eval-7", source: "cli", content: "how do I fix the login bug?" });
const res = await fetch("http://127.0.0.1:8787/v1/input", { method: "POST", headers: { "content-type": "application/json" }, body });
assert.equal(res.status, 200, "POST /v1/input must be 200");
const out = await res.text();
const events = out.split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
assert.ok(events.length > 0, "must stream events");
for (const e of events) assert.equal(e.traceId, id, "traceId must propagate");
assert.ok(events.some((e) => e.type === "agent.completed" || e.type.startsWith("agent.")), `must stream agent.* family :: ${out.slice(0, 300)}`);
console.log(`ok - coding question -> agent.* (${events.length} events, trace ${id.slice(0, 8)})`);
'

if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "BLOCKED: @jarvis/context / @jarvis/vision incomplete (owned by other workers)."
  echo "Missing paths:"
  for p in "${MISSING[@]}"; do echo "  - $p"; done
  echo "Runtime/gateway/evals wiring above is delivered and degrades to empty context until they land."
  exit 1
fi

echo "ALL CONTEXT EVALS PASSED"
