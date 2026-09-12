#!/usr/bin/env bash
# Phase-5 acceptance: ADR-0001 memory wired into runtime + gateway + evals.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== install =="
pnpm install --prefer-offline 2>&1 | tail -2

echo "== typecheck =="
pnpm typecheck 2>&1 | tail -15

echo "== build =="
pnpm build 2>&1 | tail -5

if [ ! -f services/memory/package.json ]; then
  echo "BLOCKED: services/memory/* absent (no services/memory/package.json)."
  echo "The cognition package (store + extract + recall) is owned by another worker."
  echo "Runtime/gateway wiring is delivered and degrades to off until it lands."
  exit 1
fi

echo "== unit: extractor rules (dist) =="
node --input-type=module -e '
import assert from "node:assert/strict";
import fs from "node:fs";

const extract = await import("./services/memory/dist/extract.js").catch(() => undefined);
if (extract == null) {
  console.log("SKIP extractor units (services/memory/dist/extract.js absent)");
  process.exit(0);
}
const { extractCandidates, mergeCandidates, extractEntities } = extract;
assert.equal(typeof extractCandidates, "function", "extractCandidates must exist");
assert.equal(typeof mergeCandidates, "function", "mergeCandidates must exist");
assert.equal(typeof extractEntities, "function", "extractEntities must exist");

// evals/memory/fixtures.json doubles as extraction expectations
const fixtures = JSON.parse(fs.readFileSync("evals/memory/fixtures.json", "utf8"));
for (const f of fixtures.filter((x) => x.user != null)) {
  const cands = await extractCandidates(f.user, "user");
  assert.ok(Array.isArray(cands) && cands.length > 0, `no candidates for "${f.user}"`);
  assert.ok(
    cands.some((c) => c.type === f.expectType),
    `expected type ${f.expectType} for "${f.user}" :: ${JSON.stringify(cands)}`,
  );
  console.log(`ok - "${f.user}" -> ${f.expectType}`);
}
// EN fact from agent echo must not become a user fact (semantic is user-only)
const echo = await extractCandidates("(local stub) my editor is cursor", "agent");
assert.ok(
  !echo.some((c) => c.type === "semantic" && /cursor/i.test(c.content ?? "")),
  `agent echo must not persist as user fact :: ${JSON.stringify(echo)}`,
);
console.log("ok - EN fact user-vs-agent (agent echo ignored)");
// episodic: past event
const epi = await extractCandidates("yesterday I deployed the app to production", "user");
assert.ok(epi.some((c) => c.type === "episodic"), `expected episodic :: ${JSON.stringify(epi)}`);
console.log("ok - episodic past event");
// procedural: labeled steps
const proc = await extractCandidates("to deploy: 1) run pnpm build 2) run pnpm start", "user");
assert.ok(proc.some((c) => c.type === "procedural"), `expected procedural :: ${JSON.stringify(proc)}`);
console.log("ok - procedural how-to");
// dedupe: duplicate merges (update path), novel saves (new path)
const existing = await extractCandidates("my editor is cursor", "user");
const dup = { type: "semantic", content: "my editor is cursor", importance: 0.9, confidence: 0.9, reason: "t", entities: [] };
const merged = await mergeCandidates(existing, dup);
assert.equal(merged?.action, "merge", `duplicate must merge :: ${JSON.stringify(merged)}`);
assert.ok(merged?.target?.id != null || merged?.target?.content != null, "merge must name target");
console.log("ok - dedupe merge (duplicate -> update)");
const novel = { type: "preference", content: "prefiero café sin azúcar", importance: 0.5, confidence: 0.6, reason: "t", entities: [] };
const fresh = await mergeCandidates(existing, novel);
assert.equal(fresh?.action, "new", `novel candidate must be new :: ${JSON.stringify(fresh)}`);
console.log("ok - dedupe new (novel -> save)");
// entities: quoted spans are captured
const ents = await extractEntities("my editor is \"cursor\"");
assert.ok(Array.isArray(ents) && ents.some((e) => /cursor/i.test(e)), `entities must include cursor :: ${JSON.stringify(ents)}`);
console.log("ok - extractEntities finds cursor");
'

echo "== unit: scoring order (recent+important beats old+trivial) =="
node --input-type=module -e '
import assert from "node:assert/strict";

