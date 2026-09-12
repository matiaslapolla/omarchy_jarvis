import type { TaskStore } from "./store.js";
import type { Task } from "./types.js";

export type JobHandler = (task: Task) => Promise<void>;

export interface TaskQueue {
  kind: "bullmq" | "local";
  enqueue(id: string): Promise<void>;
  close(): Promise<void>;
}

export function redisUrl(): string {
  return process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
}

const BULLMQ_SPEC: string = "bullmq";
const IOREDIS_SPEC: string = "ioredis";

async function dynImport(spec: string): Promise<any> {
  const src: string = `return import(${JSON.stringify(spec)})`;
  return Function(src)() as Promise<any>;
}

async function runTask(store: TaskStore, handler: JobHandler, id: string): Promise<void> {
  const task = await store.get(id);
  if (task === undefined) return;
  if (task.status === "cancelled" || task.status === "completed") return;
  await store.update(id, { status: "running" });
  const current = await store.get(id);
  if (current === undefined) return;
  try {
    await handler(current);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.update(id, { status: "failed", error: message.slice(0, 500) });
  }
}

async function createBullmqQueue(store: TaskStore, handler: JobHandler): Promise<TaskQueue> {
  const bullmq: any = await dynImport(BULLMQ_SPEC);
  const ioredis: any = await dynImport(IOREDIS_SPEC);
  const RedisCtor = ioredis.default ?? ioredis.Redis ?? ioredis;
  const mkClient = (): any => new RedisCtor(redisUrl(), { connectTimeout: 3000, maxRetriesPerRequest: null });
  const probe: any = mkClient();
  probe.on("error", () => undefined);
  try {
    await Promise.race([
      probe.ping(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("redis ping timeout")), 3000)),
    ]);
  } catch (err) {
    probe.disconnect();
    throw err;
  }
  probe.disconnect();
  const queueConn: any = mkClient();
  const workerConn: any = mkClient();
  const queue = new bullmq.Queue("jarvis-tasks", { connection: queueConn });
  const worker = new bullmq.Worker(
    "jarvis-tasks",
    async (job: any) => {
      await runTask(store, handler, String(job?.data?.taskId ?? ""));
    },
    { connection: workerConn },
  );
  return {
    kind: "bullmq",
    enqueue(id: string): Promise<void> {
      return queue.add("run", { taskId: id }).then(() => undefined);
    },
    async close(): Promise<void> {
      await worker.close();
      await queue.close();
      workerConn.disconnect();
      queueConn.disconnect();
    },
  };
}

function createLocalQueue(store: TaskStore, handler: JobHandler): TaskQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    kind: "local",
    enqueue(id: string): Promise<void> {
      tail = tail.then(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(() => {
              runTask(store, handler, id).then(resolve, resolve);
            });
          }),
      );
      return tail;
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

export async function createQueue(store: TaskStore, handler: JobHandler): Promise<TaskQueue> {
  try {
    return await createBullmqQueue(store, handler);
  } catch (err) {
    console.warn(JSON.stringify({ queue: "local", reason: err instanceof Error ? err.message : String(err) }));
    return createLocalQueue(store, handler);
  }
}
