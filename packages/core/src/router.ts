import type { Intent } from "@jarvis/protocol";

export type Route = "deterministic" | "local" | "claude" | "codex" | "background";

export function selectRoute(intent: Intent): Route {
  switch (intent) {
    case "command":
    case "system":
      return "deterministic";
    case "conversation":
    case "question":
      return "local";
    case "research":
    case "task":
      return "background";
    case "coding":
      return "codex";
    default:
      return "local";
  }
}
