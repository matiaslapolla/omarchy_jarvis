import { statSync } from "node:fs";
import { resolve } from "node:path";
import { CLIHarness } from "./cli.js";
import type { CLISpec } from "./cli.js";
import type { AgentTask } from "./types.js";

export function opencodeModel(taskModel?: string): string {
  return taskModel ?? process.env.OPENCODE_MODEL ?? "opencode/muse-spark-1.3-contributor-free";
}

const DONE = /complete|done|finish|result/i;
const KEYS = ["event", "delta", "text", "content", "message"];

function pickText(value: unknown): string | undefined {
  if (typeof value === "string") return value ? value : undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = pickText(entry);
      if (text) return text;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of KEYS) {
      const text = pickText(record[key]);
      if (text) return text;
    }
  }
  return undefined;
}

function checkWorkspace(workspace: string): string {
  const dir = resolve(workspace);
  let ok = false;
  try {
    ok = statSync(dir).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) throw Object.assign(new Error(`invalid workspace: ${workspace}`), { code: "VALIDATION_ERROR" });
  return dir;
}

function isDone(value: unknown): boolean {
  if (value && typeof value === "object") {
    const type = (value as Record<string, unknown>).type;
    return typeof type === "string" && DONE.test(type);
  }
  return false;
}

function parseLine(line: string): { delta?: string; done?: boolean; error?: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const done = isDone(value);
  const delta = pickText(value);
  if (delta) return done ? { delta, done } : { delta };
  return done ? { delta: "", done } : null;
}

export class OpencodeHarness extends CLIHarness {
  readonly id = "opencode" as const;

  protected readonly spec: CLISpec = {
    bin: "opencode",
    args: (task: AgentTask) => [
      "run",
      "--format",
      "json",
      "-m",
      opencodeModel(task.model),
      "--dir",
      checkWorkspace(task.workspace),
      "--",
      task.prompt,
    ],
    parseLine,
  };

  constructor(bin?: string, envExtra?: Record<string, string>) {
    super(bin, envExtra);
  }
}
