export * from "./capture.js";
export * from "./providers.js";
import { capture, type CaptureResult } from "./capture.js";
import { createVision } from "./providers.js";

export type LookResult = { capture?: CaptureResult; description?: string; code?: string };

export async function lookAtScreen(opts?: { describe?: boolean }): Promise<LookResult> {
  try {
    const cap = capture();
    if (!opts?.describe) return { capture: cap };
    const r = await createVision().describe({ path: cap.path, width: cap.width, height: cap.height });
    return { capture: cap, description: r.text };
  } catch (e) {
    const code = (e as { code?: unknown } | undefined)?.code;
    return { code: typeof code === "string" ? code : "VISION_ERROR" };
  }
}
