import Fastify from "fastify";
import { z } from "zod";
import { UserInputSchema } from "@jarvis/protocol";
import { contextFor, detectIntent, runInput, runDelegated } from "@jarvis/runtime";
import { LocalProvider } from "@jarvis/providers";

const PORT = Number(process.env.GATEWAY_PORT ?? 8787);
const MODEL_URL = process.env.LOCAL_MODEL_URL ?? "http://127.0.0.1:11421";

const TaskBodySchema = z.object({
  kind: z.enum(["research", "coding", "automation", "background"]),
  prompt: z.string().min(1),
  workspace: z.string().optional(),
  async: z.boolean().optional().default(false),
});

// ADR-0001 Phase 6: async tasks HTTP surface. services/tasks is owned by
// another worker and may not have landed yet, so access is dynamic-only
// (specifiers typed as `string` to skip static resolution) — same pattern
// as the Phase 5 memory wiring. Queue/store failures map to 503
// QUEUE_UNAVAILABLE. DEVIATION from the Phase 6 brief: the brief asks for
// static imports (createTaskStore, createQueue, handleTask); those would
// break typecheck/build while services/tasks/* is absent, so the gateway
// resolves them dynamically and adapts to slight API differences.
const TASKS_ROOT_SPEC: string = "@jarvis/tasks";
const TASKS_STORE_SPEC: string = "@jarvis/tasks/store.js";
const TASKS_QUEUE_SPEC: string = "@jarvis/tasks/queue.js";
const TASKS_HANDLER_SPEC: string = "@jarvis/tasks/handler.js";

let taskStorePromise: Promise<UnknownRecord> | undefined;
let taskQueuePromise: Promise<UnknownRecord> | undefined;

async function tryImport(spec: string): Promise<UnknownRecord | undefined> {
  try {
    const mod: unknown = await import(spec);
    return isRecord(mod) ? mod : undefined;
  } catch {
    return undefined;
  }
}

function pickFn(mod: UnknownRecord | undefined, names: string[]): ((...args: unknown[]) => unknown) | undefined {
  if (mod == null) return undefined;
  for (const name of names) {
    const fn = mod[name];
    if (typeof fn === "function") return fn as (...args: unknown[]) => unknown;
  }
  return undefined;
}

function pickStoreFn(store: UnknownRecord, names: string[]): ((...args: unknown[]) => unknown) | undefined {
  for (const name of names) {
    const fn = store[name];
    if (typeof fn === "function") return (...args: unknown[]) => Reflect.apply(fn as (...a: unknown[]) => unknown, store, args);
  }
  return undefined;
}

async function loadTaskStore(): Promise<UnknownRecord> {
  if (taskStorePromise == null) {
    taskStorePromise = (async () => {
      const root = await tryImport(TASKS_ROOT_SPEC);
      const storeMod = await tryImport(TASKS_STORE_SPEC);
      const factory =
        pickFn(root, ["getTaskStore", "createTaskStore", "createStore"]) ??
        pickFn(storeMod, ["getTaskStore", "createTaskStore", "createStore"]);
      if (factory == null) throw new Error("task store unavailable");
      const store: unknown = await (factory as () => unknown)();
      if (!isRecord(store)) throw new Error("task store unavailable");
      return store;
    })();
    taskStorePromise.catch(() => {
      taskStorePromise = undefined;
    });
  }
  return taskStorePromise;
}

