import Fastify from "fastify";
import { UserInputSchema } from "@jarvis/protocol";
import { runInput } from "@jarvis/runtime";
import { LocalProvider } from "@jarvis/providers";

const PORT = Number(process.env.GATEWAY_PORT ?? 8787);
const MODEL_URL = process.env.LOCAL_MODEL_URL ?? "http://127.0.0.1:11421";

export function buildServer() {
  const app = Fastify({ logger: false });
  const provider = new LocalProvider(MODEL_URL);

  app.get("/health", async () => ({ ok: true }));

  app.post("/v1/input", async (req, reply) => {
    const parsed = UserInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "VALIDATION_ERROR" });
    }
    const input = parsed.data as { id: string };
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    try {
      for await (const event of runInput(input as never, { provider })) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      console.error(JSON.stringify({ level: "error", traceId: input.id, err: String(err) }));
      const code = (err as { code?: string }).code ?? "SYSTEM_ERROR";
      reply.raw.write(
        `data: ${JSON.stringify({ id: globalThis.crypto.randomUUID(), type: "tool.failed", timestamp: new Date().toISOString(), traceId: input.id, payload: { code } })}\n\n`,
      );
    }
    reply.raw.end();
    return reply;
  });

  app.setErrorHandler((err, _req, reply) => {
    console.error(JSON.stringify({ level: "error", err: String(err) }));
    void reply.code(500).send({ code: "INTERNAL_ERROR" });
  });

  return app;
}

const app = buildServer();
app
  .listen({ port: PORT, host: "0.0.0.0" })
  .catch((err: unknown) => {
    console.error(JSON.stringify({ level: "fatal", err: String(err) }));
    process.exit(1);
  });
