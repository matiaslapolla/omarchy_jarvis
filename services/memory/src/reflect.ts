import { jaccard } from "./extract.js";
import type { MemoryStore } from "./store.js";
import type { Memory, MemoryCandidate } from "./types.js";

// ---------------------------------------------------------------------------
// reflect.ts — async memory reflection (cognition worker, ADR-0001 P5)
// Allowed imports: ./extract.js (same worker) + type-only ./types.js, ./store.js.
// Assumed MemoryStore surface (per shared spec; store worker implements it):
//   list(opts?: { limit?: number }): Promise<Memory[]>
//   update(id, patch: { importance?; confidence?; entities? }): Promise<...>
//   save(input: NewMemory): Promise<Memory>
// The store has NO delete: consolidation losers are marked faded instead.
// ---------------------------------------------------------------------------

export interface ReflectionReport {
  reviewed: number;
  consolidated: number;
  faded: number;
  procedural: MemoryCandidate[];
}

export interface ReflectOptions {
  /** Only review memories accessed within the last N days (default: all). */
  sinceDays?: number;
  /** Memories older than N days with importance < 0.3 fade (default 30). */
  staleDays?: number;
}

const DAY_MS = 86_400_000;
const CONSOLIDATE_THRESHOLD = 0.85;

function timestampOf(m: Memory): number {
  const a = Date.parse(m.lastAccessedAt);
  if (!Number.isNaN(a)) return a;
  const b = Date.parse(m.createdAt);
  return Number.isNaN(b) ? 0 : b;
}

function ageMs(m: Memory, now: number): number {
  const t = timestampOf(m);
  if (!t) return 0; // unparseable timestamp → treat as fresh, never fade
  return now - t;
}

/**
 * Daily reflection: consolidate near-duplicate same-type memories
 * (jaccard > 0.85 → keeper takes max importance/confidence + entity union,
 * loser is marked faded at min(importance, 0.1)), fade stale low-importance
 * memories (age > staleDays && importance < 0.3 → max(0.05, imp * 0.5)), and
 * propose procedural candidates for episodic entities seen >= 3 times.
 * Procedural proposals use ONLY the entity string — never invented specifics —
 * are persisted via save() as low-confidence new knowledge, and returned.
 */
export async function reflect(
  store: MemoryStore,
  opts?: ReflectOptions,
): Promise<ReflectionReport> {
  const staleDays = opts?.staleDays ?? 30;
  const sinceDays = opts?.sinceDays;
  const now = Date.now();

  const all = await store.list({ limit: 1000 });
  const pool = all.filter(
    (m) => sinceDays == null || ageMs(m, now) <= sinceDays * DAY_MS,
  );
  const reviewed = pool.length;

  // 1) Consolidate near-duplicates (greedy, list order, deterministic).
  const folded = new Set<string>();
  let consolidated = 0;
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    if (folded.has(a.id)) continue;
    for (let j = i + 1; j < pool.length; j++) {
      const b = pool[j];
      if (folded.has(b.id)) continue;
      if (a.type !== b.type) continue;
      if (jaccard(a.content, b.content) <= CONSOLIDATE_THRESHOLD) continue;
      // Tie → a (earlier in list order) keeps. Deterministic.
      const keeper = b.importance > a.importance ? b : a;
      const loser = keeper === b ? a : b;
      const entities = Array.from(
        new Set([...keeper.entities, ...loser.entities]),
      );
      const importance = Math.max(keeper.importance, loser.importance);
      const confidence = Math.max(keeper.confidence, loser.confidence);
      // Spec: keeper takes the entity union via update. The update patch type
      // in store.ts (store worker's file) omits "entities", so this cast
      // carries it until the Pick is widened. MemoryStoreImpl persists it via
      // spread; PgStore currently ignores it.
      await store.update(keeper.id, { importance, confidence, entities } as Partial<
        Pick<Memory, "importance" | "confidence" | "content" | "lastAccessedAt">
      >);
      keeper.importance = importance;
      keeper.confidence = confidence;
      keeper.entities = entities;
      // No delete on the store → mark the loser faded instead.
      const loserImportance = Math.min(loser.importance, 0.1);
      await store.update(loser.id, { importance: loserImportance });
      loser.importance = loserImportance;
      folded.add(loser.id);
      consolidated++;
    }
  }

  // 2) Fade stale, low-importance memories (skip already-folded losers).
  let faded = 0;
  const staleMs = staleDays * DAY_MS;
  for (const m of pool) {
    if (folded.has(m.id)) continue;
    if (m.importance >= 0.3) continue;
    if (ageMs(m, now) <= staleMs) continue;
    const next = Math.max(0.05, m.importance * 0.5);
    await store.update(m.id, { importance: next });
    m.importance = next;
    faded++;
  }

  // 3) Procedural proposals from recurring episodic entities (>= 3).
  const counts = new Map<string, { display: string; count: number }>();
  for (const m of pool) {
    if (m.type !== "episodic") continue;
    const seenInMemory = new Set<string>();
    for (const e of m.entities) {
      const key = e.trim().toLowerCase();
      if (!key || seenInMemory.has(key)) continue;
      seenInMemory.add(key);
      const hit = counts.get(key);
      if (hit) hit.count++;
      else counts.set(key, { display: e.trim(), count: 1 });
    }
  }
  const recurring = [...counts.entries()]
    .filter(([, v]) => v.count >= 3)
    .sort(
      (a, b) =>
        b[1].count - a[1].count || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    )
    .slice(0, 3);

  const procedural: MemoryCandidate[] = [];
  for (const [, v] of recurring) {
    const candidate: MemoryCandidate = {
      content: `Recurring work on ${v.display} — consider documenting the workflow`,
      type: "procedural",
      importance: 0.4,
      confidence: 0.4,
      reason: "reflection:recurrence",
      entities: [v.display],
    };
    await store.save({
      content: candidate.content,
      type: candidate.type,
      importance: candidate.importance,
      confidence: candidate.confidence,
      entities: candidate.entities,
    });
    procedural.push(candidate);
  }

  return { reviewed, consolidated, faded, procedural };
}
