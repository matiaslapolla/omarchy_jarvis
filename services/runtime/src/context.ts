import { recallFor } from "./memory.js";

// ADR-0001 Phase 7: advanced context assembly for the runtime pipeline.
//
// @jarvis/context (packages/context) and @jarvis/vision (services/vision)
// are owned by other workers, so both resolve at runtime via dynamic import
// only. The specifiers below are typed as `string` (not literals) so
// TypeScript skips static module resolution — this file compiles and runs
// whether or not the packages (or individual exports) have landed. Any
// missing piece degrades to "no items for that source". Same pattern as the
// Phase 5 memory wiring (memory.ts). contextFor() never throws.
const CONTEXT_SPEC: string = "@jarvis/context";
const VISION_SPEC: string = "@jarvis/vision";

type UnknownRecord = Record<string, unknown>;
type AnyFn = (...args: unknown[]) => unknown;

export interface ContextItem {
  source: string;
  priority: number;
  content: string;
  tokens?: number;
}

export interface ContextForInput {
  content: string;
  intent: string;
  workspace: string;
}

export interface ContextForResult {
  block: string;
  tokens: number;
}

/** Hard cap: the assembled block never exceeds this many chars. */
const MAX_BLOCK_CHARS = 4000;

/** Fallback project intents when forWhom() has not landed yet. */
const PROJECT_INTENTS = new Set(["coding", "question", "research"]);

/** Vision capture trigger: capture only, no VLM unless describe matches. */
const VISION_TRIGGER = /screen|pantalla|mir[aá]\b/i;
const VISION_DESCRIBE = /describ|explain|explica/i;

/** Local gate fallback when shouldCollect() has not landed yet. */
const APP_HINT = /mira|muestra|pantalla|screen|window|ventana|error|app/i;
const CLIPBOARD_HINT = /clipboard|portapapeles|pegado|paste|esto/i;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

async function tryImport(spec: string): Promise<UnknownRecord | undefined> {
  try {
    const mod: unknown = await import(spec);
    return isRecord(mod) ? mod : undefined;
  } catch {
    return undefined;
  }
}

function pickFn(mod: UnknownRecord | undefined, names: string[]): AnyFn | undefined {
  if (mod == null) return undefined;
  for (const name of names) {
    const fn = mod[name];
    if (typeof fn === "function") return fn as AnyFn;
  }
  return undefined;
}

