import { randomUUID } from "node:crypto";
import type { BaseEvent } from "@jarvis/protocol";
import { Registry, executeTool } from "@jarvis/tools";
import { registerSystemTools } from "@jarvis/tools/system.js";
import { registerFileTools } from "@jarvis/tools/files.js";
import { registerTerminalTools } from "@jarvis/tools/terminal.js";
import { registerBrowserTools } from "@jarvis/tools/browser.js";
import { createBackend } from "@jarvis/browser";
import { loadToolContext } from "@jarvis/permissions";

export function createDefaultRegistry(): Registry {
  const reg = new Registry();
  registerSystemTools(reg);
  registerFileTools(reg);
  registerTerminalTools(reg);
  registerBrowserTools(reg, createBackend(process.env.JARVIS_BROWSER));
  return reg;
}

export type ToolCallEvent = BaseEvent;

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

export async function* runToolCall(
  reg: Registry,
  id: string,
  raw: unknown,
  traceId: string,
): AsyncIterable<BaseEvent> {
  const ev = (type: BaseEvent["type"], payload: unknown): BaseEvent => ({
    id: randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    traceId,
    payload,
  });
  try {
    const ctx = await loadToolContext(traceId);
    yield ev("tool.started", { tool: id });
    const o = (await executeTool(reg, id, raw, ctx)) as unknown as Record<string, unknown>;
    if (o["status"] === "done" && o["ok"] === true) {
      yield ev("tool.completed", { tool: id, result: o["result"] ?? null });
      return;
    }
    if (o["status"] === "approval-required" || o["approvalRequired"] === true) {
      yield ev("tool.failed", { tool: id, code: "APPROVAL_REQUIRED", message: str(o["message"], "approval required") });
      return;
    }
    if (o["status"] === "denied" || o["denied"] === true) {
      yield ev("tool.failed", { tool: id, code: "PERMISSION_DENIED", message: str(o["message"], "permission denied") });
      return;
    }
    yield ev("tool.failed", { tool: id, code: str(o["code"], "EXEC_FAILED"), message: str(o["message"], "tool execution failed") });
  } catch (err) {
    yield ev("tool.failed", { tool: id, code: "SYSTEM_ERROR", message: err instanceof Error ? err.message : "system error" });
  }
}
