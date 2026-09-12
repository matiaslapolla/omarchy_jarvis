import { randomUUID } from "node:crypto";
import { ClaudeCodeHarness, LocalHarness, OpencodeHarness, StubHarness, runCodingTask } from "@jarvis/harness";
import type { AgentHarness, AgentTask } from "@jarvis/harness";
import { LocalProvider } from "@jarvis/providers";
import { writeReport } from "./artifacts.js";
import type { TaskStore } from "./store.js";
import type { Task } from "./types.js";
import { notify } from "./notify.js";

type HarnessName = "stub" | "opencode" | "claudecode" | "local";

function harnessName(): HarnessName {
  const h = process.env.JARVIS_HARNESS;
  return h === "stub" || h === "opencode" || h === "claudecode" || h === "local" ? h : "opencode";
}

function makeHarness(name: HarnessName): AgentHarness {
  if (name === "stub") return new StubHarness();
  if (name === "claudecode") return new ClaudeCodeHarness();
  if (name === "local") return new LocalHarness(new LocalProvider(process.env.LOCAL_MODEL_URL ?? "http://127.0.0.1:11421"));
  return new OpencodeHarness();
}

function textOf(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload !== null && typeof payload === "object") {
    const t = (payload as Record<string, unknown>).text;
    return typeof t === "string" ? t : "";
  }
  return "";
}

async function runResearch(
  harness: AgentHarness,
  task: AgentTask,
): Promise<{ summary: string; transcript: string; events: number }> {
  let events = 0;
  let completed = "";
  let transcript = "";
  for await (const e of harness.execute(task)) {
    events += 1;
    if (e.type === "agent.delta" || e.type === "agent.completed") {
      const t = textOf(e.payload);
      if (t !== "" && transcript.length < 20000) transcript += t.slice(0, 20000 - transcript.length);
      if (e.type === "agent.completed" && t !== "") completed = t;
    }
  }
  return { summary: (completed !== "" ? completed : transcript).slice(0, 500), transcript, events };
}

export async function handleTask(store: TaskStore, task: Task): Promise<void> {
  const name = harnessName();
  const harness = makeHarness(name);
  const agentTask: AgentTask = {
    id: randomUUID(),
    traceId: task.id,
    kind: task.kind === "automation" ? "background" : task.kind,
    prompt: task.prompt,
    workspace: task.workspace || process.env.JARVIS_WORKSPACE || process.cwd(),
    harness: name,
    timeoutMs: 300000,
  };
  let status: "completed" | "failed" = "completed";
  let summary = "";
  try {
    if (task.kind === "coding") {
      const c = await runCodingTask(harness, agentTask, {});
      summary = (c.summary + (c.diffStat !== "" ? `\n\ndiffstat:\n${c.diffStat}` : "")).slice(0, 500);
      const dir = writeReport(task.id, {
        notes: (c.diff !== "" ? c.diff : c.summary).slice(-4096),
        report: `# ${task.kind} ${task.id}\n\n${summary}\n\n## transcript\n${c.diff}\n`,
        sources: { kind: task.kind, prompt: task.prompt, events: 0 },
      }).dir;
      await store.update(task.id, { status: "completed", result: { summary, artifactDir: dir, events: 0 } });
    } else {
      const r = await runResearch(harness, agentTask);
      summary = r.summary;
      const dir = writeReport(task.id, {
        notes: r.transcript.slice(-4096),
        report: `# ${task.kind} ${task.id}\n\n${summary}\n\n## transcript\n${r.transcript}\n`,
        sources: { kind: task.kind, prompt: task.prompt, events: r.events },
      }).dir;
      await store.update(task.id, { status: "completed", result: { summary, artifactDir: dir, events: r.events } });
    }
  } catch (err) {
    status = "failed";
    summary = String(err).slice(0, 500);
    try {
      await store.update(task.id, { status: "failed", error: summary });
    } catch {}
  }
  try {
    await notify(`Jarvis: ${task.kind} ${status}`, summary.slice(0, 200));
  } catch {}
}
