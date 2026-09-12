import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function artifactRoot(): string {
  return process.env.JARVIS_ARTIFACTS_DIR ?? join(process.cwd(), "artifacts");
}

export function artifactDir(taskId: string): string {
  return join(artifactRoot(), "tasks", taskId);
}

export function writeText(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

export function writeReport(
  taskId: string,
  parts: { notes?: string; report: string; sources?: unknown },
): { dir: string; files: string[] } {
  const dir = artifactDir(taskId);
  const files: string[] = [];
  if (parts.notes !== undefined) files.push(writeText(dir, "notes.md", parts.notes));
  files.push(writeText(dir, "report.md", parts.report));
  if (parts.sources !== undefined) files.push(writeText(dir, "sources.json", JSON.stringify(parts.sources, null, 2)));
  return { dir, files };
}
