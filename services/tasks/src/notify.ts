import { randomUUID } from "node:crypto";
import { loadToolContext } from "@jarvis/permissions";
import { Registry, executeTool } from "@jarvis/tools";
import { registerSystemTools } from "@jarvis/tools/system.js";

export async function notify(title: string, body: string): Promise<boolean> {
  try {
    const registry = new Registry();
    registerSystemTools(registry);
    const outcome = await executeTool(registry, "system.notification", { title, body }, loadToolContext(randomUUID()));
    return outcome.status === "done" ? outcome.result.ok : false;
  } catch {
    return false;
  }
}