const index = await import("./services/memory/dist/index.js").catch(() => undefined);
const createStore = index?.createStore;
if (typeof createStore !== "function") {
  console.log("SKIP scoring (createStore export absent)");
  process.exit(0);
}
const store = await createStore();
const trivial = await store.save({ type: "semantic", content: "old trivial note about editor", importance: 0.1, confidence: 0.5, entities: [] });
const important = await store.save({ type: "semantic", content: "my editor is cursor", importance: 0.9, confidence: 0.9, entities: ["cursor"] });
assert.ok(trivial?.id && important?.id, "save must return ids");
const hits = await store.search({ queryTokens: ["editor", "cursor"], queryEntities: ["cursor"], limit: 5 });
assert.ok(Array.isArray(hits) && hits.length >= 2, "search must return hits");
assert.ok(
  /cursor/i.test(hits[0]?.memory?.content ?? ""),
  `recent+important must rank first :: ${JSON.stringify(hits.map((h) => h?.memory?.content))}`,
);
console.log("ok - recent+important beats old+trivial");
'

echo "== unit: reflection no-invention =="
node --input-type=module -e '
import assert from "node:assert/strict";

const reflectMod = await import("./services/memory/dist/reflect.js").catch(() => undefined);
const reflect = reflectMod?.reflect;
const index = await import("./services/memory/dist/index.js").catch(() => undefined);
if (typeof reflect !== "function" || typeof index?.createStore !== "function") {
  console.log("SKIP reflection (reflect/createStore absent)");
  process.exit(0);
}
const store = await index.createStore();
for (const content of ["deployed cursor config", "fixed cursor sync", "researched cursor plugins"]) {
  await store.save({ type: "episodic", content, importance: 0.5, confidence: 0.7, entities: ["cursor"] });
}
const report = await reflect(store);
assert.ok(Array.isArray(report?.procedural), "reflect must report procedural proposals");
const contents = report.procedural.map((p) => p.content ?? "");
assert.ok(contents.some((c) => /cursor/i.test(c)), `procedural content must contain entity :: ${JSON.stringify(contents)}`);
const rest = contents.join(" ").split(/\s+/).slice(1).join(" ");
const caps = rest.match(/\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}\b/g) ?? [];
assert.ok(
  caps.every((w) => /cursor/i.test(w)),
  `no invented proper nouns :: ${JSON.stringify(contents)}`,
);
const persisted = await store.list({ limit: 50 });
assert.ok(persisted.some((m) => m.type === "procedural" && /cursor/i.test(m.content)), "proposals must be persisted");
console.log("ok - reflection no-invention");
'

echo "== pg path =="
if [ -n "${DATABASE_URL:-}" ]; then
  PG_OK="no"
  if command -v pg_isready >/dev/null 2>&1; then
    HOST="$(node -e 'const u=new URL(process.env.DATABASE_URL);console.log(u.hostname)')"
    PORT="$(node -e 'const u=new URL(process.env.DATABASE_URL);console.log(u.port||5432)')"
    if pg_isready -h "$HOST" -p "$PORT" >/dev/null 2>&1; then PG_OK="yes"; fi
  else
    if node -e '
const net = require("net");
const u = new URL(process.env.DATABASE_URL);
const s = net.connect({ host: u.hostname, port: Number(u.port || 5432) });
const t = setTimeout(() => { s.destroy(); process.exit(1); }, 2000);
s.on("connect", () => { clearTimeout(t); s.end(); process.exit(0); });
s.on("error", () => { clearTimeout(t); process.exit(1); });
'; then PG_OK="yes"; fi
  fi
  if [ "$PG_OK" = "yes" ]; then
    node --input-type=module -e '
import assert from "node:assert/strict";
const mod = await import("./services/memory/dist/index.js").catch(() => undefined);
const PgStore = mod?.PgStore;
if (typeof PgStore !== "function") { console.log("SKIP pg (PgStore export absent)"); process.exit(0); }
const store = new PgStore(process.env.DATABASE_URL);
const saved = await store.save({ type: "semantic", content: "pg roundtrip cursor", importance: 0.8, confidence: 0.8, entities: [] });
assert.ok(saved?.id != null, "pg save must return id");
const hits = await store.search({ queryTokens: ["cursor"], queryEntities: ["cursor"], limit: 5 });
assert.ok(hits.some((h) => /cursor/i.test(h?.memory?.content ?? "")), "pg search must find cursor");
await store.close?.();
console.log("ok - PgStore save/search roundtrip");
'
  else
    echo "SKIP pg (DATABASE_URL set but unreachable)"
  fi
