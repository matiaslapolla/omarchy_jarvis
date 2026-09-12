import { z } from "zod";
export const MemoryTypeSchema = z.enum(["episodic", "semantic", "procedural", "preference"]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;
export const MemorySchema = z.object({
  id: z.string(),
  type: MemoryTypeSchema,
  content: z.string().min(1),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  embedding: z.array(z.number()).optional(),
  entities: z.array(z.string()).default([]),
  createdAt: z.string(),
  lastAccessedAt: z.string()
});
export type Memory = z.infer<typeof MemorySchema>;
export const NewMemorySchema = MemorySchema.omit({ id: true, createdAt: true, lastAccessedAt: true });
export type NewMemory = z.infer<typeof NewMemorySchema>;
export const MemoryCandidateSchema = z.object({
  content: z.string().min(1),
  type: MemoryTypeSchema,
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  entities: z.array(z.string()).default([])
});
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;
export interface ScoredMemory {
  memory: Memory;
  score: number;
  parts: { semantic: number; recency: number; importance: number; entity: number };
}
export const RETRIEVAL_WEIGHTS = { semantic: 0.5, recency: 0.2, importance: 0.2, entity: 0.1 };