function strOf(value: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = value[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

function numOf(value: UnknownRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = value[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Coerce an arbitrary provider result into ContextItems (never throws). */
function normalizeItems(out: unknown, source: string, priority: number): ContextItem[] {
  const rows = Array.isArray(out) ? out : [out];
  const items: ContextItem[] = [];
  for (const row of rows) {
    if (typeof row === "string") {
      if (row.trim() !== "") items.push({ source, priority, content: row });
    } else if (isRecord(row)) {
      const content = strOf(row, ["content", "text"]);
      if (content == null || content.trim() === "") continue;
      const pri = numOf(row, ["priority"]);
      items.push({
        source: strOf(row, ["source"]) ?? source,
        priority: pri != null ? Math.min(1, Math.max(0, pri)) : priority,
        content,
      });
    }
  }
  return items;
}

async function systemItems(
  ctx: UnknownRecord | undefined,
  content: string,
  workspace: string,
): Promise<ContextItem[]> {
  if (ctx == null) return [];
  try {
    let app = APP_HINT.test(content);
    let clipboard = CLIPBOARD_HINT.test(content);
    const shouldCollect = pickFn(ctx, ["shouldCollect"]);
    if (shouldCollect != null) {
      try {
        const gate: unknown = await shouldCollect(content);
        if (isRecord(gate)) {
          app = gate["app"] === true;
          clipboard = gate["clipboard"] === true;
        } else if (typeof gate === "boolean") {
          app = gate;
          clipboard = gate;
        }
      } catch {
        return [];
      }
    }
    if (!app && !clipboard) return [];
    const collectSystem = pickFn(ctx, ["collectSystem"]);
    if (collectSystem == null) return [];
    let collected: unknown;
    try {
      collected = await collectSystem({ app, clipboard, cwd: workspace });
    } catch {
      return [];
    }
    if (collected == null) return [];
    if (typeof collected === "string") {
      return collected.trim() !== "" ? [{ source: "system", priority: 0.5, content: collected }] : [];
    }
    const toItem = pickFn(ctx, ["toItem"]);
    if (toItem != null) {
      try {
        const items = normalizeItems(await toItem(collected), "system", 0.5);
        if (items.length > 0) return items;
      } catch {
        // fall through to manual wrap
      }
    }
    if (isRecord(collected)) {
      const direct = normalizeItems(collected, "system", 0.5);
      if (direct.length > 0) return direct;
      return [{ source: "system", priority: 0.5, content: JSON.stringify(collected).slice(0, 1000) }];
    }
    return [];
  } catch {
    return [];
  }
}

async function projectItems(
  ctx: UnknownRecord | undefined,
  intent: string,
  workspace: string,
): Promise<ContextItem[]> {
  if (ctx == null) return [];
  try {
    let wanted = PROJECT_INTENTS.has(intent);
    const forWhom = pickFn(ctx, ["forWhom"]);
    if (forWhom != null) {
      try {
        wanted = (await forWhom(intent)) === true;
      } catch {
        return [];
      }
    }
    if (!wanted) return [];
    const collectProject = pickFn(ctx, ["collectProject"]);
    if (collectProject == null) return [];
    let out: unknown;
    try {
      out = await collectProject(workspace);
    } catch {
      return [];
    }
    if (out == null) return [];
    return normalizeItems(out, "project", 0.7);
  } catch {
    return [];
  }
}

async function visionItems(content: string): Promise<ContextItem[]> {
  try {
    if (!VISION_TRIGGER.test(content)) return [];
    const vision = await tryImport(VISION_SPEC);
    const lookAtScreen = pickFn(vision, ["lookAtScreen"]);
    if (lookAtScreen == null) return [];
    // Capture only by default; describe only when explicitly asked.
    const describe = VISION_DESCRIBE.test(content);
    let shot: unknown;
    try {
      shot = await lookAtScreen({ describe });
    } catch {
      return [];
    }
    if (typeof shot === "string") {
      return shot.trim() !== "" ? [{ source: "vision", priority: 0.6, content: shot }] : [];
    }
    if (!isRecord(shot)) return [];
    const cap = shot["capture"];
    if (isRecord(cap)) {
      const w = numOf(cap, ["width", "w"]);
      const h = numOf(cap, ["height", "h"]);
      const path = strOf(cap, ["path", "file", "screenshot"]);
      if (w != null && h != null && path != null) {
        let text = `Screen: ${w}x${h} at ${path}`;
        const desc = strOf(shot, ["description"]);
        if (desc != null && desc.trim() !== "") text += `\n${desc.slice(0, 1000)}`;
        return [{ source: "vision", priority: 0.6, content: text }];
      }
    }
    // No usable capture: honest unavailable note, never a fake Screen line.
    const reason =
      strOf(shot, ["code", "error", "reason", "message"]) ?? "capture unavailable";
    return [{ source: "vision", priority: 0.6, content: `Screen unavailable (${reason})` }];
  } catch {
    return [];
  }
}

async function memoryStrings(content: string): Promise<string[]> {
  try {
    return (await recallFor(content, 5)).map((m) => m.trim()).filter((m) => m !== "");
  } catch {
    return [];
  }
}

/**
 * Assemble advanced context for a turn. Never throws: any missing package,
 * export, or runtime failure degrades to fewer (or zero) items.
 */
export async function contextFor(input: ContextForInput): Promise<ContextForResult> {
  try {
    const content = input.content ?? "";
    const intent = input.intent ?? "";
    const workspace = input.workspace ?? "";
    if (content.trim() === "") return { block: "", tokens: 0 };
    const ctx = await tryImport(CONTEXT_SPEC);
    const [sys, proj, vis, mems] = await Promise.all([
      systemItems(ctx, content, workspace),
      projectItems(ctx, intent, workspace),
      visionItems(content),
      memoryStrings(content),
    ]);
    const estimate = pickFn(ctx, ["estimateTokens", "countTokens"]);
    const count = async (s: string): Promise<number> => {
      if (estimate != null) {
        try {
          const n: unknown = await estimate(s);
          if (typeof n === "number" && Number.isFinite(n)) return Math.max(0, Math.floor(n));
        } catch {
          // fall through to local estimate
        }
      }
      return Math.ceil(s.length / 4);
    };
    const finish = async (text: string): Promise<ContextForResult> => {
      const block = text.length > MAX_BLOCK_CHARS ? text.slice(0, MAX_BLOCK_CHARS) : text;
      return { block, tokens: block === "" ? 0 : await count(block) };
    };
    const build = pickFn(ctx, ["buildContextBlock"]);
    if (build != null) {
      try {
        const out: unknown = await build({
          system: sys.length > 0 ? sys : undefined,
          project: proj.length > 0 ? proj[0] : null,
          memory: mems.length > 0 ? mems : undefined,
        });
        let text = "";
        if (typeof out === "string") text = out;
        else if (isRecord(out)) text = strOf(out, ["text", "block"]) ?? "";
        if (vis.length > 0) {
          const vtext = vis.map((v) => v.content).join("\n\n");
          text = text !== "" ? `${text}\n\n${vtext}` : vtext;
        }
        return await finish(text);
      } catch {
        // fall through to manual join
      }
    }
    // Manual join fallback (~10 lines, no breakage when @jarvis/context absent).
    const items: ContextItem[] = [
      ...sys,
      ...proj,
      ...vis,
      ...mems.map((m) => ({ source: "memory", priority: 0.8, content: m })),
    ];
    items.sort((a, b) => b.priority - a.priority);
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const item of items) {
      const key = item.content.trim();
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      lines.push(item.content);
    }
    return await finish(lines.join("\n\n"));
  } catch {
    return { block: "", tokens: 0 };
  }
}
