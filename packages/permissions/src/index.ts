export enum PermissionLevel {
  SAFE = 0,
  LOW = 1,
  CONFIRM = 2,
  DANGEROUS = 3,
}

export type ToolContext = {
  traceId: string;
  workspace: string;
  allowDestructive: boolean;
};

export function loadToolContext(traceId: string): ToolContext {
  return {
    traceId,
    workspace: process.env.JARVIS_WORKSPACE ?? process.cwd(),
    allowDestructive: process.env.JARVIS_ALLOW_DESTRUCTIVE === "1",
  };
}

export type Decision = "allow" | "confirm" | "deny";

export function decide(level: PermissionLevel, ctx: ToolContext): Decision {
  if (level === PermissionLevel.SAFE) return "allow";
  if (level === PermissionLevel.LOW) return "allow";
  if (level === PermissionLevel.CONFIRM) return "confirm";
  return ctx.allowDestructive ? "confirm" : "deny";
}
