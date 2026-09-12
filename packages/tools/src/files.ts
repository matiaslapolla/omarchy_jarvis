import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { PermissionLevel } from "@jarvis/permissions";
import type { Registry, ToolResult } from "./index.js";

function inside(workspace: string, p: string): string | null {
  const root = resolve(workspace);
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
  return null;
}

function denied(): ToolResult {
  return { ok: false, code: "PERMISSION_ERROR", message: "outside workspace" };
}

function toolError(err: unknown): ToolResult {
  return { ok: false, code: "TOOL_ERROR", message: String(err).slice(0, 300) };
}

export function registerFileTools(reg: Registry): void {
  reg.register({
    id: "files.list",
    description: "List directory entries",
    schema: z.object({ dir: z.string().default(".") }),
    permission: PermissionLevel.SAFE,
    execute: async ({ dir }, ctx) => {
      const abs = inside(ctx.workspace, dir);
      if (!abs) return denied();
      try {
        const entries = readdirSync(abs, { withFileTypes: true })
          .map((d) => ({ name: d.name, type: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other" }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .slice(0, 200);
        return { ok: true, data: { entries } };
      } catch (err) {
        return toolError(err);
      }
    },
  });

  reg.register({
    id: "files.read",
    description: "Read a file with byte cap",
    schema: z.object({ path: z.string(), maxBytes: z.number().int().positive().default(65536) }),
    permission: PermissionLevel.SAFE,
    execute: async ({ path, maxBytes }, ctx) => {
      const abs = inside(ctx.workspace, path);
      if (!abs) return denied();
      try {
        const buf = readFileSync(abs);
        return {
          ok: true,
          data: { path, content: buf.subarray(0, maxBytes).toString("utf8"), truncated: buf.length > maxBytes },
        };
      } catch (err) {
        return toolError(err);
      }
    },
  });

  reg.register({
    id: "files.search",
    description: "Search filenames and file contents",
    schema: z.object({ pattern: z.string().min(1), dir: z.string().default("."), max: z.number().int().positive().default(50) }),
    permission: PermissionLevel.SAFE,
    execute: async ({ pattern, dir, max }, ctx) => {
      const abs = inside(ctx.workspace, dir);
      if (!abs) return denied();
      try {
        const root = resolve(ctx.workspace);
        const matches: { file: string; line?: number }[] = [];
        const stack: string[] = [abs];
        let scanned = 0;
        while (stack.length > 0 && matches.length < max && scanned < 5000) {
          const cur = stack.pop() as string;
          let ents;
          try {
            ents = readdirSync(cur, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const e of ents) {
            if (matches.length >= max || scanned >= 5000) break;
            const full = resolve(cur, e.name);
            if (e.isDirectory()) {
              stack.push(full);
            } else if (e.isFile()) {
              scanned++;
              const rel = relative(root, full);
              if (e.name.includes(pattern)) {
                matches.push({ file: rel });
                continue;
              }
              let size = 0;
              try {
                size = statSync(full).size;
              } catch {
                continue;
              }
              if (size >= 1024 * 1024) continue;
              let text = "";
              try {
                text = readFileSync(full, "utf8");
              } catch {
                continue;
              }
              const lines = text.split("\n");
              for (let i = 0; i < lines.length && matches.length < max; i++) {
                if ((lines[i] as string).includes(pattern)) matches.push({ file: rel, line: i + 1 });
              }
            }
          }
        }
        return { ok: true, data: { matches } };
      } catch (err) {
        return toolError(err);
      }
    },
  });

  reg.register({
    id: "files.write",
    description: "Write content to a file",
    schema: z.object({ path: z.string(), content: z.string(), createDirs: z.boolean().optional() }),
    permission: PermissionLevel.CONFIRM,
    execute: async ({ path, content, createDirs }, ctx) => {
      const abs = inside(ctx.workspace, path);
      if (!abs) return denied();
      try {
        if (createDirs) mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
        return { ok: true, data: { path, bytes: Buffer.byteLength(content, "utf8") } };
      } catch (err) {
        return toolError(err);
      }
    },
  });
}
