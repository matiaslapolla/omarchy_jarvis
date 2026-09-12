import { resolve } from "node:path";
import { CLIHarness } from "./cli.js";
import type { CLISpec } from "./cli.js";
import type { AgentTask } from "./types.js";

function blockText(blocks: unknown): string | undefined {
  if (typeof blocks === "string") return blocks ? blocks : undefined;
  if (Array.isArray(blocks)) {
    const parts: string[] = [];
    for (const block of blocks) {
      if (typeof block === "string") {
        if (block) parts.push(block);
      } else if (block && typeof block === "object") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string" && text) parts.push(text);
      }
    }
    return parts.length > 0 ? parts.join("") : undefined;
  }
  return undefined;
}

function messageText(message: unknown): string | undefined {
  if (typeof message === "string") return message ? message : undefined;
  if (message && typeof message === "object") return blockText((message as Record<string, unknown>).content);
  return undefined;
}

function parseLine(line: string): { delta?: string; done?: boolean; error?: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.type === "assistant") {
    const delta = messageText(record.message);
    return delta ? { delta } : null;
  }
  if (record.type === "result") {
    const text = typeof record.result === "string" ? record.result : (messageText(record.message) ?? "");
    if (record.is_error === true) {
      const detail = typeof record.error === "string" && record.error ? record.error : text;
      return { delta: text ? text : undefined, done: true, error: detail.slice(0, 500) || "claude error" };
    }
    return { delta: text ? text : undefined, done: true };
  }
  return null;
}

export class ClaudeCodeHarness extends CLIHarness {
  readonly id = "claudecode" as const;

  protected readonly spec: CLISpec = {
    bin: "claude",
    args: (task: AgentTask) => [
      "-p",
      task.prompt,
      "--output-format",
      "stream-json",
      "--add-dir",
      resolve(task.workspace),
      "--allowedTools",
      "Bash(git *) Edit Read Write Glob Grep",
    ],
    parseLine,
  };

  constructor(bin?: string, envExtra?: Record<string, string>) {
    super(bin, envExtra);
  }
}
