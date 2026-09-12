import type { Intent } from "@jarvis/protocol";

export type Route = "deterministic" | "local" | "opencode" | "claudecode" | "background";

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
      return "opencode";
    default:
      return "local";
  }
}

export function harnessFor(route: Route): "local" | "opencode" | "claudecode" | "stub" {
  if (process.env.JARVIS_HARNESS === "stub") return "stub";
  switch (route) {
    case "local":
    case "deterministic":
      return "local";
    case "claudecode":
      return "claudecode";
    default:
      return "opencode";
  }
}
