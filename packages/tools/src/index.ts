import { z } from "zod";
import { PermissionLevel, decide, type ToolContext } from "@jarvis/permissions";

export type ToolResult = { ok: true; data: unknown } | { ok: false; code: string; message: string };

export interface Tool<TInput = unknown> {
  id: string;
  description: string;
  schema: z.ZodType<TInput>;
  permission: PermissionLevel;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}

export class Registry {
  private tools = new Map<string, Tool<any>>();
  register(t: Tool<any>): void {
    this.tools.set(t.id, t);
  }
  get(id: string): Tool<unknown> | undefined {
    return this.tools.get(id);
  }
  list(): Tool<unknown>[] {
    return [...this.tools.values()];
  }
}

export type ExecOutcome =
  | { status: "done"; result: ToolResult }
  | { status: "approval-required"; tool: string; level: PermissionLevel }
  | { status: "denied"; tool: string; level: PermissionLevel }
  | { status: "invalid"; tool: string; issues: unknown }
  | { status: "unknown-tool"; tool: string };

export async function executeTool(reg: Registry, id: string, raw: unknown, ctx: ToolContext): Promise<ExecOutcome> {
  const t = reg.get(id);
  if (!t) return { status: "unknown-tool", tool: id };
  const parsed = t.schema.safeParse(raw);
  if (!parsed.success) return { status: "invalid", tool: id, issues: parsed.error.issues };
  const d = decide(t.permission, ctx);
  if (d === "deny") return { status: "denied", tool: id, level: t.permission };
  if (d === "confirm") return { status: "approval-required", tool: id, level: t.permission };
  try {
    return { status: "done", result: await t.execute(parsed.data, ctx) };
  } catch (err) {
    return { status: "done", result: { ok: false, code: "TOOL_ERROR", message: String(err).slice(0, 300) } };
  }
}

export { registerSystemTools } from "./system.js";
export { registerFileTools } from "./files.js";
export { registerTerminalTools } from "./terminal.js";
