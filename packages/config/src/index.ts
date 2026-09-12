import { z } from "zod";

export const ProfileSchema = z.enum(["development", "desktop", "performance", "privacy"]);
export type Profile = z.infer<typeof ProfileSchema>;

export const JarvisConfigSchema = z.object({
  profile: ProfileSchema,
  gateway: z.object({ port: z.number(), host: z.string() }),
  runtime: z.object({
    maxSteps: z.number(),
    maxDurationMs: z.number(),
    maxToolCalls: z.number(),
    maxRetries: z.number(),
  }),
  localModel: z.object({
    baseUrl: z.string(),
    chatModel: z.string(),
    embeddingModel: z.string(),
  }),
});
export type JarvisConfig = z.infer<typeof JarvisConfigSchema>;

export function loadConfig(): JarvisConfig {
  const parsed = ProfileSchema.safeParse(process.env.JARVIS_PROFILE);
  const profile: Profile = parsed.success ? parsed.data : "development";
  return Object.freeze(
    JarvisConfigSchema.parse({
      profile,
      gateway: { port: 8787, host: "127.0.0.1" },
      runtime: { maxSteps: 12, maxDurationMs: 60000, maxToolCalls: 8, maxRetries: 2 },
      localModel: {
        baseUrl: "http://127.0.0.1:11421",
        chatModel: "llama3.1:8b",
        embeddingModel: "nomic-embed-text",
      },
    }),
  );
}