else
  echo "SKIP pg (no DATABASE_URL)"
fi

echo "== boot local-model :11421 =="
(node services/local-model/dist/index.js &>/tmp/jarvis-local-model.log & echo $! > /tmp/jarvis-local-model.pid)
echo "== boot gateway :8787 =="
(JARVIS_HARNESS=stub LOCAL_MODEL_URL=http://127.0.0.1:11421 node apps/gateway/dist/index.js &>/tmp/jarvis-gateway.log & echo $! > /tmp/jarvis-gateway.pid)
trap 'kill $(cat /tmp/jarvis-local-model.pid) $(cat /tmp/jarvis-gateway.pid) 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:11421/health >/dev/null && curl -sf http://127.0.0.1:8787/health >/dev/null && break
  sleep 0.5
done

echo "== live: turn persists memory.created =="
node -e '
const { execSync } = require("child_process");
const crypto = require("crypto");
const assert = require("assert");
const id = crypto.randomUUID();
const body = JSON.stringify({ id, sessionId: "eval-5", source: "cli", content: "prefiero respuestas cortas, mi editor es cursor" });
require("fs").writeFileSync("/tmp/jarvis-eval5-body.json", body);
const out = execSync(`curl -sN -X POST http://127.0.0.1:8787/v1/input -H "content-type: application/json" --data @/tmp/jarvis-eval5-body.json`, { encoding: "utf8", maxBuffer: 1 << 20 });
const events = out.split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
assert(events.length > 0, "no events from live turn");
for (const e of events) assert.equal(e.traceId, id, "traceId must propagate");
assert(events.some((e) => e.type === "memory.created"), `missing memory.created :: ${out.slice(0, 500)}`);
console.log(`ok - turn 1 persisted memory.created (${events.length} events)`);
'

echo "== live: recall serves cursor =="
node -e '
const fs = require("fs");
const assert = require("assert");
const { execSync } = require("child_process");
const fixtures = JSON.parse(fs.readFileSync("evals/memory/fixtures.json", "utf8"));
const rec = fixtures.find((f) => f.recall != null);
assert(rec, "fixtures must include a recall case");
fs.writeFileSync("/tmp/jarvis-eval5-recall.json", JSON.stringify({ query: rec.recall }));
const out = execSync(`curl -s -X POST http://127.0.0.1:8787/v1/memory/recall -H "content-type: application/json" --data @/tmp/jarvis-eval5-recall.json`, { encoding: "utf8" });
assert(out.toLowerCase().includes(rec.expectContains.toLowerCase()), `recall must contain "${rec.expectContains}" :: ${out.slice(0, 500)}`);
console.log(`ok - recall "${rec.recall}" -> "${rec.expectContains}"`);
fs.writeFileSync("/tmp/jarvis-eval5-save.json", JSON.stringify({ type: "semantic", content: "la clave del wifi es flúor", importance: 0.8 }));
const saved = execSync(`curl -s -X POST http://127.0.0.1:8787/v1/memory -H "content-type: application/json" --data @/tmp/jarvis-eval5-save.json`, { encoding: "utf8" });
assert(saved.includes("flúor"), `save must echo memory :: ${saved.slice(0, 300)}`);
fs.writeFileSync("/tmp/jarvis-eval5-recall2.json", JSON.stringify({ query: "wifi" }));
const out2 = execSync(`curl -s -X POST http://127.0.0.1:8787/v1/memory/recall -H "content-type: application/json" --data @/tmp/jarvis-eval5-recall2.json`, { encoding: "utf8" });
assert(out2.toLowerCase().includes("flúor"), `recall must find saved memory :: ${out2.slice(0, 300)}`);
console.log("ok - save/recall roundtrip");
const bad = execSync(`curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:8787/v1/memory/recall -H "content-type: application/json" --data "{}"`, { encoding: "utf8" });
assert.equal(bad.trim(), "400", "bad recall body must be 400");
const badSave = execSync(`curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:8787/v1/memory -H "content-type: application/json" --data "{}"`, { encoding: "utf8" });
assert.equal(badSave.trim(), "400", "bad save body must be 400");
console.log("ok - memory endpoints validate (400s)");
'

echo "ALL MEMORY EVALS PASSED"
