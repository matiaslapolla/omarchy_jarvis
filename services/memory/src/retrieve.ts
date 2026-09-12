import { extractEntities } from "./extract.js";
import type { MemoryStore } from "./store.js";
import type { MemoryType, ScoredMemory } from "./types.js";

// ---------------------------------------------------------------------------
// retrieve.ts — memory recall (cognition worker, ADR-0001 P5)
// Allowed imports: ./extract.js (same worker) + type-only ./types.js, ./store.js.
// NOTE: tok() below mirrors store.tokenize (lowercase alnum split) as a local
// 3-line copy on purpose — tokenize lives in the store worker's file, and a
// value import on it would be a cross-worker file dep. Keep in sync.
// ---------------------------------------------------------------------------

/** Local mirror of store.tokenize: lowercase alnum split (byte-identical). */
function tok(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

export interface RecallOptions {
  k?: number;
  embedding?: number[];
  type?: MemoryType;
}

/**
 * Recall top-k memories for a query. Delegates scoring to store.search
 * (semantic×0.5 + recency×0.2 + importance×0.2 + entity×0.1), optionally
 * narrows to one MemoryType post-search, touches the top min(3, k) hits so
 * future recency reflects use, and returns the list.
 */
export async function recall(
  store: MemoryStore,
  query: string,
  opts?: RecallOptions,
): Promise<ScoredMemory[]> {
  const k = Math.max(0, opts?.k ?? 5);
  const results = await store.search({
    embedding: opts?.embedding,
    queryTokens: tok(query),
    queryEntities: extractEntities(query),
    limit: k,
  });
  const items =
    opts?.type != null
      ? results.filter((r) => r.memory.type === opts.type)
      : results;
  // touch() is on the shared-spec MemoryStore and on both store impls, but it
  // is missing from the MemoryStore interface declaration in store.ts (store
  // worker owns that file). Narrowing cast until the interface adds it.
  const touchable = store as MemoryStore & {
    touch(id: string): Promise<void>;
  };
  const n = Math.min(3, k, items.length);
  for (let i = 0; i < n; i++) {
    await touchable.touch(items[i].memory.id);
  }
  return items;
}
