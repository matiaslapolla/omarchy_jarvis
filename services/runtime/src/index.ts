export { runInput } from "./pipeline.js";
export type { PipelineDeps } from "./pipeline.js";
export { runDelegated, harnessForRoute } from "./delegate.js";
export { memorySystemBlock, recallFor, rememberTurn, getSharedStore } from "./memory.js";
export { contextFor } from "./context.js";
export type { ContextForInput, ContextForResult, ContextItem } from "./context.js";
// Re-exported so the gateway can classify context queries without adding a
// @jarvis/core dependency (runtime already depends on core statically).
export { detectIntent } from "@jarvis/core";
