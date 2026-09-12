import type { BaseEvent } from "@jarvis/protocol";

// ADR-0001 Phase 5: memory wiring for the runtime pipeline.
//
// The cognition package (services/memory, owned by another worker) resolves
// at runtime via dynamic import only. The specifiers below are typed as
// `string` (not literals) so TypeScript skips static module resolution —
// this file compiles and runs whether or not the package (or its
// extract/retrieve submodules) has landed or is exported. When anything is
// missing, memory silently degrades to off. Per-op store failures (Pg down)
// disable the store for the process lifetime with a single JSON warning.
//
// NOTE (coordination): services/memory/package.json currently exports only
// "." — "@jarvis/memory/extract.js" and "@jarvis/memory/retrieve.js" need
// subpath exports (or root re-exports) before extraction/recall resolve.
const MEMORY_ROOT_SPEC: string = "@jarvis/memory";
const MEMORY_EXTRACT_SPEC: string = "@jarvis/memory/extract.js";
const MEMORY_RETRIEVE_SPEC: string = "@jarvis/memory/retrieve.js";

type UnknownRecord = Record<string, unknown>;

interface CandidateLike extends UnknownRecord {
  type?: string;
  content?: string;
  importance?: number;
  confidence?: number;
  entities?: string[];
}

interface MergeDecision {
  action: "new" | "merge";
  target?: UnknownRecord;
}

let warnedOnce = false;
function warnOnce(code: string, detail: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(JSON.stringify({ level: "warn", code, detail }));
}

let storePromise: Promise<UnknownRecord | undefined> | undefined;
let storeBroken = false;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

async function loadStore(): Promise<UnknownRecord | undefined> {
  if (storeBroken) return undefined;
  storePromise ??= (async (): Promise<UnknownRecord | undefined> => {
    try {
      const mod: unknown = await import(MEMORY_ROOT_SPEC);
      if (!isRecord(mod)) return undefined;
      const create = mod["createStore"];
      if (typeof create !== "function") return undefined;
      const store: unknown = await (create as () => unknown)();
      return isRecord(store) ? store : undefined;
    } catch {
      return undefined;
    }
  })();
  return storePromise;
}

function markBroken(code: string, detail: string): void {
  storeBroken = true;
  storePromise = Promise.resolve(undefined);
  warnOnce(code, detail);
}

async function loadSubmodule(spec: string): Promise<UnknownRecord | undefined> {
  try {
    const mod: unknown = await import(spec);
    return isRecord(mod) ? mod : undefined;
  } catch {
    return undefined;
  }
}

function contentOf(value: UnknownRecord): string {
  return typeof value["content"] === "string" ? (value["content"] as string) : "";
}

function numOf(value: UnknownRecord, key: string, fallback: number): number {
  return typeof value[key] === "number" ? (value[key] as number) : fallback;
}

function idOf(value: UnknownRecord): string | undefined {
  return typeof value["id"] === "string" ? (value["id"] as string) : undefined;
}

function publicView(value: UnknownRecord): UnknownRecord {
  const { embedding: _dropped, ...rest } = value;
  void _dropped;
  return rest;
}

function memoryEvent(traceId: string, memory: UnknownRecord): BaseEvent {
  return {
    id: globalThis.crypto.randomUUID(),
    type: "memory.created",
    timestamp: new Date().toISOString(),
    traceId,
    payload: { memory: publicView(memory) },
  };
}

