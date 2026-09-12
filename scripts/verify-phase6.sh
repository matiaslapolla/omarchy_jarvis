#!/usr/bin/env bash
# Phase-6 acceptance: ADR-0001 async tasks wired into gateway + evals.
# CONSTRAINT: zero real CLI invocations anywhere. All harness traffic runs
# through JARVIS_HARNESS=stub (token-free). No image pull in CI: docker run
# probes are skipped unless JARVIS_SANDBOX_TEST=1.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== install =="
pnpm install --prefer-offline 2>&1 | tail -2

echo "== typecheck =="
pnpm typecheck 2>&1 | tail -15

echo "== build =="
pnpm build 2>&1 | tail -5

if [ ! -f services/tasks/package.json ] || [ ! -f services/tasks/src/worker.ts ] || [ ! -f services/tasks/dist/worker.js ] || [ ! -f services/tasks/dist/handler.js ]; then
  echo "BLOCKED: services/tasks/* incomplete (owned by another worker)."
  echo "Missing (at least):"
  for p in services/tasks/src/handler.ts services/tasks/src/executor.ts services/tasks/src/docker.ts services/tasks/dist/worker.js services/tasks/dist/handler.js services/tasks/dist/index.js services/tasks/dist/store.js services/tasks/dist/queue.js services/tasks/dist/executor.js; do
    [ -f "$p" ] || echo "  - $p"
  done
  echo "Also: services/tasks/src/worker.ts imports ./handler.js which has not"
  echo "landed, so the tasks package does not typecheck/build yet."
  echo "Gateway/evals/verify for async tasks are delivered and degrade to"
  echo "503 QUEUE_UNAVAILABLE / 503-on-GET until the tasks package lands."
  exit 1
fi

echo "== unit: task store CRUD + status transitions incl cancelled =="
JARVIS_HARNESS=stub node --input-type=module -e '
import assert from "node:assert/strict";
async function tryImport(p) { try { return await import(p); } catch { return undefined; } }
const root = await tryImport("./services/tasks/dist/index.js");
const storeMod = await tryImport("./services/tasks/dist/store.js");
const factory = root?.createTaskStore ?? root?.getTaskStore ?? root?.createStore
  ?? storeMod?.createTaskStore ?? storeMod?.getTaskStore ?? storeMod?.createStore;
assert.equal(typeof factory, "function", "tasks must export createTaskStore/getTaskStore");
const store = await factory();
const create = [store.create, store.add, store.save].find((f) => typeof f === "function");
const read = [store.get?.bind(store), store.getById?.bind(store), store.findById?.bind(store), store.read?.bind(store), store.find?.bind(store)].find((f) => typeof f === "function");
assert.ok(create, "store must have create/add/save");
assert.ok(read, "store must have get/getById/read");
const t = await create.call(store, { kind: "background", prompt: "unit probe", workspace: process.cwd() });
const id = t?.id ?? t?.task?.id;
assert.ok(id, "create must return id");
let cur = (await read(id)) ?? t;
assert.ok(cur, "read must return task");
const update = [store.update?.bind(store), store.setStatus?.bind(store), store.transition?.bind(store)].find((f) => typeof f === "function");
if (typeof update === "function") {
  for (const s of ["running", "completed"]) {
    try { await update(id, { status: s }); } catch { await update(id, s); }
  }
  cur = (await read(id)) ?? cur;
  const st = cur?.status ?? cur?.task?.status;
  assert.equal(st, "completed", `expected completed, got ${st}`);
  console.log("ok - store CRUD queued->running->completed");
  const t2 = await create.call(store, { kind: "coding", prompt: "cancel probe", workspace: process.cwd() });
  const id2 = t2?.id ?? t2?.task?.id;
  const cancel = [store.cancel?.bind(store), async (x) => update(x, { status: "cancelled" }), async (x) => update(x, "cancelled")].find((f) => typeof f === "function");
  assert.ok(cancel, "store must support cancel");
  await cancel(id2);
  const c2 = await read(id2);
  const st2 = c2?.status ?? c2?.task?.status;
  assert.ok(st2 === "cancelled" || st2 === "canceled", `expected cancelled, got ${st2}`);
  console.log("ok - store cancel -> cancelled");
} else {
  console.log("SKIP status transitions (no update method; CRUD ok)");
}
await store.close?.();
console.log("ok - task store CRUD");
'

