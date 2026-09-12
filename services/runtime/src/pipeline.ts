import type { BaseEvent, UserInput } from "@jarvis/protocol";
import { DEFAULT_LIMITS, detectIntent, selectRoute } from "@jarvis/core";
import type { LLMProvider } from "@jarvis/providers";

export interface PipelineDeps {
  provider: LLMProvider;
}

function event(traceId: string, type: BaseEvent["type"], payload: unknown): BaseEvent {
  return {
    id: globalThis.crypto.randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    traceId,
    payload,
  };
}

export async function* runInput(
  input: UserInput,
  deps: PipelineDeps,
): AsyncIterable<BaseEvent> {
  const traceId = input.id;
  const maxSteps = DEFAULT_LIMITS.maxSteps;
  let steps = 0;
  const guard = (): void => {
    steps += 1;
    if (steps > maxSteps) {
      throw Object.assign(new Error("max steps exceeded"), { code: "LIMIT_EXCEEDED" });
    }
  };

  const text = input.content;
  const { intent, confidence } = detectIntent(text);
  const route = selectRoute(intent);

  if (route === "deterministic") {
    guard();
    const action = /^volume|volumen|mute/i.test(text.trim()) ? "system.volume" : "system.open_app";
    yield event(traceId, "tool.completed", { tool: action, intent, confidence, ok: true });
    yield event(traceId, "agent.completed", { text: "Done.", finishReason: "stop", route });
    return;
  }

  guard();
  yield event(traceId, "agent.started", { model: deps.provider.id, route, intent, confidence });
  const req = { messages: [{ role: "user", content: text }] };
  if (deps.provider.generateStream != null) {
    let full = "";
    for await (const delta of deps.provider.generateStream(req)) {
      full += delta;
      yield event(traceId, "agent.delta", { delta });
    }
    yield event(traceId, "agent.completed", { text: full, finishReason: "stop", route });
  } else {
    const res = await deps.provider.generate(req);
    yield event(traceId, "agent.delta", { delta: res.text });
    yield event(traceId, "agent.completed", { text: res.text, finishReason: res.finishReason, route });
  }
}
