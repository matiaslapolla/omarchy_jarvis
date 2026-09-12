import type { BaseEvent } from "@jarvis/protocol";
import { taskEvent } from "./types.js";
import type { AgentHarness, AgentTask, HarnessLimits } from "./types.js";

export class StubHarness implements AgentHarness {
  readonly id = "stub" as const;

  async *execute(task: AgentTask, _limits?: Partial<HarnessLimits>): AsyncIterable<BaseEvent> {
    const text = `stub result for: ${task.prompt.slice(0, 60)}`;
    yield taskEvent(task.traceId, "agent.started", { harness: "stub" });
    yield taskEvent(task.traceId, "agent.delta", { text, harness: "stub" });
    yield taskEvent(task.traceId, "agent.completed", { text, finishReason: "stop", harness: "stub" });
  }
}
