import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { RETRIEVAL_WEIGHTS, type Memory, type MemoryType, type NewMemory, type ScoredMemory } from "./types.js";
export interface MemoryStore {
  save(m: NewMemory): Promise<Memory>;
  get(id: string): Promise<Memory | undefined>;
  update(id: string, patch: Partial<Pick<Memory, "importance" | "confidence" | "content" | "entities" | "lastAccessedAt">>): Promise<Memory | undefined>;
  touch(id: string): Promise<void>;
  list(opts?: { type?: MemoryType; limit?: number; since?: string }): Promise<Memory[]>;
  search(opts: { embedding?: number[]; queryTokens?: string[]; queryEntities?: string[]; limit?: number }): Promise<ScoredMemory[]>;
  close?(): Promise<void>;
}
export function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
}
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function keywordOverlap(queryTokens: string[] | undefined, contentTokens: string[]): number {
  if (!queryTokens || queryTokens.length === 0) return 0;
  const set = new Set(contentTokens);
  let hit = 0;
  for (const t of queryTokens) if (set.has(t.toLowerCase())) hit++;
  return hit / queryTokens.length;
}
function recencyScore(lastAccessedAt: string, now: number): number {
  const ageDays = Math.max(0, (now - Date.parse(lastAccessedAt)) / 86400000);
  return 1 / (1 + ageDays / 7);
}
function entityScore(memoryEntities: string[], queryEntities: string[] | undefined): number {
  if (!queryEntities || queryEntities.length === 0) return 0;
  const set = new Set(memoryEntities.map((e) => e.toLowerCase()));
  let hit = 0;
  for (const e of queryEntities) if (set.has(e.toLowerCase())) hit++;
  return hit / queryEntities.length;
}
function scoreMemory(m: Memory, semantic: number, queryEntities: string[] | undefined, now: number): ScoredMemory {
  const parts = { semantic, recency: recencyScore(m.lastAccessedAt, now), importance: m.importance, entity: entityScore(m.entities, queryEntities) };
  const w = RETRIEVAL_WEIGHTS;
  const score = w.semantic * parts.semantic + w.recency * parts.recency + w.importance * parts.importance + w.entity * parts.entity;
  return { memory: m, score, parts };
}
export class MemoryStoreImpl implements MemoryStore {
  private items = new Map<string, Memory>();
  async save(m: NewMemory): Promise<Memory> {
    const now = new Date().toISOString();
    const mem: Memory = { ...m, entities: m.entities ?? [], id: randomUUID(), createdAt: now, lastAccessedAt: now };
    this.items.set(mem.id, mem);
    return mem;
  }
  async get(id: string): Promise<Memory | undefined> {
    return this.items.get(id);
  }
  async touch(id: string): Promise<void> {
    const m = this.items.get(id);
    if (m) this.items.set(id, { ...m, lastAccessedAt: new Date().toISOString() });
  }
  async update(id: string, patch: Partial<Pick<Memory, "importance" | "confidence" | "content" | "entities" | "lastAccessedAt">>): Promise<Memory | undefined> {
    const m = this.items.get(id);
    if (!m) return undefined;
    const next = { ...m, ...patch };
    this.items.set(id, next);
    return next;
  }
  async list(opts?: { type?: MemoryType; limit?: number; since?: string }): Promise<Memory[]> {
    const limit = opts?.limit ?? 100;
    return [...this.items.values()]
      .filter((m) => (!opts?.type || m.type === opts.type) && (!opts?.since || m.createdAt >= opts.since))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }
  async search(opts: { embedding?: number[]; queryTokens?: string[]; queryEntities?: string[]; limit?: number }): Promise<ScoredMemory[]> {
    const now = Date.now();
    const out: ScoredMemory[] = [];
    for (const m of this.items.values()) {
      const semantic = opts.embedding && m.embedding ? cosine(opts.embedding, m.embedding) : keywordOverlap(opts.queryTokens, tokenize(m.content));
      out.push(scoreMemory(m, semantic, opts.queryEntities, now));
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, opts.limit ?? 5);
  }
  async close(): Promise<void> {}
}
type MemoryRow = { id: string; type: string; content: string; importance: string | number; confidence: string | number; embedding: string | number[] | null; entities: string[] | null; created_at: string | Date; last_accessed_at: string | Date; distance?: number };
function rowToMemory(r: MemoryRow): Memory {
  let embedding: number[] | undefined;
  if (Array.isArray(r.embedding)) embedding = r.embedding.map(Number);
  else if (typeof r.embedding === "string") embedding = r.embedding.replace(/^\[|\]$/g, "").split(",").filter((s) => s.trim() !== "").map(Number);
  return {
    id: r.id,
    type: r.type as Memory["type"],
    content: r.content,
    importance: Number(r.importance),
    confidence: Number(r.confidence),
    ...(embedding ? { embedding } : {}),
    entities: r.entities ?? [],
    createdAt: new Date(r.created_at).toISOString(),
    lastAccessedAt: new Date(r.last_accessed_at).toISOString()
  };
}
function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
export class PgStore implements MemoryStore {
  private pool: Pool | undefined;
  private pending: Promise<Pool> | undefined;
  constructor(private connectionString: string = process.env.DATABASE_URL ?? "") {}
  private ensure(): Promise<Pool> {
    if (this.pool) return Promise.resolve(this.pool);
    if (!this.pending) {
      this.pending = import("pg").then((mod) => {
        const PoolCtor = (mod as unknown as { default?: { Pool: new (opts: unknown) => Pool }; Pool?: new (opts: unknown) => Pool }).default?.Pool ?? (mod as unknown as { Pool: new (opts: unknown) => Pool }).Pool;
        this.pool = new PoolCtor({ connectionString: this.connectionString });
        return this.pool;
      });
    }
    return this.pending;
  }
  async save(m: NewMemory): Promise<Memory> {
    const pool = await this.ensure();
    const id = randomUUID();
    const now = new Date().toISOString();
    const { rows } = await pool.query<MemoryRow>(
      "INSERT INTO memories(id,type,content,importance,confidence,embedding,entities,created_at,last_accessed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [id, m.type, m.content, m.importance, m.confidence, m.embedding ? toVectorLiteral(m.embedding) : null, m.entities ?? [], now, now]
    );
    return rowToMemory(rows[0]);
  }
  async get(id: string): Promise<Memory | undefined> {
    const pool = await this.ensure();
    const { rows } = await pool.query<MemoryRow>("SELECT * FROM memories WHERE id=$1", [id]);
    return rows[0] ? rowToMemory(rows[0]) : undefined;
  }
  async touch(id: string): Promise<void> {
    const pool = await this.ensure();
    await pool.query("UPDATE memories SET last_accessed_at=now() WHERE id=$1", [id]);
  }
  async update(id: string, patch: Partial<Pick<Memory, "importance" | "confidence" | "content" | "entities" | "lastAccessedAt">>): Promise<Memory | undefined> {
    const pool = await this.ensure();
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.importance !== undefined) {
      vals.push(patch.importance);
      sets.push(`importance=$${vals.length}`);
    }
    if (patch.confidence !== undefined) {
      vals.push(patch.confidence);
      sets.push(`confidence=$${vals.length}`);
    }
    if (patch.content !== undefined) {
      vals.push(patch.content);
      sets.push(`content=$${vals.length}`);
    }
    if (patch.entities !== undefined) {
      vals.push(patch.entities);
      sets.push(`entities=$${vals.length}`);
    }
    if (patch.lastAccessedAt !== undefined) {
      vals.push(patch.lastAccessedAt);
      sets.push(`last_accessed_at=$${vals.length}`);
    }
    if (sets.length === 0) return this.get(id);
    vals.push(id);
    const { rows } = await pool.query<MemoryRow>(`UPDATE memories SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`, vals);
    return rows[0] ? rowToMemory(rows[0]) : undefined;
  }
  async list(opts?: { type?: MemoryType; limit?: number; since?: string }): Promise<Memory[]> {
    const pool = await this.ensure();
    const conds: string[] = [];
    const vals: unknown[] = [];
    if (opts?.type) {
      vals.push(opts.type);
      conds.push(`type=$${vals.length}`);
    }
    if (opts?.since) {
      vals.push(opts.since);
      conds.push(`created_at>=$${vals.length}`);
    }
    vals.push(opts?.limit ?? 100);
    const { rows } = await pool.query<MemoryRow>(`SELECT * FROM memories${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${vals.length}`, vals);
    return rows.map(rowToMemory);
  }
  async search(opts: { embedding?: number[]; queryTokens?: string[]; queryEntities?: string[]; limit?: number }): Promise<ScoredMemory[]> {
    const pool = await this.ensure();
    const limit = opts.limit ?? 5;
    const now = Date.now();
    if (opts.embedding) {
      const { rows } = await pool.query<MemoryRow>("SELECT *, embedding <=> $1 AS distance FROM memories ORDER BY embedding <=> $1 LIMIT $2", [toVectorLiteral(opts.embedding), limit * 4]);
      return rows
        .map((r) => scoreMemory(rowToMemory(r), 1 / (1 + Number(r.distance ?? 0)), opts.queryEntities, now))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }
    const tokens = (opts.queryTokens ?? []).filter(Boolean);
    let rows: MemoryRow[];
    if (tokens.length > 0) {
      const conds = tokens.map((_, i) => `content ILIKE $${i + 1}`);
      const { rows: r } = await pool.query<MemoryRow>(`SELECT * FROM memories WHERE ${conds.join(" OR ")} LIMIT $${tokens.length + 1}`, [...tokens.map((t) => `%${t}%`), limit * 4]);
      rows = r;
    } else {
      const { rows: r } = await pool.query<MemoryRow>("SELECT * FROM memories ORDER BY last_accessed_at DESC LIMIT $1", [limit * 4]);
      rows = r;
    }
    return rows
      .map((r) => {
        const m = rowToMemory(r);
        return scoreMemory(m, keywordOverlap(opts.queryTokens, tokenize(m.content)), opts.queryEntities, now);
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
    this.pending = undefined;
  }
}
export function createStore(): MemoryStore {
  if (process.env.JARVIS_MEMORY === "pg" && process.env.DATABASE_URL) return new PgStore();
  return new MemoryStoreImpl();
}
