import { spawnSync } from "node:child_process";
import type { BaseEvent } from "@jarvis/protocol";
import type { AgentHarness, AgentTask } from "./types.js";
import { detectProject } from "./project.js";
import type { ProjectContext } from "./project.js";

export interface CodingResult {
  context: ProjectContext;
  diffStat: string;
  diff: string;
  test?: { command: string; exit: number; tail: string };
  summary: string;
}

const MAX_DIFF = 20000;

function gitDiff(params: string[], cwd: string, maxChars: number): string {
  try {
    const result = spawnSync("git", params, { cwd, encoding: "utf8" });
    if (result.status !== 0) return "";
    return typeof result.stdout === "string" ? result.stdout.slice(0, maxChars) : "";
  } catch {
    return "";
  }
}

function eventText(event: BaseEvent): { type: string; text: string } {
  const payload: unknown = event.payload;
  if (typeof payload === "string") return { type: event.type, text: payload };
  const text = payload && typeof payload === "object" ? (payload as Record<string, unknown>).text : undefined;
  return { type: event.type, text: typeof text === "string" ? text : "" };
}

function runTest(command: string, cwd: string): NonNullable<CodingResult["test"]> {
  const parts = command.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return { command, exit: 1, tail: "" };
  try {
    const result = spawnSync(parts[0], parts.slice(1), { cwd, encoding: "utf8", timeout: 120000 });
    const out = `${typeof result.stdout === "string" ? result.stdout : ""}${typeof result.stderr === "string" ? result.stderr : ""}`;
    return { command, exit: result.status ?? 1, tail: out.slice(-2048) };
  } catch (err) {
    return { command, exit: 1, tail: String(err instanceof Error ? err.message : err).slice(-2048) };
  }
}

export async function runCodingTask(
  harness: AgentHarness,
  task: AgentTask,
  opts?: { testCommand?: string; maxDiffChars?: number },
): Promise<CodingResult> {
  const maxDiffChars = opts?.maxDiffChars ?? MAX_DIFF;
  const context = detectProject(task.workspace);
  try {
    let toolCalls = 0;
    let completedText = "";
    let transcript = "";
    for await (const event of harness.execute(task)) {
      const { type, text } = eventText(event);
      if (type.startsWith("tool.")) toolCalls += 1;
      if (type === "agent.completed") {
        if (text) completedText = text;
      } else if (text && transcript.length < maxDiffChars) {
        transcript += text.slice(0, maxDiffChars - transcript.length);
      }
    }
    void toolCalls;
    const diffStat = gitDiff(["diff", "--stat"], context.root, 2048);
    const diff = gitDiff(["diff"], context.root, maxDiffChars);
    const result: CodingResult = { context, diffStat, diff, summary: (completedText || transcript).slice(0, 500) };
    if (opts?.testCommand && process.env.JARVIS_RUN_TESTS === "1") result.test = runTest(opts.testCommand, context.root);
    return result;
  } catch (err) {
    return {
      context,
      diffStat: "",
      diff: "",
      summary: `error: ${String(err instanceof Error ? err.message : err).slice(0, 500)}`,
    };
  }
}
