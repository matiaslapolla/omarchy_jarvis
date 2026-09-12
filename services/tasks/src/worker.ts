import { createTaskStore } from "./store.js";
import { createQueue } from "./queue.js";
import { handleTask } from "./handler.js";

export async function startWorker(): Promise<void> {
  const store = createTaskStore();
  const queue = await createQueue(store, (t) => handleTask(store, t));
  console.log(JSON.stringify({ worker: "started", queue: queue.kind }));
  const shutdown = (): void => {
    queue.close().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1]?.endsWith("worker.js")) {
  startWorker().catch((err: unknown) => {
    console.error(JSON.stringify({ worker: "failed", error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