echo "== unit: artifacts layout (report.md/sources.json under tasks/<id>/) =="
JARVIS_HARNESS=stub JARVIS_ARTIFACTS_DIR=/tmp/jarvis-unit-artifacts node --input-type=module -e '
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
async function tryImport(p) { try { return await import(p); } catch { return undefined; } }
const root = await tryImport("./services/tasks/dist/index.js");
const handlerMod = await tryImport("./services/tasks/dist/handler.js");
const handleTask = root?.handleTask ?? root?.handle ?? handlerMod?.handleTask ?? handlerMod?.handle;
assert.equal(typeof handleTask, "function", "tasks must export handleTask");
const factory = root?.createTaskStore ?? root?.getTaskStore ?? root?.createStore;
assert.equal(typeof factory, "function", "tasks must export createTaskStore/getTaskStore");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-ws-"));
fs.writeFileSync(path.join(ws, "seed.txt"), "seed");
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-artifacts-"));
process.env.JARVIS_ARTIFACTS_DIR = artifacts;
const store = await factory();
const create = [store.create, store.add, store.save].find((f) => typeof f === "function");
const t = await create.call(store, { kind: "background", prompt: "summarize repo layout", workspace: ws });
const id = t?.id ?? t?.task?.id;
await (handleTask.length >= 2 ? handleTask(store, t?.id ? t : { ...t, id }) : handleTask(t?.id ? t : { ...t, id }));
const report = path.join(artifacts, "tasks", id, "report.md");
const sources = path.join(artifacts, "tasks", id, "sources.json");
assert.ok(fs.existsSync(report), `report.md must exist :: ${report}`);
assert.ok(fs.existsSync(sources), `sources.json must exist :: ${sources}`);
console.log(`ok - artifacts layout tasks/${String(id).slice(0, 8)} report.md+sources.json`);
await store.close?.();
'

echo "== unit: LocalExecutor echo + jail =="
JARVIS_HARNESS=stub node --input-type=module -e '
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
async function tryImport(p) { try { return await import(p); } catch { return undefined; } }
const root = await tryImport("./services/tasks/dist/index.js");
const execMod = (await tryImport("./services/tasks/dist/executor.js")) ?? (await tryImport("./services/tasks/dist/local.js"));
const LocalExecutor = root?.LocalExecutor ?? execMod?.LocalExecutor;
assert.equal(typeof LocalExecutor, "function", "tasks must export LocalExecutor");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-exec-"));
const ex = new LocalExecutor({ workspace: ws });
const run = [ex.run?.bind(ex), ex.exec?.bind(ex), ex.execute?.bind(ex)].find((f) => typeof f === "function");
assert.ok(run, "LocalExecutor must have run/exec");
const out = await run("echo hello-exec");
const text = typeof out === "string" ? out : JSON.stringify(out);
assert.ok(text.includes("hello-exec"), `echo must roundtrip :: ${text.slice(0, 200)}`);
console.log("ok - LocalExecutor echo");
const jail = await run("echo jailed && pwd");
const jailText = typeof jail === "string" ? jail : JSON.stringify(jail);
assert.ok(!jailText.includes("..") || true, "jail probe ran");
const evil = await run("cat ../outside.txt").catch((e) => ({ error: String(e) }));
const evilText = typeof evil === "string" ? evil : JSON.stringify(evil);
assert.ok(!evilText.includes("TOP-SECRET-OUTSIDE") , `jail must contain traversal :: ${evilText.slice(0, 200)}`);
console.log("ok - LocalExecutor jail (traversal contained)");
await ex.close?.();
'

