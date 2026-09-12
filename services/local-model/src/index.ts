import Fastify from "fastify";
import { z } from "zod";

const PORT = Number(process.env.LOCAL_MODEL_PORT ?? 11421);
const BACKEND = process.env.BACKEND ?? "ollama";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const CHAT_MODEL = process.env.LOCAL_CHAT_MODEL ?? "qwen2.5:7b";
const EMBED_MODEL = process.env.LOCAL_EMBED_MODEL ?? "bge-m3:latest";
const THINK = process.env.LOCAL_THINK === "1";
const KEEP_ALIVE = process.env.LOCAL_KEEP_ALIVE ?? "5m";

const MessageSchema = z.object({ role: z.string(), content: z.string() });
const ChatSchema = z.object({
  model: z.string().optional(),
  messages: z.array(MessageSchema),
  stream: z.boolean().optional(),
  keep_alive: z.string().optional(),
});
const EmbedSchema = z.object({
  input: z.union([z.string(), z.array(z.string())]),
  model: z.string().optional(),
});
const LoadSchema = z.object({ model: z.string(), keep_alive: z.string().optional() });

function lastUserText(messages: { role: string; content: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return messages.at(-1)?.content ?? "";
}

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}

class ThinkStripper {
  private buf = "";
  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      const open = this.buf.indexOf("<think>");
      if (open === -1) {
        const tail = this.buf.match(/<(t(h(i(n(k)?)?)?)?)?$/);
        if (tail && tail.index !== undefined && tail.index > 0) {
          out += this.buf.slice(0, tail.index);
          this.buf = this.buf.slice(tail.index);
        } else if (!tail) {
          out += this.buf;
          this.buf = "";
        }
        return out;
      }
      out += this.buf.slice(0, open);
      const close = this.buf.indexOf("</think>", open);
      if (close === -1) {
        this.buf = this.buf.slice(open);
        return out;
      }
      this.buf = this.buf.slice(close + 8);
    }
  }
  flush(): string {
    const rest = stripThink(this.buf);
    this.buf = "";
    return rest;
  }
}

function stubChat(model: string, messages: { role: string; content: string }[]): { text: string; usage: { input: number; output: number } } {
  const text = `(local stub) ${lastUserText(messages)}`;
  return { text, usage: { input: messages.reduce((n, m) => n + m.content.length, 0), output: text.length } };
}

async function ollama(path: string, body: unknown, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${OLLAMA_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

async function ollamaOk(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

export function buildServer() {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, backend: BACKEND, ollama: await ollamaOk() }));

  app.post("/chat", async (req, reply) => {
    const body = ChatSchema.parse(req.body);
    const model = body.model ?? CHAT_MODEL;
    const keepAlive = body.keep_alive ?? KEEP_ALIVE;
    if (BACKEND !== "ollama" || !(await ollamaOk())) {
      const s = stubChat(model, body.messages);
      return { text: s.text, model, usage: s.usage, backend: "stub" };
    }
    if (body.stream === true) {
      const up = await ollama("/api/chat", { model, messages: body.messages, stream: true, think: THINK, keep_alive: keepAlive }, 300_000);
      if (!up.ok || up.body == null) {
        void reply.code(502).send({ code: "OLLAMA_ERROR", status: up.status });
        return reply;
      }
      reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const reader = up.body.getReader();
      const dec = new TextDecoder();
      const stripper = new ThinkStripper();
      let buf = "";
      let full = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          try {
            const ev = JSON.parse(t) as { message?: { content?: string }; done?: boolean };
            const clean = stripper.push(ev.message?.content ?? "");
            if (clean) {
              full += clean;
              reply.raw.write(`data: ${JSON.stringify({ delta: clean })}\n\n`);
            }
            if (ev.done) {
              const tail = stripper.flush();
              if (tail) {
                full += tail;
                reply.raw.write(`data: ${JSON.stringify({ delta: tail })}\n\n`);
              }
              reply.raw.write(`data: ${JSON.stringify({ done: true, model, usage: { input: full.length, output: full.length } })}\n\n`);
            }
          } catch {
            continue;
          }
        }
      }
      reply.raw.end();
      return reply;
    }
    const up = await ollama("/api/chat", { model, messages: body.messages, stream: false, think: THINK, keep_alive: keepAlive }, 300_000);
    if (!up.ok) {
      void reply.code(502).send({ code: "OLLAMA_ERROR", status: up.status });
      return reply;
    }
    const json = (await up.json()) as { message?: { content?: string }; model?: string; prompt_eval_count?: number; eval_count?: number };
    const text = stripThink(json.message?.content ?? "");
    return {
      text,
      model: json.model ?? model,
      usage: { input: json.prompt_eval_count ?? 0, output: json.eval_count ?? 0 },
      backend: "ollama",
    };
  });

  app.post("/embed", async (req, reply) => {
    const body = EmbedSchema.parse(req.body);
    const model = body.model ?? EMBED_MODEL;
    if (BACKEND !== "ollama" || !(await ollamaOk())) {
      return { embedding: [0, 0, 0, 0, 0, 0, 0, 0], model, dims: 8, backend: "stub" };
    }
    const up = await ollama("/api/embed", { model, input: body.input }, 120_000);
    if (!up.ok) {
      void reply.code(502).send({ code: "OLLAMA_ERROR", status: up.status });
      return reply;
    }
    const json = (await up.json()) as { embeddings?: number[][]; model?: string };
    const first = json.embeddings?.[0] ?? [];
    return { embedding: first, embeddings: json.embeddings ?? [], model: json.model ?? model, dims: first.length, backend: "ollama" };
  });

  app.post("/load", async (req, reply) => {
    const body = LoadSchema.parse(req.body);
    if (BACKEND !== "ollama" || !(await ollamaOk())) return { ok: true, model: body.model, backend: "stub" };
    const up = await ollama("/api/chat", { model: body.model, messages: [{ role: "user", content: "ping" }], stream: false, think: false, keep_alive: body.keep_alive ?? KEEP_ALIVE }, 300_000);
    if (!up.ok) {
      void reply.code(502).send({ code: "OLLAMA_ERROR", status: up.status });
      return reply;
    }
    return { ok: true, model: body.model, backend: "ollama" };
  });

  app.post("/unload", async (req, reply) => {
    const body = LoadSchema.parse(req.body);
    if (BACKEND !== "ollama" || !(await ollamaOk())) return { ok: true, model: body.model, backend: "stub" };
    const up = await ollama("/api/generate", { model: body.model, keep_alive: 0 }, 60_000);
    if (!up.ok) {
      void reply.code(502).send({ code: "OLLAMA_ERROR", status: up.status });
      return reply;
    }
    return { ok: true, model: body.model, backend: "ollama" };
  });

  app.get("/models", async () => {
    if (BACKEND !== "ollama" || !(await ollamaOk())) {
      return { models: [CHAT_MODEL, EMBED_MODEL], resident: [], backend: "stub" };
    }
    const [tags, ps] = await Promise.all([
      fetch(`${OLLAMA_URL}/api/tags`).then((r) => r.json() as Promise<{ models?: { name?: string }[] }>),
      fetch(`${OLLAMA_URL}/api/ps`).then((r) => r.json() as Promise<{ models?: { name?: string }[] }>),
    ]);
    return {
      models: (tags.models ?? []).map((m) => m.name ?? "").filter(Boolean),
      resident: (ps.models ?? []).map((m) => m.name ?? "").filter(Boolean),
      backend: "ollama",
    };
  });

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