async function loadTaskQueue(store: UnknownRecord): Promise<UnknownRecord> {
  if (taskQueuePromise == null) {
    taskQueuePromise = (async () => {
      const root = await tryImport(TASKS_ROOT_SPEC);
      const queueMod = await tryImport(TASKS_QUEUE_SPEC);
      const handlerMod = await tryImport(TASKS_HANDLER_SPEC);
      const handleTask =
        pickFn(root, ["handleTask", "handle"]) ?? pickFn(handlerMod, ["handleTask", "handle"]);
      const createQueue =
        pickFn(root, ["createQueue", "createLocalQueue", "getQueue"]) ??
        pickFn(queueMod, ["createQueue", "createLocalQueue", "getQueue"]);
      if (createQueue == null) throw new Error("task queue unavailable");
      // Landed tasks API: JobHandler = (task) => Promise<void> (see
      // services/tasks/src/queue.ts; worker.ts binds handleTask directly).
      // The brief sketched (t) => handleTask(store, t); support both arities.
      const handler = (t: unknown) => {
        if (handleTask == null) return Promise.resolve();
        const fn = handleTask as (...args: unknown[]) => unknown;
        return fn.length >= 2 ? fn(store, t) : fn(t);
      };
      const queue: unknown =
        createQueue.length >= 2
          ? await (createQueue as (s: unknown, h: unknown) => unknown)(store, handler)
          : await (createQueue as (s: unknown) => unknown)(store);
      if (!isRecord(queue)) throw new Error("task queue unavailable");
      return queue;
    })();
    taskQueuePromise.catch(() => {
      taskQueuePromise = undefined;
    });
  }
  return taskQueuePromise;
}

async function createAndEnqueueTask(
  kind: string,
  prompt: string,
  workspace: string,
): Promise<string> {
  const store = await loadTaskStore();
  const create = pickStoreFn(store, ["create", "add", "save", "upsert"]);
  if (create == null) throw new Error("task store has no create method");
  const created: unknown = await create({ kind, prompt, workspace });
  const id = isRecord(created)
    ? (typeof created["id"] === "string"
        ? (created["id"] as string)
        : isRecord(created["task"]) && typeof created["task"]["id"] === "string"
          ? (created["task"]["id"] as string)
          : undefined)
    : undefined;
  if (id == null || id === "") throw new Error("task create returned no id");
  const queue = await loadTaskQueue(store);
  const enqueue = pickStoreFn(queue, ["enqueue", "add", "push", "publish", "send"]);
  if (enqueue == null) throw new Error("task queue has no enqueue method");
  await enqueue(id);
  return id;
}

async function getTaskById(id: string): Promise<UnknownRecord | undefined> {
  const store = await loadTaskStore();
  const read = pickStoreFn(store, ["get", "getById", "findById", "read", "find"]);
  if (read == null) throw new Error("task store has no read method");
  const out: unknown = await read(id);
  if (out == null) return undefined;
  return isRecord(out) ? out : undefined;
}

// ADR-0001 Phase 5: memory HTTP surface. The cognition package
// (services/memory) may not have landed yet, so access is dynamic-only
// (specifiers typed as `string` to skip static resolution). Store failures
// (e.g. Pg down) map to 503 MEMORY_UNAVAILABLE.
const MEMORY_ROOT_SPEC: string = "@jarvis/memory";
const MEMORY_EXTRACT_SPEC: string = "@jarvis/memory/extract.js";
const MEMORY_RETRIEVE_SPEC: string = "@jarvis/memory/retrieve.js";

type UnknownRecord = Record<string, unknown>;

const MemoryRecallSchema = z.object({
  query: z.string().min(1),
  k: z.number().int().min(1).max(20).optional(),
});

