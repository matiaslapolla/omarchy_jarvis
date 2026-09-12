import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { PermissionLevel } from "@jarvis/permissions";
import type { Registry, ToolResult } from "./index.js";

function run(cmd: string, args: string[]): boolean {
  try {
    const r = spawnSync(cmd, args, { timeout: 10000, stdio: "ignore" });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

function fail(message: string): ToolResult {
  return { ok: false, code: "TOOL_ERROR", message };
}

export function registerSystemTools(reg: Registry): void {
  reg.register({
    id: "system.open_app",
    description: "Open an application",
    schema: z.object({ app: z.string().min(1) }),
    permission: PermissionLevel.LOW,
    execute: async ({ app }) => {
      try {
        const target: [string, string[]] =
          process.platform === "darwin"
            ? ["open", ["-a", app]]
            : process.platform === "win32"
              ? ["cmd", ["/c", "start", "", app]]
              : ["xdg-open", [app]];
        const child = spawn(target[0], target[1], { detached: true, stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
        return { ok: true, data: { app, launched: true } };
      } catch (err) {
        return fail(String(err).slice(0, 300));
      }
    },
  });

  reg.register({
    id: "system.volume",
    description: "Set or adjust system volume",
    schema: z
      .object({
        level: z.number().int().min(0).max(100).optional(),
        delta: z.number().int().optional(),
      })
      .refine((v) => v.level !== undefined || v.delta !== undefined, { message: "level or delta required" }),
    permission: PermissionLevel.LOW,
    execute: async ({ level, delta }) => {
      const amt = (kind: "direct" | "pulse" | "alsa"): string => {
        if (level !== undefined) return `${level}%`;
        const d = delta as number;
        const n = Math.abs(d);
        if (kind === "pulse") return `${d > 0 ? "+" : "-"}${n}%`;
        return `${n}%${d > 0 ? "+" : "-"}`;
      };
      const backends: [string, (kind: "direct" | "pulse" | "alsa") => string[]][] = [
        ["wpctl", (k) => ["set-volume", "@DEFAULT_AUDIO_SINK@", amt(k)]],
        ["pactl", (k) => ["set-sink-volume", "@DEFAULT_SINK@", amt(k)]],
        ["amixer", (k) => ["-D", "pulse", "sset", "Master", amt(k)]],
      ];
      const kinds: ("direct" | "pulse" | "alsa")[] = ["direct", "pulse", "alsa"];
      for (let i = 0; i < backends.length; i++) {
        const [cmd, args] = backends[i] as [string, (k: "direct" | "pulse" | "alsa") => string[]];
        if (run(cmd, args(kinds[i] as "direct" | "pulse" | "alsa")))
          return { ok: true, data: { ...(level !== undefined ? { level } : { delta }), backend: cmd } };
      }
      return fail("no audio backend available");
    },
  });

  reg.register({
    id: "system.notification",
    description: "Show a desktop notification",
    schema: z.object({ title: z.string(), body: z.string().optional() }),
    permission: PermissionLevel.LOW,
    execute: async ({ title, body }) => {
      if (run("notify-send", body !== undefined ? [title, body] : [title])) return { ok: true, data: { delivered: true } };
      try {
        process.stdout.write(`${title}${body ? `: ${body}` : ""}\n`);
      } catch {}
      return { ok: true, data: { delivered: false, fallback: "stdout" } };
    },
  });

  reg.register({
    id: "system.screenshot",
    description: "Capture a screen screenshot to a file",
    schema: z.object({ path: z.string().optional() }),
    permission: PermissionLevel.LOW,
    execute: async ({ path }) => {
      const p = path ?? `/tmp/jarvis-shot-${Date.now()}.png`;
      try {
        mkdirSync(dirname(p), { recursive: true });
      } catch {}
      const backends: [string, string[]][] = [
        ["gnome-screenshot", ["-f", p]],
        ["scrot", [p]],
        ["import", ["-window", "root", p]],
      ];
      for (const [cmd, args] of backends) {
        if (run(cmd, args)) return { ok: true, data: { path: p } };
      }
      return fail("no screenshot backend available");
    },
  });
}
