export * from "./types.js";
export * from "./system.js";
export * from "./project.js";
import { assemble, BUDGETS, estimateTokens } from "./types.js";
import type { ContextItem } from "./types.js";

export interface AssembledContext {
  text: string;
  items: ContextItem[];
  tokens: number;
}

export function buildContextBlock(parts: {
  system?: ContextItem[];
  project?: ContextItem | null;
  memory?: string[];
  text?: string[];
}): AssembledContext {
  const items: ContextItem[] = [];
  if (parts.system?.length) {
    items.push({ source: "system", content: `## System\n${parts.system.map((i) => i.content).join("\n")}`, priority: 0.5 });
  }
  if (parts.project) {
    items.push({ source: "project", content: `## Project\n${parts.project.content}`, priority: 0.7 });
  }
  if (parts.memory?.length) {
    items.push({ source: "memory", content: `## Memories\n${parts.memory.join("\n")}`, priority: 0.6 });
  }
  if (parts.text?.length) {
    for (const t of parts.text) items.push({ source: "conversation", content: t, priority: 0.4 });
  }
  const total = BUDGETS.local.system + BUDGETS.local.memory + 2000;
  const text = assemble(items, total);
  return { text, items, tokens: estimateTokens(text) };
}