const MemorySaveSchema = z.object({
  type: z.enum(["episodic", "semantic", "preference", "procedural"]),
  content: z.string().min(1),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-záéíóúñü0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
}

async function loadMemoryStore(): Promise<UnknownRecord> {
  const { getSharedStore } = await import("@jarvis/runtime");
  const store = await getSharedStore();
  if (!isRecord(store)) throw new Error("memory store unavailable");
  return store;
}

async function loadEntities(query: string): Promise<string[]> {
  try {
    const mod: unknown = await import(MEMORY_EXTRACT_SPEC);
    if (!isRecord(mod) || typeof mod["extractEntities"] !== "function") return [];
    const out: unknown = await (mod["extractEntities"] as (q: string) => unknown)(query);
    return Array.isArray(out) ? out.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

async function recallScored(
  store: UnknownRecord,
  query: string,
  k: number,
): Promise<{ record: UnknownRecord; score: number }[]> {
  // Primary: cognition worker's recall() (retrieve.js) — scores and touches.
  try {
    const mod: unknown = await import(MEMORY_RETRIEVE_SPEC);
    if (isRecord(mod) && typeof mod["recall"] === "function") {
      const out: unknown = await (mod["recall"] as (s: unknown, q: string, o: unknown) => unknown)(
        store,
        query,
        { k },
      );
      if (Array.isArray(out)) return normalizeScored(out).slice(0, k);
    }
  } catch {
    // fall through to direct store.search
  }
  const search = store["search"];
  if (typeof search !== "function") return [];
  const found: unknown = await Reflect.apply(search as (a: unknown) => unknown, store, [{
    queryTokens: tokenize(query),
    queryEntities: await loadEntities(query),
    limit: k,
  }]);
  if (!Array.isArray(found)) return [];
  return normalizeScored(found).slice(0, k);
}

/** Normalize ScoredMemory {memory, score} or plain Memory rows. */
function normalizeScored(rows: unknown[]): { record: UnknownRecord; score: number }[] {
  const out: { record: UnknownRecord; score: number }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const inner = row["memory"];
    if (isRecord(inner) && contentOf(inner) !== "") {
      out.push({ record: inner, score: numOf(row, "score", 0) });
    } else if (contentOf(row) !== "") {
      out.push({ record: row, score: numOf(row, "score", 0) });
    }
  }
  return out;
}

function publicMemory(value: UnknownRecord): UnknownRecord {
  const { embedding: _dropped, ...rest } = value;
  void _dropped;
  return rest;
}

function contentOf(value: UnknownRecord): string {
  return typeof value["content"] === "string" ? (value["content"] as string) : "";
}

function numOf(value: UnknownRecord, key: string, fallback: number): number {
  return typeof value[key] === "number" ? (value[key] as number) : fallback;
}

export function buildServer() {
  const app = Fastify({ logger: false });
  const provider = new LocalProvider(MODEL_URL);

  app.get("/health", async () => ({ ok: true }));

  app.post("/v1/input", async (req, reply) => {
    const parsed = UserInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "VALIDATION_ERROR" });
    }
    const input = parsed.data as { id: string };
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    try {
      for await (const event of runInput(input as never, { provider })) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      console.error(JSON.stringify({ level: "error", traceId: input.id, err: String(err) }));
      const code = (err as { code?: string }).code ?? "SYSTEM_ERROR";
      reply.raw.write(
        `data: ${JSON.stringify({ id: globalThis.crypto.randomUUID(), type: "tool.failed", timestamp: new Date().toISOString(), traceId: input.id, payload: { code } })}\n\n`,
      );
    }
    reply.raw.end();
    return reply;
  });

  // ADR-0001 Phase 7: advanced-context inspection. contextFor() never throws
  // and degrades to an empty block while @jarvis/context / @jarvis/vision
  // are still landing, so this endpoint never 500s (catch maps to empty).
  app.get("/v1/context", async (req, reply) => {
    const params = (req.query ?? {}) as { query?: unknown; workspace?: unknown };
    const query = typeof params.query === "string" ? params.query : "";
    if (query.trim() === "") {
      return reply.code(400).send({ code: "VALIDATION_ERROR" });
    }
    const traceId = globalThis.crypto.randomUUID();
    try {
      const workspace =
        typeof params.workspace === "string" && params.workspace !== ""
          ? params.workspace
          : (process.env.JARVIS_WORKSPACE ?? process.cwd());
      const { intent } = detectIntent(query);
      const { block, tokens } = await contextFor({ content: query, intent, workspace });
      return { block, tokens, traceId };
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", code: "CONTEXT_UNAVAILABLE", err: String(err) }));
      return { block: "", tokens: 0, traceId };
    }
  });

  app.post("/v1/tasks", async (req, reply) => {
    const parsed = TaskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "VALIDATION_ERROR" });
    }
    const isAsync = (parsed.data as { async?: boolean }).async ?? false;
    const workspace = parsed.data.workspace ?? process.env.JARVIS_WORKSPACE ?? process.cwd();
    if (isAsync) {
      try {
        const taskId = await createAndEnqueueTask(parsed.data.kind, parsed.data.prompt, workspace);
        return reply.code(202).send({ taskId, status: "queued" });
      } catch (err) {
        console.error(JSON.stringify({ level: "warn", code: "QUEUE_UNAVAILABLE", err: String(err) }));
        return reply.code(503).send({ code: "QUEUE_UNAVAILABLE" });
      }
    }
    const traceId = globalThis.crypto.randomUUID();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    try {
      for await (const event of runDelegated(parsed.data.kind, parsed.data.prompt, workspace, traceId, "background")) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      console.error(JSON.stringify({ level: "error", traceId, err: String(err) }));
      const code = (err as { code?: string }).code ?? "SYSTEM_ERROR";
      reply.raw.write(
        `data: ${JSON.stringify({ id: globalThis.crypto.randomUUID(), type: "tool.failed", timestamp: new Date().toISOString(), traceId, payload: { code } })}\n\n`,
      );
    }
    reply.raw.end();
    return reply;
  });

  app.get("/v1/tasks/:id", async (req, reply) => {
    const id = (req as { params?: { id?: string } }).params?.id ?? "";
    if (id === "") {
      return reply.code(404).send({ code: "NOT_FOUND" });
    }
    try {
      const task = await getTaskById(id);
      if (task == null) {
        return reply.code(404).send({ code: "NOT_FOUND" });
      }
      return { task };
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", code: "QUEUE_UNAVAILABLE", err: String(err) }));
      return reply.code(503).send({ code: "QUEUE_UNAVAILABLE" });
    }
  });

  app.post("/v1/memory/recall", async (req, reply) => {
    const parsed = MemoryRecallSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "VALIDATION_ERROR" });
    }
    const k = parsed.data.k ?? 5;
    try {
      const store = await loadMemoryStore();
      const scored = await recallScored(store, parsed.data.query, k);
      return {
        memories: scored.map((s) => ({
          content: contentOf(s.record),
          type: typeof s.record["type"] === "string" ? s.record["type"] : "semantic",
          importance: numOf(s.record, "importance", 0.5),
          confidence: numOf(s.record, "confidence", 0.6),
          score: s.score,
        })),
      };
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", code: "MEMORY_UNAVAILABLE", err: String(err) }));
      return reply.code(503).send({ code: "MEMORY_UNAVAILABLE" });
    }
  });

  app.post("/v1/memory", async (req, reply) => {
    const parsed = MemorySaveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "VALIDATION_ERROR" });
    }
    try {
      const store = await loadMemoryStore();
      const candidate = {
        type: parsed.data.type,
        content: parsed.data.content,
        importance: parsed.data.importance ?? 0.5,
        confidence: parsed.data.confidence ?? 0.6,
        entities: [] as string[],
      };
      let saved: UnknownRecord | undefined;
      for (const name of ["save", "create", "add", "upsert"]) {
        const fn = store[name];
        if (typeof fn !== "function") continue;
        const out: unknown = await Reflect.apply(fn as (a: unknown) => unknown, store, [candidate]);
        saved = isRecord(out) ? out : { ...candidate };
        break;
      }
      if (saved == null) throw new Error("memory store has no save method");
      return { memory: publicMemory(saved) };
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", code: "MEMORY_UNAVAILABLE", err: String(err) }));
      return reply.code(503).send({ code: "MEMORY_UNAVAILABLE" });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    console.error(JSON.stringify({ level: "error", err: String(err) }));
    void reply.code(500).send({ code: "INTERNAL_ERROR" });
  });

  return app;
}

const app = buildServer();
app
  .listen({ port: PORT, host: "0.0.0.0" })
  .catch((err: unknown) => {
    console.error(JSON.stringify({ level: "fatal", err: String(err) }));
    process.exit(1);
  });
