import Fastify from "fastify";
import { z } from "zod";
import { UserInputSchema } from "@jarvis/protocol";
import { runInput, runDelegated } from "@jarvis/runtime";
import { LocalProvider } from "@jarvis/providers";

const PORT = Number(process.env.GATEWAY_PORT ?? 8787);
const MODEL_URL = process.env.LOCAL_MODEL_URL ?? "http://127.0.0.1:11421";

const TaskBodySchema = z.object({
  kind: z.enum(["research", "coding", "automation", "background"]),
  prompt: z.string().min(1),
  workspace: z.string().optional(),
});

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
  const mod: unknown = await import(MEMORY_ROOT_SPEC);
  if (!isRecord(mod) || typeof mod["createStore"] !== "function") {
    throw new Error("memory store unavailable");
  }
  const store: unknown = await (mod["createStore"] as () => unknown)();
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

  app.post("/v1/tasks", async (req, reply) => {
    const parsed = TaskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "VALIDATION_ERROR" });
    }
    const traceId = globalThis.crypto.randomUUID();
    const workspace = parsed.data.workspace ?? process.env.JARVIS_WORKSPACE ?? process.cwd();
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
