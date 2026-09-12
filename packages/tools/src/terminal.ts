import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { PermissionLevel } from "@jarvis/permissions";
import type { Registry } from "./index.js";

const DENY = [
  /\bsudo\b/i,
  /rm\s+-rf?\s+\/( |$)/i,
  /mkfs/i,
  /dd\s+of=/i,
  /:\(\)\s*\{/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /chmod\s+-R\s+\//i,
  /chown\s+-R\s+\//i,
  />\s*\/dev\/sd/i,
  /\bcurl\b/i,
];

export function registerTerminalTools(reg: Registry): void {
  reg.register({
    id: "terminal.run",
    description: "Run a shell command",
    schema: z.object({
      cmd: z.string().min(1).max(4000),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().max(120000).default(30000),
    }),
    permission: PermissionLevel.CONFIRM,
    execute: async ({ cmd, cwd, timeoutMs }, ctx) => {
      if (DENY.some((re) => re.test(cmd))) return { ok: false, code: "PERMISSION_ERROR", message: "blocked by denylist" };
      const dir = cwd ? (isAbsolute(cwd) ? cwd : resolve(ctx.workspace, cwd)) : ctx.workspace;
      try {
        const out = execFileSync("/bin/sh", ["-c", cmd], {
          cwd: dir,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
        });
        return { ok: true, data: { stdout: out.slice(0, 8000), exitCode: 0 } };
      } catch (err) {
        const e = err as { status?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown };
        if (typeof e?.status === "number")
          return {
            ok: false,
            code: "TOOL_ERROR",
            message: `exit ${e.status}: ${String(e.stderr ?? e.stdout ?? e.message ?? err).slice(0, 280)}`,
          };
        return { ok: false, code: "TOOL_ERROR", message: String(err).slice(0, 300) };
      }
    },
  });
}