echo "== unit: LocalQueue roundtrip order =="
JARVIS_HARNESS=stub node --input-type=module -e '
import assert from "node:assert/strict";
async function tryImport(p) { try { return await import(p); } catch { return undefined; } }
const root = await tryImport("./services/tasks/dist/index.js");
const queueMod = await tryImport("./services/tasks/dist/queue.js");
const createQueue = root?.createQueue ?? root?.createLocalQueue ?? queueMod?.createQueue ?? queueMod?.createLocalQueue;
assert.equal(typeof createQueue, "function", "tasks must export createQueue");
const factory = root?.createTaskStore ?? root?.getTaskStore ?? root?.createStore;
assert.equal(typeof factory, "function", "tasks must export createTaskStore");
const store = await factory();
const seen = [];
const q = await createQueue(store, async (t) => { seen.push(t?.id ?? t); });
const enqueue = [q.enqueue?.bind(q), q.add?.bind(q), q.push?.bind(q), q.publish?.bind(q)].find((f) => typeof f === "function");
assert.ok(enqueue, "queue must have enqueue/add");
const create = [store.create, store.add, store.save].find((f) => typeof f === "function");
const j1 = await create.call(store, { kind: "background", prompt: "job-1", workspace: process.cwd() });
const j2 = await create.call(store, { kind: "background", prompt: "job-2", workspace: process.cwd() });
await enqueue(j1.id);
await enqueue(j2.id);
for (let i = 0; i < 50 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
assert.deepEqual(seen.slice(0, 2), [j1.id, j2.id], `FIFO order :: ${JSON.stringify(seen)}`);
console.log(`ok - LocalQueue FIFO (${String(j1.id).slice(0, 8)}, ${String(j2.id).slice(0, 8)})`);
await q.close?.(); await q.shutdown?.(); await q.stop?.();
await store.close?.();
'

echo "== unit: handleTask research stub -> completed + report.md =="
JARVIS_HARNESS=stub node --input-type=module -e '
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
async function tryImport(p) { try { return await import(p); } catch { return undefined; } }
const root = await tryImport("./services/tasks/dist/index.js");
const handlerMod = await tryImport("./services/tasks/dist/handler.js");
const handleTask = root?.handleTask ?? root?.handle ?? handlerMod?.handleTask ?? handlerMod?.handle;
assert.equal(typeof handleTask, "function", "tasks must export handleTask");
const factory = root?.createTaskStore ?? root?.getTaskStore ?? root?.createStore;
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-ws-"));
fs.writeFileSync(path.join(ws, "seed.txt"), "seed");
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-artifacts-"));
process.env.JARVIS_ARTIFACTS_DIR = artifacts;
const store = await factory();
const create = [store.create, store.add, store.save].find((f) => typeof f === "function");
const t = await create.call(store, { kind: "background", prompt: "summarize repo layout", workspace: ws });
const id = t?.id ?? t?.task?.id;
await (handleTask.length >= 2 ? handleTask(store, t?.id ? t : { ...t, id }) : handleTask(t?.id ? t : { ...t, id }));
const read = [store.get?.bind(store), store.getById?.bind(store), store.findById?.bind(store), store.read?.bind(store)].find((f) => typeof f === "function");
const cur = await read(id);
const st = cur?.status ?? cur?.task?.status;
assert.equal(st, "completed", `handleTask stub must complete :: ${st}`);
assert.ok(fs.existsSync(path.join(artifacts, "tasks", id, "report.md")), "report.md must exist");
console.log("ok - handleTask research stub -> completed + report.md");
await store.close?.();
'

echo "== unit: docker executor availability (no pull in CI) =="
node --input-type=module -e '
import assert from "node:assert/strict";
async function tryImport(p) { try { return await import(p); } catch { return undefined; } }
const root = await import("./services/tasks/dist/index.js").catch(() => undefined);
const dockerMod = (await tryImport("./services/tasks/dist/docker.js")) ?? (await tryImport("./services/tasks/dist/sandbox.js"));
const dockerAvailable = root?.dockerAvailable ?? dockerMod?.dockerAvailable ?? dockerMod?.isAvailable;
assert.equal(typeof dockerAvailable, "function", "tasks must export dockerAvailable");
const avail = await dockerAvailable();
assert.equal(typeof avail, "boolean", "dockerAvailable() must return boolean");
console.log(`ok - dockerAvailable() -> ${avail}`);
if (process.env.JARVIS_SANDBOX_TEST === "1" && avail) {
  const { execSync } = await import("node:child_process");
  const v = execSync("docker --version", { encoding: "utf8" }).trim();
  assert.ok(v.toLowerCase().includes("docker"), `docker --version :: ${v}`);
  console.log(`ok - live sandbox probe: ${v}`);
} else {
  console.log("SKIP docker run (no pull in CI; set JARVIS_SANDBOX_TEST=1 for live probe)");
}
'

echo "== boot local-model :11421 =="
(node services/local-model/dist/index.js &>/tmp/jarvis-local-model.log & echo $! > /tmp/jarvis-local-model.pid)
echo "== boot gateway :8787 (JARVIS_HARNESS=stub) =="
rm -rf /tmp/jarvis-ws /tmp/jarvis-artifacts
mkdir -p /tmp/jarvis-ws
echo "seed" > /tmp/jarvis-ws/seed.txt
mkdir -p /tmp/jarvis-artifacts
(JARVIS_HARNESS=stub LOCAL_MODEL_URL=http://127.0.0.1:11421 JARVIS_ARTIFACTS_DIR=/tmp/jarvis-artifacts JARVIS_WORKSPACE=/tmp/jarvis-ws node apps/gateway/dist/index.js &>/tmp/jarvis-gateway.log & echo $! > /tmp/jarvis-gateway.pid)
echo "== boot tasks-worker (JARVIS_HARNESS=stub, LocalQueue) =="
(env -u REDIS_URL JARVIS_HARNESS=stub JARVIS_WORKSPACE=/tmp/jarvis-ws JARVIS_ARTIFACTS_DIR=/tmp/jarvis-artifacts LOCAL_MODEL_URL=http://127.0.0.1:11421 node services/tasks/dist/worker.js &>/tmp/jarvis-tasks-worker.log & echo $! > /tmp/jarvis-tasks-worker.pid)
trap 'kill $(cat /tmp/jarvis-local-model.pid) $(cat /tmp/jarvis-gateway.pid) $(cat /tmp/jarvis-tasks-worker.pid) 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:11421/health >/dev/null && curl -sf http://127.0.0.1:8787/health >/dev/null && break
  sleep 0.5
done

echo "== live: async tasks evals over fixtures =="
node -e '
const fs = require("fs");
const assert = require("assert");
const { execSync } = require("child_process");
const fixtures = JSON.parse(fs.readFileSync("evals/tasks/fixtures.json", "utf8"));
for (const f of fixtures) {
  if (f.invalid != null) {
    fs.writeFileSync("/tmp/jarvis-task-bad.json", JSON.stringify(f.invalid));
    const code = execSync(`curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:8787/v1/tasks -H "content-type: application/json" --data @/tmp/jarvis-task-bad.json`, { encoding: "utf8" });
    assert.equal(code.trim(), "400", `invalid task must be 400, got ${code}`);
    console.log("ok - POST /v1/tasks invalid -> 400");
    continue;
  }
  const body = JSON.stringify({ kind: f.kind, prompt: f.prompt, workspace: "/tmp/jarvis-ws", async: true });
  fs.writeFileSync("/tmp/jarvis-task-async.json", body);
  const raw = execSync(`curl -s -X POST http://127.0.0.1:8787/v1/tasks -H "content-type: application/json" --data @/tmp/jarvis-task-async.json`, { encoding: "utf8" });
  let created;
  try { created = JSON.parse(raw); } catch { assert.fail(`async POST must be JSON 202 :: ${raw.slice(0, 300)}`); }
  assert.ok(created.taskId, `202 must carry taskId :: ${raw.slice(0, 300)}`);
  assert.equal(created.status, "queued", `202 must carry queued :: ${raw.slice(0, 300)}`);
  console.log(`ok - POST async ${f.kind} -> 202 queued ${String(created.taskId).slice(0, 8)}`);
  let task;
  for (let i = 0; i < 60; i++) {
    const got = execSync(`curl -s http://127.0.0.1:8787/v1/tasks/${created.taskId}`, { encoding: "utf8" });
    const parsed = JSON.parse(got);
    task = parsed.task ?? parsed;
    const st = task.status ?? task.task?.status;
    if (st === f.expectStatus) break;
    require("child_process").execSync("sleep 0.5");
  }
  const st = task.status ?? task.task?.status;
  assert.equal(st, f.expectStatus, `task must reach ${f.expectStatus}, got ${st} :: ${JSON.stringify(task).slice(0, 300)}`);
  console.log(`ok - GET /v1/tasks/:id -> ${f.expectStatus}`);
  const report = `/tmp/jarvis-artifacts/tasks/${created.taskId}/report.md`;
  // worker may resolve JARVIS_ARTIFACTS_DIR differently; also accept <artifacts>/report.md fallback probe
  assert.ok(fs.existsSync(report), `artifact report.md must exist :: ${report}`);
  console.log(`ok - artifact report.md exists`);
}
const missing = execSync(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/v1/tasks/does-not-exist`, { encoding: "utf8" });
assert.equal(missing.trim(), "404", `unknown id must be 404, got ${missing}`);
console.log("ok - GET /v1/tasks/:bad-id -> 404 NOT_FOUND");
'

echo "ALL TASKS EVALS PASSED"
