import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { BaseEvent } from "@jarvis/protocol";
import { AgentTaskSchema, DEFAULT_HARNESS_LIMITS, taskEvent } from "./types.js";
import type { AgentHarness, AgentTask, HarnessLimits } from "./types.js";

export interface CLISpec {
  bin: string;
  args(task: AgentTask): string[];
  parseLine(line: string): { delta?: string; done?: boolean; error?: string } | null;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnFailed: boolean;
}

function envBinName(bin: string): string {
  return `${bin.split("/").pop() ?? bin}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_BIN";
}

export abstract class CLIHarness implements AgentHarness {
  abstract readonly id: AgentHarness["id"];
  protected abstract readonly spec: CLISpec;
  private readonly binOverride?: string;
  private readonly envExtra: Record<string, string>;

  constructor(bin?: string, envExtra?: Record<string, string>) {
    this.binOverride = bin;
    this.envExtra = envExtra ?? {};
  }

  async *execute(task: AgentTask, limits?: Partial<HarnessLimits>): AsyncIterable<BaseEvent> {
    const lim = { ...DEFAULT_HARNESS_LIMITS, ...limits };
    const traceId = (task as AgentTask | undefined)?.traceId ?? "unknown";
    const tool = `harness.${this.id}`;
    const fail = (code: string, extra: unknown): BaseEvent =>
      taskEvent(traceId, "tool.failed", { tool, code, ...(extra as Record<string, unknown>) });
    const completed = (text: string, finishReason: string): BaseEvent =>
      taskEvent(traceId, "agent.completed", { text, finishReason, harness: this.id });
    try {
      const checked = AgentTaskSchema.safeParse(task);
      if (!checked.success) {
        yield fail("VALIDATION_ERROR", { message: checked.error.message.slice(0, 500) });
        yield completed("", "error");
        return;
      }
      const valid = checked.data;
      const bin = this.binOverride ?? process.env[envBinName(this.spec.bin)] ?? this.spec.bin;
      if (spawnSync("which", [bin], { encoding: "utf8" }).status !== 0) {
        yield fail("HARNESS_UNAVAILABLE", { message: `binary not found: ${bin}` });
        yield completed("", "error");
        return;
      }
      yield taskEvent(traceId, "agent.started", { harness: this.id, bin });
      const attempts = lim.maxRetries >= 1 ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const r = await this.runOnce(valid, bin);
        if (r.spawnFailed) {
          yield fail("HARNESS_UNAVAILABLE", { message: `spawn failed: ${bin}` });
          yield completed("", "error");
          return;
        }
        if (r.timedOut) {
          yield fail("TIMEOUT", { message: `exceeded ${valid.timeoutMs}ms`, attempt });
          if (attempt + 1 < attempts) continue;
          yield completed("", "timeout");
          return;
        }
        let parseError: string | undefined;
        const deltas: string[] = [];
        for (const line of r.stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: { delta?: string; done?: boolean; error?: string } | null = null;
          try {
            parsed = this.spec.parseLine(trimmed);
          } catch (err) {
            parseError ??= String(err).slice(0, 500);
            continue;
          }
          if (!parsed) continue;
          if (parsed.delta) deltas.push(parsed.delta);
          if (parsed.error) parseError ??= parsed.error.slice(0, 500);
        }
        for (const d of deltas) yield taskEvent(traceId, "agent.delta", { text: d, harness: this.id });
        if (r.exitCode !== 0 || parseError !== undefined) {
          yield fail("HARNESS_FAILED", {
            exit: r.exitCode,
            message: parseError ?? `exit ${r.exitCode}`,
            stderr: r.stderr.slice(-2048),
          });
          yield completed("", "error");
          return;
        }
        yield completed(deltas.join(""), "stop");
        return;
      }
    } catch (err) {
      yield fail("SYSTEM_ERROR", { message: String(err).slice(0, 500) });
      yield completed("", "error");
    }
  }

  private runOnce(task: AgentTask, bin: string): Promise<RunResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (exitCode: number | null, spawnFailed: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve({ stdout, stderr, exitCode, timedOut, spawnFailed });
      };
      let child: ChildProcess;
      try {
        child = spawn(bin, this.spec.args(task), { cwd: task.workspace, env: { ...process.env, ...this.envExtra } });
      } catch {
        finish(null, true);
        return;
      }
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, task.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", () => finish(null, true));
      child.on("close", (code) => finish(code, false));
    });
  }
}
