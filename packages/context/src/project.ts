import { detectProject } from "@jarvis/harness";
import type { ContextItem } from "./types.js";

export type ProjectProbe = (dir: string) => {
  root: string;
  branch?: string;
  packageManager?: string;
  language?: string;
  framework?: string;
  isGit?: boolean;
};

export function collectProject(dir: string, probe: ProjectProbe = detectProject): ContextItem | null {
  try {
    const p = probe(dir);
    if (!p || !p.root) return null;
    if (!p.isGit && !p.branch && !p.packageManager && !p.language && !p.framework) return null;
    const lang = [p.language, p.framework].filter(Boolean).join(" ");
    const tail = [lang, p.packageManager, p.branch ? `branch ${p.branch}` : ""].filter(Boolean).join(", ");
    return { source: "project", content: tail ? `Project ${p.root} (${tail})` : `Project ${p.root}`, priority: 0.7 };
  } catch {
    return null;
  }
}

export function forWhom(intent: string): boolean {
  return intent === "coding" || intent === "question" || intent === "research";
}
