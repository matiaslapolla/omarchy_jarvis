import { readFileSync } from "node:fs";
import { z } from "zod";

export type VisionImage = { path: string; width: number; height: number };
export type VisionResult = { text: string; model: string };
export interface VisionProvider {
  readonly id: string;
  describe(image: VisionImage): Promise<VisionResult>;
}

function fail(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

export class StubVision implements VisionProvider {
  readonly id = "stub-vision";
  async describe(image: VisionImage): Promise<VisionResult> {
    return {
      text: `Screen captured (${image.width}x${image.height}, ${image.path}). Vision model not installed — no visual interpretation available.`,
      model: this.id,
    };
  }
}

const OllamaResponse = z.object({ response: z.string() }).passthrough();

export class OllamaVision implements VisionProvider {
  readonly id = "ollama-vision";
  readonly baseUrl: string;
  readonly model: string;
  constructor() {
    this.baseUrl = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.model = process.env.VISION_MODEL ?? "qwen2.5vl:3b";
  }
  async describe(image: VisionImage): Promise<VisionResult> {
    let b64: string;
    try {
      b64 = readFileSync(image.path).toString("base64");
    } catch {
      throw fail("VISION_ERROR", `cannot read image at ${image.path}`);
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: "Describe this screen concisely for a desktop assistant user.",
          images: [b64],
          stream: false,
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw fail("VISION_UNAVAILABLE", `ollama unreachable at ${this.baseUrl}`);
    }
    if (!res.ok) throw fail("VISION_ERROR", `ollama status ${res.status}`);
    const parsed = OllamaResponse.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw fail("VISION_ERROR", "ollama returned an invalid response");
    return { text: parsed.data.response, model: this.model };
  }
}

export function createVision(): VisionProvider {
  return process.env.JARVIS_VISION === "ollama" ? new OllamaVision() : new StubVision();
}
