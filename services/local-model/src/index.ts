import Fastify from "fastify";
import { z } from "zod";

const DEFAULT_MODEL = process.env.LOCAL_MODEL ?? "qwen2.5:3b";
const PORT = Number(process.env.LOCAL_MODEL_PORT ?? 11421);

const MessageSchema = z.object({ role: z.string(), content: z.string() });
const ChatSchema = z.object({
  model: z.string().optional(),
  messages: z.array(MessageSchema),
  stream: z.boolean().optional(),
});
const EmbedSchema = z.object({ input: z.string(), model: z.string().optional() });
const LoadSchema = z.object({ model: z.string() });

const resident = new Set<string>([DEFAULT_MODEL]);

function lastUserText(messages: { role: string; content: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return messages.at(-1)?.content ?? "";
}

export function buildServer() {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true }));

  app.post("/chat", async (req, reply) => {
    const body = ChatSchema.parse(req.body);
    const model = body.model ?? DEFAULT_MODEL;
    const text = `(local stub) ${lastUserText(body.messages)}`;
    const usage = {
      input: body.messages.reduce((n, m) => n + m.content.length, 0),
      output: text.length,
    };
    if (body.stream === true) {
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      reply.raw.write(`data: ${JSON.stringify({ delta: text })}\n\n`);
      reply.raw.write(`data: ${JSON.stringify({ done: true, model, usage })}\n\n`);
      reply.raw.end();
      return reply;
    }
    return { text, model, usage };
  });

  app.post("/embed", async (req) => {
    const body = EmbedSchema.parse(req.body);
    return {
      embedding: [0, 0, 0, 0, 0, 0, 0, 0].map(() => 0.0),
      model: body.model ?? DEFAULT_MODEL,
    };
  });

  app.post("/load", async (req) => {
    const body = LoadSchema.parse(req.body);
    resident.add(body.model);
    return { ok: true, model: body.model };
  });

  app.post("/unload", async (req) => {
    const body = LoadSchema.parse(req.body);
    resident.delete(body.model);
    return { ok: true, model: body.model };
  });

  app.get("/models", async () => ({ models: [...resident], resident: "fast" }));

  app.setErrorHandler((err, _req, reply) => {
    console.error(JSON.stringify({ level: "error", err: String(err) }));
    if (err instanceof z.ZodError) {
      void reply.code(400).send({ code: "VALIDATION_ERROR" });
      return;
    }
    void reply.code(500).send({ code: "INTERNAL_ERROR" });
  });

  return app;
}

const app = buildServer();
app
  .listen({ port: PORT, host: "127.0.0.1" })
  .catch((err: unknown) => {
    console.error(JSON.stringify({ level: "fatal", err: String(err) }));
    process.exit(1);
  });
