import type { BaseEvent, Intent, UserInput } from "@jarvis/protocol";
import { BASE_SYSTEM_PROMPT, DEFAULT_LIMITS, detectIntent, selectRoute } from "@jarvis/core";
import type { LLMProvider } from "@jarvis/providers";
import type { Registry } from "@jarvis/tools";
import { createDefaultRegistry, runToolCall } from "./tools.js";
import { runDelegated } from "./delegate.js";
import { contextFor } from "./context.js";
import { memorySystemBlock, recallFor, rememberTurn } from "./memory.js";

export interface PipelineDeps {
  provider: LLMProvider;
}

let sharedRegistry: Registry | undefined;

function defaultRegistry(): Registry {
  sharedRegistry ??= createDefaultRegistry();
  return sharedRegistry;
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

function kindFrom(intent: Intent): "research" | "coding" | "background" {
  switch (intent) {
    case "research":
      return "research";
    case "coding":
      return "coding";
    default:
      return "background";
  }
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
    const reg = defaultRegistry();
    const t = text.trim();
    const dispatch = async function* (id: string, raw: unknown): AsyncIterable<BaseEvent> {
      for await (const e of runToolCall(reg, id, raw, traceId)) {
        guard();
        yield e;
      }
    };
    const match = async function* (): AsyncIterable<BaseEvent> {
      let m: RegExpMatchArray | null;
      if ((m = t.match(/^(open|abre)\s+(.+)/i)) != null) {
        yield* dispatch("system.open_app", { app: m[2] });
      } else if (/volume|volumen/i.test(t)) {
        const n = t.match(/\d+/);
        yield* dispatch("system.volume", n != null ? { level: Number(n[0]) } : {});
      } else if (/screenshot|pantalla/i.test(t)) {
        yield* dispatch("system.screenshot", {});
      } else if ((m = t.match(/^(?:notify|notific[a-z]*)\s+(.+)/i)) != null) {
        yield* dispatch("system.notification", { title: m[1] });
      } else if ((m = t.match(/^(read|lee)\s+(\S+)/i)) != null) {
        yield* dispatch("files.read", { path: m[2] });
      } else if ((m = t.match(/^(list|lista)(?:\s+(\S+))?/i)) != null) {
        yield* dispatch("files.list", { dir: m[2] ?? "." });
      } else if ((m = t.match(/^(?:search|busca)\s+(\S+)/i)) != null) {
        yield* dispatch("files.search", { pattern: m[1] });
      } else if ((m = t.match(/^(write|escribe)\s+(\S+)\s+([\s\S]+)/i)) != null) {
        yield* dispatch("files.write", { path: m[2], content: m[3] });
      } else if ((m = t.match(/^run\s+([\s\S]+)/i)) != null) {
        yield* dispatch("terminal.run", { cmd: m[1] });
      } else if ((m = t.match(/^browse\s+(https?\S+)/i)) != null) {
        yield* dispatch("browser.navigate", { url: m[1] });
      } else {
        yield event(traceId, "tool.failed", { tool: "router", code: "NO_MATCH", message: t });
      }
    };
    yield* match();
    yield event(traceId, "agent.completed", { text: "Done.", finishReason: "stop", route });
    for (const e of await rememberTurn(text, "Done.", traceId)) yield e;
    return;
  }

  if (route === "opencode" || route === "claudecode" || route === "background") {
    const workspace = input.metadata?.currentDirectory ?? process.env.JARVIS_WORKSPACE ?? process.cwd();
    yield* runDelegated(kindFrom(intent), text, workspace, traceId, route);
    yield event(traceId, "agent.completed", { text: "Done.", finishReason: "stop", route });
    return;
  }

  guard();
  yield event(traceId, "agent.started", { model: deps.provider.id, route, intent, confidence });
  const mems = await recallFor(text, 5);
  // ADR-0001 Phase 7: advanced context (system/project/vision) on the local
  // route only. The pipeline-level recall above stays the single recallFor
  // call site here; contextFor() reuses the same cached store for memory.
  const workspace = input.metadata?.currentDirectory ?? process.env.JARVIS_WORKSPACE ?? process.cwd();
  const adv = await contextFor({ content: text, intent, workspace });
  const req = {
    messages: [{ role: "user", content: text }],
    system: BASE_SYSTEM_PROMPT + memorySystemBlock(mems) + (adv.block ? `\n${adv.block}` : ""),
  };
  if (deps.provider.generateStream != null) {
    let full = "";
    for await (const delta of deps.provider.generateStream(req)) {
      full += delta;
      yield event(traceId, "agent.delta", { delta });
    }
    yield event(traceId, "agent.completed", { text: full, finishReason: "stop", route });
    for (const e of await rememberTurn(text, full, traceId)) yield e;
  } else {
    const res = await deps.provider.generate(req);
    yield event(traceId, "agent.delta", { delta: res.text });
    yield event(traceId, "agent.completed", { text: res.text, finishReason: res.finishReason, route });
    for (const e of await rememberTurn(text, res.text, traceId)) yield e;
  }
}
