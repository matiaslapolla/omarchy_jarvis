import type { BaseEvent } from "@jarvis/protocol";
import type { LLMProvider } from "@jarvis/providers";
import { DEFAULT_HARNESS_LIMITS, taskEvent } from "./types.js";
import type { AgentHarness, AgentTask, HarnessLimits } from "./types.js";

export class LocalHarness implements AgentHarness {
  readonly id = "local" as const;

  constructor(private readonly provider: LLMProvider) {}

  async *execute(task: AgentTask, limits?: Partial<HarnessLimits>): AsyncIterable<BaseEvent> {
    const lim = { ...DEFAULT_HARNESS_LIMITS, ...limits };
    yield taskEvent(task.traceId, "agent.started", { harness: "local", model: this.provider.id });
    try {
      if (lim.maxSteps < 1) {
        yield taskEvent(task.traceId, "tool.failed", {
          tool: "harness.local",
          code: "LIMIT_EXCEEDED",
          message: "maxSteps < 1",
        });
        yield taskEvent(task.traceId, "agent.completed", { text: "", finishReason: "error", harness: "local" });
        return;
      }
      const res = await this.provider.generate({
        messages: [{ role: "user", content: task.prompt }],
        model: task.model,
      });
      yield taskEvent(task.traceId, "agent.delta", { text: res.text, harness: "local" });
      yield taskEvent(task.traceId, "agent.completed", {
        text: res.text,
        finishReason: res.finishReason,
        harness: "local",
      });
    } catch (err) {
      const code = (err as { code?: unknown }).code === "PROVIDER_ERROR" ? "PROVIDER_ERROR" : "SYSTEM_ERROR";
      yield taskEvent(task.traceId, "tool.failed", {
        tool: "harness.local",
        code,
        message: String(err instanceof Error ? err.message : err).slice(0, 500),
      });
      yield taskEvent(task.traceId, "agent.completed", { text: "", finishReason: "error", harness: "local" });
    }
  }
}
