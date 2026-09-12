import { z } from "zod";

export const ContextSourceNameSchema = z.enum(["system", "project", "memory", "vision", "conversation"]);
export type ContextSourceName = z.infer<typeof ContextSourceNameSchema>;

export const ContextItemSchema = z.object({
  source: ContextSourceNameSchema,
  content: z.string(),
  priority: z.number().min(0).max(1),
  tokens: z.number().int().nonnegative().optional(),
});
export type ContextItem = z.infer<typeof ContextItemSchema>;

export const ContextBudgetSchema = z.object({
  system: z.number().int().nonnegative(),
  conversation: z.number().int().nonnegative(),
  memory: z.number().int().nonnegative(),
  tools: z.number().int().nonnegative(),
  skills: z.number().int().nonnegative(),
});
export type ContextBudget = z.infer<typeof ContextBudgetSchema>;

export const BUDGETS: Record<"local" | "opencode" | "claudecode", ContextBudget> = {
  local: { system: 2000, conversation: 6000, memory: 3000, tools: 4000, skills: 2000 },
  opencode: { system: 8000, conversation: 24000, memory: 12000, tools: 16000, skills: 8000 },
  claudecode: { system: 8000, conversation: 24000, memory: 12000, tools: 16000, skills: 8000 },
};

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function rank(items: ContextItem[]): ContextItem[] {
  const seen = new Set<string>();
  return [...items]
    .sort((a, b) => b.priority - a.priority)
    .filter((item) => {
      if (seen.has(item.content)) return false;
      seen.add(item.content);
      return true;
    });
}

const MARKER = "…[truncated]";

export function assemble(items: ContextItem[], budgetTotal: number): string {
  const out: string[] = [];
  let used = 0;
  for (const item of rank(items)) {
    const tokens = item.tokens ?? estimateTokens(item.content);
    const room = budgetTotal - used;
    if (room <= 0) break;
    if (tokens <= room) {
      out.push(item.content);
      used += tokens;
    } else {
      const chars = Math.max(0, room * 4 - MARKER.length);
      out.push(`${item.content.slice(0, chars)}${MARKER}`);
      used = budgetTotal;
    }
  }
  return out.join("\n\n");
}
