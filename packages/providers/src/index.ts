import { z } from "zod";

export const MessageSchema = z.object({
  role: z.string(),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof MessageSchema>;

export const GenerateRequestSchema = z.object({
  model: z.string().optional(),
  system: z.string().optional(),
  messages: z.array(MessageSchema),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().optional(),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

export const GenerateResponseSchema = z.object({
  text: z.string(),
  model: z.string(),
  usage: z.object({ input: z.number(), output: z.number() }),
  finishReason: z.string(),
});
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

export interface ProviderCapabilities {
  tools: boolean;
  vision: boolean;
  streaming: boolean;
  reasoning: boolean;
}

export interface LLMProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
  generateStream?(req: GenerateRequest): AsyncIterable<string>;
}

const ChatResponseSchema = z.object({
  text: z.string(),
  model: z.string(),
  usage: z.object({ input: z.number(), output: z.number() }).optional(),
});

export class LocalProvider implements LLMProvider {
  readonly id = "local";
  readonly capabilities: ProviderCapabilities = {
    tools: false,
    vision: false,
    streaming: true,
    reasoning: false,
  };

  constructor(private readonly baseUrl = "http://127.0.0.1:11421") {}

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    GenerateRequestSchema.parse(req);
    const body = {
      model: req.model,
      messages:
        req.system != null
          ? [{ role: "system", content: req.system }, ...req.messages]
          : req.messages,
      stream: false as const,
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw Object.assign(new Error("local provider unreachable"), {
        code: "PROVIDER_ERROR",
        cause,
      });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`local provider ${res.status}`), {
        code: "PROVIDER_ERROR",
      });
    }
    const json: unknown = await res.json();
    const parsed = ChatResponseSchema.parse(json);
    return {
      text: parsed.text,
      model: parsed.model,
      usage: parsed.usage ?? { input: 0, output: 0 },
      finishReason: "stop",
    };
  }

  async *generateStream(req: GenerateRequest): AsyncIterable<string> {
    yield (await this.generate(req)).text;
  }
}
