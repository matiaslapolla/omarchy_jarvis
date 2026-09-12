import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BaseEvent } from "@jarvis/protocol";

export const AgentTaskSchema = z.object({
  id: z.string(),
  traceId: z.string(),
  kind: z.enum(["research", "coding", "automation", "background"]),
  prompt: z.string().min(1),
  workspace: z.string().default("."),
  harness: z.enum(["local", "opencode", "claudecode", "stub"]).default("local"),
  model: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600000).default(120000),
});
export type AgentTask = z.infer<typeof AgentTaskSchema>;

export interface HarnessLimits {
  maxSteps: number;
  maxDurationMs: number;
  maxToolCalls: number;
  maxRetries: number;
}

export const DEFAULT_HARNESS_LIMITS: HarnessLimits = {
  maxSteps: 12,
  maxDurationMs: 120000,
  maxToolCalls: 8,
  maxRetries: 2,
};

export interface AgentHarness {
  id: "local" | "opencode" | "claudecode" | "stub";
  execute(task: AgentTask, limits?: Partial<HarnessLimits>): AsyncIterable<BaseEvent>;
}

export function taskEvent(traceId: string, type: string, payload: unknown): BaseEvent {
  return { id: randomUUID(), type, timestamp: new Date().toISOString(), traceId, payload };
}