/** Normalize store rows: ScoredMemory {memory, score} or plain Memory. */
function normalizeRows(rows: unknown[]): { record: UnknownRecord; score: number }[] {
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

async function safeList(store: UnknownRecord): Promise<UnknownRecord[] | undefined> {
  try {
    const list = store["list"];
    if (typeof list !== "function") return [];
    let rows: unknown;
    try {
      rows = await Reflect.apply(list as (a: unknown) => unknown, store, [{ limit: 200 }]);
    } catch {
      rows = await Reflect.apply(list as () => unknown, store, []);
    }
    if (!Array.isArray(rows)) return [];
    return rows.filter((r): r is UnknownRecord => isRecord(r));
  } catch (err) {
    markBroken("MEMORY_UNAVAILABLE", `memory list failed: ${String(err)}`);
    return undefined;
  }
}

async function safeSave(store: UnknownRecord, candidate: UnknownRecord): Promise<UnknownRecord | undefined> {
  try {
    for (const name of ["save", "create", "add", "upsert"]) {
      const fn = store[name];
      if (typeof fn !== "function") continue;
      const saved: unknown = await Reflect.apply(fn as (a: unknown) => unknown, store, [candidate]);
      if (isRecord(saved)) return saved;
      return candidate;
    }
    return undefined;
  } catch (err) {
    markBroken("MEMORY_UNAVAILABLE", `memory save failed: ${String(err)}`);
    return undefined;
  }
}

async function safeUpdate(
  store: UnknownRecord,
  id: string,
  patch: UnknownRecord,
): Promise<UnknownRecord | undefined> {
  try {
    for (const name of ["update", "patch", "merge"]) {
      const fn = store[name];
      if (typeof fn !== "function") continue;
      const saved: unknown = await Reflect.apply(fn as (a: unknown, b: unknown) => unknown, store, [id, patch]);
      if (isRecord(saved)) return saved;
      return { ...patch, id };
    }
    return undefined;
  } catch (err) {
    markBroken("MEMORY_UNAVAILABLE", `memory update failed: ${String(err)}`);
    return undefined;
  }
}

function normContent(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Local dedupe fallback (used only when mergeCandidates is unavailable). */
function findDuplicate(existing: UnknownRecord[], candidate: CandidateLike): UnknownRecord | undefined {
  const norm = normContent(candidate.content ?? "");
  if (norm === "") return undefined;
  const sameType = (m: UnknownRecord): boolean =>
    typeof candidate.type !== "string" || candidate.type === "" || m["type"] === candidate.type;
  const exact = existing.find((m) => sameType(m) && normContent(contentOf(m)) === norm);
  if (exact != null) return exact;
  const words = new Set(norm.split(" ").filter((w) => w.length > 3));
  if (words.size === 0) return undefined;
  let best: UnknownRecord | undefined;
  let bestOverlap = 0;
  for (const m of existing) {
    if (!sameType(m)) continue;
    const mw = new Set(
      normContent(contentOf(m))
        .split(" ")
        .filter((w) => w.length > 3),
    );
    let overlap = 0;
    for (const w of words) if (mw.has(w)) overlap += 1;
    if (overlap >= 2 && overlap > bestOverlap) {
      bestOverlap = overlap;
      best = m;
    }
  }
  return best;
}

function unionEntities(a: unknown, b: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of [a, b]) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (typeof e !== "string") continue;
      const k = e.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}

async function extractMany(
  extractCandidates: unknown,
  text: string,
  source: string,
): Promise<CandidateLike[]> {
  if (typeof extractCandidates !== "function" || text.trim() === "") return [];
  try {
    const out: unknown = await (extractCandidates as (t: string, s: string) => unknown)(text, source);
    if (!Array.isArray(out)) return [];
    return out
      .filter((v): v is CandidateLike => isRecord(v))
      .map((c) => ({ ...c, source: typeof c["source"] === "string" ? (c["source"] as string) : source }));
  } catch {
    return [];
  }
}

/**
 * Persist salient facts from a completed turn. Never throws: any failure
 * (missing package/exports, Pg down) yields [] and memory stays off.
 */
export async function rememberTurn(
  userText: string,
  responseText: string,
  traceId: string,
): Promise<BaseEvent[]> {
  try {
    const [extractMod, store] = await Promise.all([
      loadSubmodule(MEMORY_EXTRACT_SPEC),
      loadStore(),
    ]);
    if (store == null) return [];
    const extractCandidates = extractMod?.["extractCandidates"];
    if (typeof extractCandidates !== "function") return [];
    const mergeFn = extractMod?.["mergeCandidates"];
    const [userCands, agentCands] = await Promise.all([
      extractMany(extractCandidates, userText, "user"),
      extractMany(extractCandidates, responseText, "agent"),
    ]);
    const candidates = [...userCands, ...agentCands].filter(
      (c) => (c.content ?? "").trim() !== "",
    );
    if (candidates.length === 0) return [];
    const existing = await safeList(store);
    if (existing === undefined) return [];
    const events: BaseEvent[] = [];
    for (const candidate of candidates) {
      let persisted: UnknownRecord | undefined;
      let decision: MergeDecision | undefined;
      if (typeof mergeFn === "function") {
        try {
          const out: unknown = await (mergeFn as (e: unknown, c: unknown) => unknown)(
            existing,
            candidate,
          );
          if (isRecord(out) && (out["action"] === "new" || out["action"] === "merge")) {
            decision = {
              action: out["action"] as "new" | "merge",
              target: isRecord(out["target"]) ? (out["target"] as UnknownRecord) : undefined,
            };
          }
        } catch {
          decision = undefined;
        }
      }
      if (decision?.action === "merge" && decision.target != null) {
        const target = decision.target;
        const targetId = idOf(target);
        if (targetId != null) {
          persisted =
            (await safeUpdate(store, targetId, {
              importance: Math.min(1, numOf(target, "importance", 0.5) + 0.1),
              confidence: Math.max(
                numOf(target, "confidence", 0.5),
                numOf(candidate, "confidence", 0.5),
              ),
              lastAccessedAt: new Date().toISOString(),
              entities: unionEntities(target["entities"], candidate["entities"]),
            })) ?? target;
        }
      }
      if (persisted === undefined && decision?.action !== "merge") {
        const { reason: _reason, source: _source, ...rest } = candidate;
        void _reason;
        void _source;
        persisted = await safeSave(store, {
          ...rest,
          entities: Array.isArray(candidate["entities"]) ? candidate["entities"] : [],
        });
      }
      if (persisted === undefined) {
        // mergeCandidates unavailable or undecided → local dedupe fallback
        const duplicate = findDuplicate(existing, candidate);
        if (duplicate != null) {
          const dupId = idOf(duplicate);
          persisted = dupId != null ? await safeUpdate(store, dupId, { ...candidate }) : undefined;
        } else {
          const { reason: _reason, source: _source, ...rest } = candidate;
          void _reason;
          void _source;
          persisted = await safeSave(store, {
            ...rest,
            entities: Array.isArray(candidate["entities"]) ? candidate["entities"] : [],
          });
        }
      }
      if (persisted === undefined) {
        if (storeBroken) return events;
        continue;
      }
      existing.push(persisted);
      events.push(memoryEvent(traceId, persisted));
    }
    return events;
  } catch {
    return [];
  }
}

function localTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-záéíóúñü0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

async function safeTouch(store: UnknownRecord, id: string): Promise<void> {
  try {
    const touch = store["touch"];
    if (typeof touch !== "function") return;
    await Reflect.apply(touch as (a: unknown) => unknown, store, [id]);
  } catch {
    // best-effort recency bump; never disables the store
  }
}

/**
 * Recall up to k memory contents relevant to a query. Prefers the cognition
 * worker's recall() (retrieve.js); falls back to store.search + local
 * tokenization. Never throws.
 */
export async function recallFor(query: string, k = 5): Promise<string[]> {
  try {
    if (query.trim() === "") return [];
    const [retrieveMod, extractMod, store] = await Promise.all([
      loadSubmodule(MEMORY_RETRIEVE_SPEC),
      loadSubmodule(MEMORY_EXTRACT_SPEC),
      loadStore(),
    ]);
    if (store == null) return [];
    const recallFn = retrieveMod?.["recall"];
    if (typeof recallFn === "function") {
      try {
        const out: unknown = await (recallFn as (s: unknown, q: string, o: unknown) => unknown)(
          store,
          query,
          { k },
        );
        if (Array.isArray(out)) {
          return normalizeRows(out)
            .slice(0, k)
            .map((s) => contentOf(s.record));
        }
      } catch (err) {
        markBroken("MEMORY_UNAVAILABLE", `memory recall failed: ${String(err)}`);
        return [];
      }
    }
    // Fallback: entities via extract.js (or []) + direct store.search.
    let entities: string[] = [];
    try {
      const fn = extractMod?.["extractEntities"];
      if (typeof fn === "function") {
        const out: unknown = await (fn as (q: string) => unknown)(query);
        if (Array.isArray(out)) {
          entities = out.filter((e): e is string => typeof e === "string");
        }
      }
    } catch {
      entities = [];
    }
    const tokens = localTokens(query);
    try {
      const search = store["search"];
      if (typeof search !== "function") return [];
      const found: unknown = await Reflect.apply(search as (a: unknown) => unknown, store, [{
        queryTokens: tokens,
        queryEntities: entities,
        limit: k,
      }]);
      if (!Array.isArray(found)) return [];
      const top = normalizeRows(found).slice(0, k);
      const touchIds = top
        .slice(0, 3)
        .map((s) => idOf(s.record))
        .filter((id): id is string => id != null);
      for (const id of touchIds) await safeTouch(store, id);
      return top.map((s) => contentOf(s.record));
    } catch (err) {
      markBroken("MEMORY_UNAVAILABLE", `memory search failed: ${String(err)}`);
      return [];
    }
  } catch {
    return [];
  }
}

/** Render recalled memories as a system-prompt block ("" when empty). */
export function memorySystemBlock(mems: string[]): string {
  if (mems.length === 0) return "";
  const bullets = mems
    .map((m) => m.trim())
    .filter((m) => m !== "")
    .map((m) => `- ${m.length > 120 ? `${m.slice(0, 120)}…` : m}`);
  if (bullets.length === 0) return "";
  return `\nRelevant memories:\n${bullets.join("\n")}`;
}
