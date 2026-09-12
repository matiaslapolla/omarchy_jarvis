import { randomUUID } from "node:crypto";
import type { NewTask, Task, TaskStatus } from "./types.js";

export interface TaskStore {
  create(t: NewTask): Promise<Task>;
  get(id: string): Promise<Task | undefined>;
  update(id: string, patch: Partial<Pick<Task, "status" | "result" | "error">>): Promise<Task | undefined>;
  list(opts?: { status?: TaskStatus; limit?: number }): Promise<Task[]>;
}

export class MemoryTaskStore implements TaskStore {
  private tasks = new Map<string, Task>();

  async create(t: NewTask): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      kind: t.kind,
      prompt: t.prompt,
      workspace: t.workspace ?? ".",
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  async get(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  async update(
    id: string,
    patch: Partial<Pick<Task, "status" | "result" | "error">>,
  ): Promise<Task | undefined> {
    const current = this.tasks.get(id);
    if (current === undefined) return undefined;
    const next: Task = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
    this.tasks.set(id, next);
    return next;
  }

  async list(opts?: { status?: TaskStatus; limit?: number }): Promise<Task[]> {
    const rows = [...this.tasks.values()];
    const filtered = opts?.status === undefined ? rows : rows.filter((t) => t.status === opts.status);
    filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return filtered.slice(0, opts?.limit ?? 100);
  }
}

const PG_SPEC: string = "pg";

async function dynImport(spec: string): Promise<any> {
  const src: string = `return import(${JSON.stringify(spec)})`;
  return Function(src)() as Promise<any>;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function rowToTask(row: any): Task {
  return {
    id: String(row.id),
    kind: row.kind,
    prompt: row.prompt,
    workspace: row.workspace,
    status: row.status,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export class PgTaskStore implements TaskStore {
  private pool: any = undefined;
  private loading: Promise<any> | undefined = undefined;

  constructor(private connectionString: string = process.env.DATABASE_URL ?? "") {}

  private poolReady(): Promise<any> {
    if (this.pool !== undefined) return Promise.resolve(this.pool);
    if (this.loading === undefined) {
      this.loading = dynImport(PG_SPEC).then((mod: any) => {
        const Pool = mod.Pool ?? mod.default?.Pool ?? mod.default;
        this.pool = new Pool({ connectionString: this.connectionString });
        return this.pool;
      });
    }
    return this.loading;
  }

  async create(t: NewTask): Promise<Task> {
    const pool: any = await this.poolReady();
    const now = new Date().toISOString();
    const out: any = await pool.query(
      "INSERT INTO tasks(id, kind, prompt, workspace, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'queued', $5, $5) RETURNING *",
      [randomUUID(), t.kind, t.prompt, t.workspace ?? ".", now],
    );
    return rowToTask(out.rows[0]);
  }

  async get(id: string): Promise<Task | undefined> {
    const pool: any = await this.poolReady();
    const out: any = await pool.query("SELECT * FROM tasks WHERE id = $1", [id]);
    if (out.rows.length === 0) return undefined;
    return rowToTask(out.rows[0]);
  }

  async update(
    id: string,
    patch: Partial<Pick<Task, "status" | "result" | "error">>,
  ): Promise<Task | undefined> {
    const pool: any = await this.poolReady();
    const out: any = await pool.query(
      "UPDATE tasks SET status = COALESCE($2, status), result = COALESCE($3::jsonb, result), error = COALESCE($4, error), updated_at = NOW() WHERE id = $1 RETURNING *",
      [id, patch.status ?? null, patch.result === undefined ? null : JSON.stringify(patch.result), patch.error ?? null],
    );
    if (out.rows.length === 0) return undefined;
    return rowToTask(out.rows[0]);
  }

  async list(opts?: { status?: TaskStatus; limit?: number }): Promise<Task[]> {
    const pool: any = await this.poolReady();
    const limit = opts?.limit ?? 100;
    const out: any =
      opts?.status === undefined
        ? await pool.query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT $1", [limit])
        : await pool.query("SELECT * FROM tasks WHERE status = $1 ORDER BY created_at DESC LIMIT $2", [
            opts.status,
            limit,
          ]);
    return (out.rows as any[]).map(rowToTask);
  }
}

export function createTaskStore(): TaskStore {
  if (process.env.JARVIS_MEMORY === "pg" && process.env.DATABASE_URL) {
    return new PgTaskStore(process.env.DATABASE_URL);
  }
  return new MemoryTaskStore();
}
