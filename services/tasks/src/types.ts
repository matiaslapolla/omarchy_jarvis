import { z } from "zod";

export const TaskKindSchema = z.enum(["research", "coding", "automation", "background"]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskStatusSchema = z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  kind: TaskKindSchema,
  prompt: z.string().min(1),
  workspace: z.string().default("."),
  status: TaskStatusSchema.default("queued"),
  result: z
    .object({
      summary: z.string(),
      artifactDir: z.string().optional(),
      events: z.number(),
    })
    .optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const NewTaskSchema = TaskSchema.pick({ kind: true, prompt: true, workspace: true });
export type NewTask = z.input<typeof NewTaskSchema>;
