import { spawnSync } from "node:child_process";
import { hostname, platform } from "node:os";
import { cwd } from "node:process";
import type { ContextItem } from "./types.js";

export interface SystemInfo {
  os: string;
  hostname: string;
  activeApp?: string;
  activeWindow?: string;
  currentDirectory?: string;
  selectedText?: string;
  clipboard?: string;
}

function run(cmd: string, args: string[]): string | undefined {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 3000 });
    if (r.status !== 0) return undefined;
    const out = typeof r.stdout === "string" ? r.stdout.trim() : "";
    return out ? out : undefined;
  } catch {
    return undefined;
  }
}

export function collectSystem(opts?: { app?: boolean; clipboard?: boolean; cwd?: string }): SystemInfo {
  let dir: string | undefined;
  try {
    dir = opts?.cwd ?? cwd();
  } catch {
    dir = undefined;
  }
  const info: SystemInfo = { os: platform(), hostname: hostname(), currentDirectory: dir };
  if (opts?.app) {
    try {
      const raw = run("hyprctl", ["activewindow", "-j"]);
      if (raw) {
        const w = JSON.parse(raw) as { class?: string; title?: string };
        if (w.class) info.activeApp = w.class;
        if (w.title) info.activeWindow = w.title;
      }
      if (!info.activeWindow) {
        const title = run("xdotool", ["getactivewindow", "getwindowname"]);
        if (title) info.activeWindow = title;
      }
    } catch {
      info.activeApp ??= undefined;
    }
  }
  if (opts?.clipboard) {
    const text = run("wl-paste", []) ?? run("xclip", ["-o"]);
    if (text) info.clipboard = text.slice(0, 500);
  }
  return info;
}

export function shouldCollect(text: string): { app: boolean; clipboard: boolean } {
  return {
    app: /mira|pantalla|screen|window|ventana|error|app/i.test(text),
    clipboard: /clipboard|portapapeles|pegado|paste|esto/i.test(text),
  };
}

export function toItem(info: SystemInfo): ContextItem[] {
  const lines = [
    `os: ${info.os}`,
    `hostname: ${info.hostname}`,
    info.activeApp ? `app: ${info.activeApp}` : "",
    info.activeWindow ? `window: ${info.activeWindow}` : "",
    info.currentDirectory ? `cwd: ${info.currentDirectory}` : "",
    info.selectedText ? `selected: ${info.selectedText}` : "",
    info.clipboard ? `clipboard: ${info.clipboard}` : "",
  ].filter(Boolean);
  return [{ source: "system", content: lines.join("\n"), priority: 0.5 }];
}
