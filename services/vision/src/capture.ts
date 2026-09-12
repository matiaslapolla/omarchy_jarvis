import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

export type CaptureResult = { path: string; width: number; height: number; bytes: number; backend: string };
export type CaptureOpts = { path?: string; region?: string };

const BACKENDS = ["grim", "gnome-screenshot", "scrot", "import"] as const;

function has(bin: string): boolean {
  return spawnSync(`command -v ${bin}`, { shell: true, stdio: "ignore", timeout: 5000 }).status === 0;
}

export function pngSize(path: string): { width: number; height: number } | undefined {
  try {
    const b = readFileSync(path);
    if (b.length < 24) return undefined;
    if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47 || b[4] !== 0x0d || b[5] !== 0x0a || b[6] !== 0x1a || b[7] !== 0x0a) return undefined;
    if (b.toString("ascii", 12, 16) !== "IHDR") return undefined;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch {
    return undefined;
  }
}

export function captureAvailable(): string[] {
  return BACKENDS.filter(has);
}

export function capture(opts?: CaptureOpts): CaptureResult {
  const path = opts?.path ?? `/tmp/jarvis-screen-${Date.now()}.png`;
  const attempts: { backend: string; args: string[] }[] = [
    { backend: "grim", args: opts?.region ? ["-g", opts.region, path] : [path] },
    { backend: "gnome-screenshot", args: ["-f", path] },
    { backend: "scrot", args: [path] },
    { backend: "import", args: ["-window", "root", path] },
  ];
  for (const a of attempts) {
    if (!has(a.backend)) continue;
    try {
      const r = spawnSync(a.backend, a.args, { stdio: "ignore", timeout: 10_000 });
      if (r.status !== 0) continue;
      const size = pngSize(path);
      if (!size) continue;
      return { path, width: size.width, height: size.height, bytes: statSync(path).size, backend: a.backend };
    } catch {
      continue;
    }
  }
  const e = new Error(`CAPTURE_UNAVAILABLE: no backend succeeded (tried: ${attempts.map((a) => a.backend).join(", ")})`) as Error & { code: string };
  e.code = "CAPTURE_UNAVAILABLE";
  throw e;
}
