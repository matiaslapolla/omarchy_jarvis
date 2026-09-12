import type { Memory, MemoryCandidate } from "./types.js";

// ---------------------------------------------------------------------------
// extract.ts — deterministic memory-extraction (cognition worker, ADR-0001 P5)
// Allowed imports: ./types.js (types only) — no runtime deps, no zod needed.
// NOTE on tokenization: jaccard() and mergeCandidates() use the module-local
// tok(), which mirrors store.tokenize (lowercase alnum split). A local copy
// avoids a cross-worker *value* dependency on ./store.js (store worker owns
// that file). Keep the two in sync: lowercase, split on non-alphanumeric.
// ---------------------------------------------------------------------------

export type ExtractSource = "user" | "agent";

/** Local mirror of store.tokenize: lowercase alnum split (byte-identical). */
function tok(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

const MAX_CANDIDATES = 5;
const MIN_CONTENT = 12;
const MAX_CONTENT = 280;

const PREF_RE =
  /(prefiero|me gusta(n)?|no me gusta(n)?|i prefer|i like|i don't like|don't like)\b[^.!?]{4,}/i;
const FACT_RE =
  /(my|mi)\s+\w+[^.!?]{4,}(is|es|are|son)\b[^.!?]{2,}/i;
const EPISODIC_RE =
  /(trabaj[eé]|worked on|termin[eé]|finished|deploy[eé]|deployed|investigu[eé]|researched|arregl[eé]|fixed)\b[^.!?]{4,}/i;
const PROCEDURAL_RE =
  /(para\s+\w+[^:]{2,}:|to\s+\w+[^:]{2,}:|pasos?:|steps?:)/i;

type Rule = {
  name: "preference" | "semantic" | "episodic" | "procedural";
  type: MemoryCandidate["type"];
  importance: number;
  confidence: number;
  reason: string;
  test: (sentence: string, source: ExtractSource, fullText: string) => boolean;
};

function hasStepMarker(sentence: string): boolean {
  return /\d/.test(sentence) || /^\s*[-*•>]/.test(sentence) || /\(\d+\)/.test(sentence);
}

const RULES: Rule[] = [
  {
    name: "preference",
    type: "preference",
    importance: 0.7,
    confidence: 0.75,
    reason: "preference:trigger",
    test: (s) => PREF_RE.test(s),
  },
  {
    name: "semantic",
    type: "semantic",
    importance: 0.5,
    confidence: 0.6,
    reason: "semantic:fact",
    // Agent claims aren't user facts — user source only.
    test: (s, source) => source === "user" && FACT_RE.test(s),
  },
  {
    name: "episodic",
    type: "episodic",
    importance: 0.45,
    confidence: 0.65,
    reason: "episodic:event",
    test: (s) => EPISODIC_RE.test(s),
  },
  {
    name: "procedural",
    type: "procedural",
    importance: 0.6,
    confidence: 0.55,
    reason: "procedural:steps",
    test: (s) => PROCEDURAL_RE.test(s) && hasStepMarker(s),
  },
];

function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const part of line.split(/[.!?]+/)) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * Strip diacritics for trigger probing only ("terminé" → "termine").
 * The spec regexes end accented stems with \b, and \b does not fire between
 * two non-\w chars (é + space), so ES triggers would never match without
 * folding. Content/entities always come from the original sentence.
 */
function foldDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

function finalizeContent(sentence: string): string | null {
  let c = sentence.trim();
  if (c.length < MIN_CONTENT) return null;
  if (c.length > MAX_CONTENT) c = c.slice(0, MAX_CONTENT).trim();
  if (c.length < MIN_CONTENT) return null;
  return c;
}

/**
 * Deterministic ES+EN candidate extraction. Strips to the sentence containing
 * the trigger, caps at 5 candidates / 280 chars, drops <12-char contents.
 */
export function extractCandidates(
  text: string,
  source: ExtractSource,
): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  const seen = new Set<string>();
  for (const sentence of splitSentences(text)) {
    const probe = foldDiacritics(sentence);
    for (const rule of RULES) {
      if (out.length >= MAX_CANDIDATES) return out;
      if (!rule.test(probe, source, text)) continue;
      const content = finalizeContent(sentence);
      if (!content) continue;
      const key = `${rule.type}::${dedupeKey(content)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        content,
        type: rule.type,
        importance: rule.importance,
        confidence: rule.confidence,
        reason: rule.reason,
        entities: extractEntities(content),
      });
    }
  }
  return out;
}

const QUOTED_RES = [/"([^"]+)"/g, /"([^"]+)"/g];
const CAP_SEQ_RE =
  /[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)*/g;
const AFTER_KW_RE = /(?:proyecto|project|repo|repositorio)\s+([\w-]+)/gi;

// Single-word capitalized noise to drop (spec mandates El, La, The, A, Yo, I).
const SINGLE_STOP = new Set([
  "el",
  "la",
  "los",
  "las",
  "the",
  "a",
  "an",
  "yo",
  "i",
  "de",
  "del",
  "en",
  "y",
  "e",
  "un",
  "una",
  "mi",
  "my",
  "me",
  "se",
  "que",
  "para",
  "con",
  "por",
  "su",
  "sus",
  "es",
  "son",
  "is",
  "are",
  "this",
  "that",
  "it",
  "we",
  "you",
  "he",
  "she",
  "they",
]);

/**
 * Entities: quoted spans, Capitalized sequences, tokens after
 * proyecto|project|repo|repositorio. Deduped (case-insensitive, first form
 * wins), capped at 8.
 */
export function extractEntities(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const e = raw.trim();
    if (!e) return;
    if (!e.includes(" ") && SINGLE_STOP.has(e.toLowerCase())) return;
    const k = e.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    found.push(e);
  };
  for (const re of QUOTED_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) push(m[1]);
  }
  CAP_SEQ_RE.lastIndex = 0;
  {
    let m: RegExpExecArray | null;
    while ((m = CAP_SEQ_RE.exec(text)) !== null) push(m[0]);
  }
  AFTER_KW_RE.lastIndex = 0;
  {
    let m: RegExpExecArray | null;
    while ((m = AFTER_KW_RE.exec(text)) !== null) push(m[1]);
  }
  return found.slice(0, 8);
}

/** Lowercase, strip non-alnum (unicode-aware), collapse spaces. */
export function dedupeKey(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard similarity over tokenize sets (local tok() mirrors store.tokenize). */
export function jaccard(a: string, b: string): number {
  const sa = new Set(tok(a));
  const sb = new Set(tok(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Same-type jaccard(dedupeKey tokens) > 0.8 → merge (caller bumps importance
 * to min(1,+.1), takes max confidence, refreshes lastAccessedAt, unions
 * entities); else new. First match in array order wins (deterministic).
 */
export function mergeCandidates(
  existing: Memory[],
  candidate: MemoryCandidate,
): { action: "new" | "merge"; target?: Memory } {
  const candKey = dedupeKey(candidate.content);
  for (const mem of existing) {
    if (mem.type !== candidate.type) continue;
    if (jaccard(dedupeKey(mem.content), candKey) > 0.8) {
      return { action: "merge", target: mem };
    }
  }
  return { action: "new" };
}
