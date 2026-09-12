import { z } from "zod";
import { PermissionLevel } from "@jarvis/permissions";
import type { Registry, Tool, ToolResult } from "./index.js";

export interface BrowserLike {
  navigate(url: string): Promise<{ url: string }>;
  click(ref: string): Promise<void>;
  type(ref: string, text: string, submit?: boolean): Promise<void>;
  extract(): Promise<{ url: string; title: string; text: string; links: string[] }>;
  screenshot(path?: string): Promise<{ path: string }>;
  wait(ms: number): Promise<void>;
  close(): Promise<void>;
}

const navigateSchema = z.object({ url: z.string().url() });
const clickSchema = z.object({ ref: z.string().min(1) });
const typeSchema = z.object({ ref: z.string().min(1), text: z.string(), submit: z.boolean().optional() });
const extractSchema = z.object({});
const screenshotSchema = z.object({ path: z.string().optional() });
const waitSchema = z.object({ ms: z.number().int().min(0).max(10000) });

function fail(e: unknown): ToolResult {
  const code = (e as { code?: unknown })?.code;
  return { ok: false, code: typeof code === "string" ? code : "TOOL_ERROR", message: e instanceof Error ? e.message : String(e) };
}

async function run<T>(schema: z.ZodType<T>, input: unknown, fn: (parsed: T) => Promise<unknown>): Promise<ToolResult> {
  try {
    return { ok: true, data: await fn(schema.parse(input)) };
  } catch (e) {
    return fail(e);
  }
}

export function registerBrowserTools(reg: Registry, backend: BrowserLike): void {
  const tools: Tool[] = [
    {
      id: "browser.navigate",
      description: "Navigate the browser to a URL",
      schema: navigateSchema,
      permission: PermissionLevel.LOW,
      execute: (input: unknown) => run(navigateSchema, input, (p) => backend.navigate(p.url)),
    },
    {
      id: "browser.click",
      description: "Click an element by ref",
      schema: clickSchema,
      permission: PermissionLevel.LOW,
      execute: (input: unknown) => run(clickSchema, input, (p) => backend.click(p.ref)),
    },
    {
      id: "browser.type",
      description: "Type text into an element by ref",
      schema: typeSchema,
      permission: PermissionLevel.LOW,
      execute: (input: unknown) => run(typeSchema, input, (p) => backend.type(p.ref, p.text, p.submit)),
    },
    {
      id: "browser.extract",
      description: "Extract title, text and links from the current page",
      schema: extractSchema,
      permission: PermissionLevel.LOW,
      execute: (input: unknown) => run(extractSchema, input, () => backend.extract()),
    },
    {
      id: "browser.screenshot",
      description: "Capture a screenshot of the current page",
      schema: screenshotSchema,
      permission: PermissionLevel.LOW,
      execute: (input: unknown) => run(screenshotSchema, input, (p) => backend.screenshot(p.path)),
    },
    {
      id: "browser.wait",
      description: "Wait for a number of milliseconds",
      schema: waitSchema,
      permission: PermissionLevel.LOW,
      execute: (input: unknown) => run(waitSchema, input, (p) => backend.wait(p.ms)),
    },
  ];
  for (const t of tools) reg.register(t);
}
