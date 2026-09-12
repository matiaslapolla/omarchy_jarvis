import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface ExecResult {
  exit: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface Executor {
  run(argv: string[] | string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
}

const OUT_CAP = 8192;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 300000;

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function clampTimeout(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(timeoutMs), 1), MAX_TIMEOUT_MS);
}

function toArgv(argv: string[] | string): string[] {
  const parts = Array.isArray(argv) ? argv : argv.split(/\s+/).filter((p) => p !== "");
  if (parts.length === 0) throw coded("VALIDATION_ERROR", "argv empty");
  return parts;
}

function cap(text: string): { value: string; cut: boolean } {
  return text.length > OUT_CAP ? { value: text.slice(0, OUT_CAP), cut: true } : { value: text, cut: false };
}

function errText(err: unknown): string {
  return String(err instanceof Error ? err.message : err).slice(0, 500);
}

function toRoot(root: string | { workspace: string }): string {
  const dir = typeof root === "string" ? root : root.workspace;
  if (!dir) throw coded("VALIDATION_ERROR", "workspace required");
  return resolve(dir);
}

function jail(root: string, cwd?: string): string {
  const dir = resolve(cwd ?? root);
  const rel = relative(root, dir);
  if (rel !== "" && (rel === ".." || rel.startsWith("../") || isAbsolute(rel)))
    throw coded("PERMISSION_ERROR", `cwd outside workspace: ${cwd ?? root}`);
  return dir;
}

function resultOf(out: { error?: Error; status: number | null; stdout: unknown; stderr: unknown }): ExecResult {
  if (out.error !== undefined) throw coded("TOOL_ERROR", errText(out.error));
  const stdout = cap(typeof out.stdout === "string" ? out.stdout : "");
  const stderr = cap(typeof out.stderr === "string" ? out.stderr : "");
  return { exit: out.status ?? 1, stdout: stdout.value, stderr: stderr.value, truncated: stdout.cut || stderr.cut };
}

export class LocalExecutor implements Executor {
  private readonly root: string;

  constructor(root: string | { workspace: string }) {
    this.root = toRoot(root);
  }

  async run(argv: string[] | string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
    const parts = toArgv(argv);
    const out = spawnSync(parts[0], parts.slice(1), {
      cwd: jail(this.root, opts?.cwd),
      timeout: clampTimeout(opts?.timeoutMs),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return resultOf(out);
  }
}

let dockerCache: boolean | undefined;

function dockerInfo(): boolean {
  try {
    const r = spawnSync("docker", ["info"], { timeout: 5000, stdio: "ignore" });
    return r.error === undefined && r.status === 0;
  } catch {
    return false;
  }
}

export function dockerAvailable(): boolean {
  if (dockerCache === undefined) {
    let found = false;
    try {
      const w = spawnSync("which", ["docker"], { timeout: 5000, stdio: "ignore" });
      found = w.error === undefined && w.status === 0;
    } catch {
      found = false;
    }
    dockerCache = found && dockerInfo();
  }
  return dockerCache;
}

export class DockerExecutor implements Executor {
  private readonly workspace: string;
  private readonly image: string;
  private readonly net: string;

  constructor(
    workspace?: string,
    image: string = process.env.JARVIS_SANDBOX_IMAGE ?? "debian:stable-slim",
    net: string = process.env.JARVIS_SANDBOX_NET ?? "none",
  ) {
    this.workspace = workspace ?? "";
    this.image = image;
    this.net = net;
  }

  async run(argv: string[] | string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
    const parts = toArgv(argv);
    const raw = opts?.cwd ?? this.workspace;
    if (!raw) throw coded("VALIDATION_ERROR", "workspace required");
    if (!dockerAvailable()) throw coded("SANDBOX_UNAVAILABLE", "docker unavailable");
    const tmpout = mkdtempSync(join(tmpdir(), "jarvis-out-"));
    try {
      const out = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--read-only",
          "--network",
          this.net,
          "--memory",
          "512m",
          "--cpus",
          "1.0",
          "--pids-limit",
          "128",
          "-v",
          `${resolve(raw)}:/work:ro`,
          "-v",
          `${tmpout}:/out`,
          "--workdir",
          "/work",
          this.image,
          ...parts,
        ],
        { timeout: clampTimeout(opts?.timeoutMs), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      );
      return resultOf(out);
    } finally {
      try {
        rmSync(tmpout, { recursive: true, force: true });
      } catch {
        /* ignore cleanup failure */
      }
    }
  }
}

export function createExecutor(workspace: string): Executor {
  if (process.env.JARVIS_SANDBOX !== "off" && dockerAvailable()) return new DockerExecutor(workspace);
  return new LocalExecutor(workspace);
}
