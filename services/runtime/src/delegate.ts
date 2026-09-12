import { randomUUID } from "node:crypto";
import type { BaseEvent } from "@jarvis/protocol";
import { harnessFor } from "@jarvis/core";
import type { Route } from "@jarvis/core";
import { LocalProvider } from "@jarvis/providers";
import { ClaudeCodeHarness, LocalHarness, OpencodeHarness, StubHarness } from "@jarvis/harness";
import type { AgentHarness, AgentTask } from "@jarvis/harness";

export function harnessForRoute(h: string): AgentHarness {
  if (process.env.JARVIS_HARNESS === "stub") return new StubHarness();
  switch (h) {
    case "local":
    case "deterministic":
      return new LocalHarness(new LocalProvider(process.env.LOCAL_MODEL_URL ?? "http://127.0.0.1:11421"));
    case "claudecode":
      return new ClaudeCodeHarness();
    default:
      return new OpencodeHarness();
  }
}

function event(traceId: string, type: BaseEvent["type"], payload: unknown): BaseEvent {
  return {
    id: randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    traceId,
    payload,
  };
}

export async function* runDelegated(
  kind: AgentTask["kind"],
  prompt: string,
  workspace: string,
  traceId: string,
  route: string,
): AsyncIterable<BaseEvent> {
  const task: AgentTask = {
    id: randomUUID(),
    traceId,
    kind,
    prompt,
    workspace: workspace || process.env.JARVIS_WORKSPACE || process.cwd(),
    harness: harnessFor(route as Route),
    timeoutMs: 120000,
  };
  yield event(traceId, "task.created", { task });
  const deadline = Date.now() + 120_000;
  try {
    for await (const e of harnessForRoute(route).execute(task)) {
      yield e;
      if (Date.now() > deadline) throw Object.assign(new Error("delegation timeout"), { code: "TIMEOUT" });
    }
    yield event(traceId, "task.completed", { taskId: task.id, status: "completed" });
  } catch (err) {
    yield event(traceId, "task.completed", { taskId: task.id, status: "failed", error: String(err) });
  }
}
