import { z } from "zod";

export const EVENT_CATEGORIES = ["voice", "agent", "tool", "task", "memory", "system", "runtime"] as const;
export const EventCategorySchema = z.enum(EVENT_CATEGORIES);
export type EventCategory = z.infer<typeof EventCategorySchema>;

export const BaseEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  timestamp: z.string(),
  traceId: z.string(),
  payload: z.unknown(),
});
export type BaseEvent = z.infer<typeof BaseEventSchema>;

export const InputSourceSchema = z.enum(["voice", "desktop", "cli", "api"]);
export type InputSource = z.infer<typeof InputSourceSchema>;

export const UserInputSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  source: InputSourceSchema,
  content: z.string(),
  metadata: z.object({
    activeApp: z.string().optional(),
    activeWindow: z.string().optional(),
    selectedText: z.string().optional(),
    currentDirectory: z.string().optional(),
  }).optional(),
});
export type UserInput = z.infer<typeof UserInputSchema>;

export const IntentSchema = z.enum(["command", "question", "conversation", "task", "coding", "research", "system"]);
export type Intent = z.infer<typeof IntentSchema>;

export const IntentResultSchema = z.object({
  intent: IntentSchema,
  confidence: z.number().min(0).max(1),
});
export type IntentResult = z.infer<typeof IntentResultSchema>;

export const TaskStatusSchema = z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const AgentStartedSchema = BaseEventSchema.extend({ type: z.literal("agent.started") });
export const AgentDeltaSchema = BaseEventSchema.extend({ type: z.literal("agent.delta") });
export const AgentCompletedSchema = BaseEventSchema.extend({ type: z.literal("agent.completed") });
export const ToolStartedSchema = BaseEventSchema.extend({ type: z.literal("tool.started") });
export const ToolCompletedSchema = BaseEventSchema.extend({ type: z.literal("tool.completed") });
export const ToolFailedSchema = BaseEventSchema.extend({ type: z.literal("tool.failed") });
export const TaskCreatedSchema = BaseEventSchema.extend({ type: z.literal("task.created") });
export const TaskProgressSchema = BaseEventSchema.extend({ type: z.literal("task.progress") });
export const TaskCompletedSchema = BaseEventSchema.extend({ type: z.literal("task.completed") });

export const AgentEventSchema = z.union([
  AgentStartedSchema,
  AgentDeltaSchema,
  AgentCompletedSchema,
  ToolStartedSchema,
  ToolCompletedSchema,
  ToolFailedSchema,
  TaskCreatedSchema,
  TaskProgressSchema,
  TaskCompletedSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
