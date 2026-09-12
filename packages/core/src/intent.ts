import type { IntentResult } from "@jarvis/protocol";

export function detectIntent(content: string): IntentResult {
  const t = content.trim();
  if (/^(open|abre|close|cierra|volume|volumen|mute|screenshot|pantalla|notific|notify|list|lista|read|lee|write|escribe|search|busca|run|ejecuta|browse|navega)\b/i.test(t)) {
    return { intent: "command", confidence: 0.95 };
  }
  if (/\?|qu\u00e9|c\u00f3mo|what|how|why/i.test(content)) {
    return { intent: "question", confidence: 0.8 };
  }
  if (/(investigat|research|averigua)/i.test(content)) {
    return { intent: "research", confidence: 0.85 };
  }
  if (/(fix|implement|refactor|test|debug|code)/i.test(content)) {
    return { intent: "coding", confidence: 0.85 };
  }
  if (/(background|while i work|mientras trabajo)/i.test(content)) {
    return { intent: "task", confidence: 0.85 };
  }
  return { intent: "conversation", confidence: 0.6 };
}
