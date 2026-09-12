import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export type ExtractResult = { url: string; title: string; text: string; links: string[] };

export interface BrowserBackend {
  navigate(url: string): Promise<{ url: string }>;
  click(ref: string): Promise<void>;
  type(ref: string, text: string, submit?: boolean): Promise<void>;
  extract(): Promise<ExtractResult>;
  screenshot(path?: string): Promise<{ path: string }>;
  wait(ms: number): Promise<void>;
  close(): Promise<void>;
}

type PageState = { title: string; text: string; links: string[] };

export class MemoryBackend implements BrowserBackend {
  private currentUrl = "about:blank";
  private pages = new Map<string, PageState>();

  seed(url: string, page: { title?: string; text?: string; links?: string[] }): void {
    this.pages.set(url, { title: page.title ?? "", text: page.text ?? "", links: page.links ?? [] });
  }

  private page(): PageState {
    const hit = this.pages.get(this.currentUrl);
    if (hit) return hit;
    const next: PageState = { title: "", text: "", links: [] };
    this.pages.set(this.currentUrl, next);
    return next;
  }

  async navigate(url: string): Promise<{ url: string }> {
    this.currentUrl = url;
    this.page();
    return { url };
  }

  async click(_ref: string): Promise<void> {}

  async type(_ref: string, text: string, _submit?: boolean): Promise<void> {
    this.page().text += text;
  }

  async extract(): Promise<ExtractResult> {
    const p = this.pages.get(this.currentUrl);
    return { url: this.currentUrl, title: p?.title ?? "", text: p?.text ?? "", links: p?.links ?? [] };
  }

  async screenshot(path?: string): Promise<{ path: string }> {
    const dest = path ?? `/tmp/jarvis-page-${Date.now()}.json`;
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, JSON.stringify(await this.extract()));
    return { path: dest };
  }

  async wait(ms: number): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, Math.min(Math.max(ms, 0), 5000)));
  }

  async close(): Promise<void> {}
}

const MISSING = "playwright not installed — pnpm add playwright && playwright install chromium";

function unavailable(): Error & { code: string } {
  return Object.assign(new Error(MISSING), { code: "BROWSER_UNAVAILABLE" });
}

export class PlaywrightBackend implements BrowserBackend {
  private browser: any = null;
  private page: any = null;
  private currentUrl = "about:blank";

  private async ready(): Promise<any> {
    if (this.page) return this.page;
    const specifier: string = "playwright";
    let mod: any;
    try {
      mod = await import(specifier);
    } catch {
      throw unavailable();
    }
    try {
      this.browser = await mod.chromium.launch();
      this.page = await this.browser.newPage();
    } catch {
      throw unavailable();
    }
    return this.page;
  }

  async navigate(url: string): Promise<{ url: string }> {
    const p = await this.ready();
    await p.goto(url);
    this.currentUrl = p.url() ?? url;
    return { url: this.currentUrl };
  }

  async click(ref: string): Promise<void> {
    const p = await this.ready();
    try {
      await p.locator(`[data-ref="${ref}"]`).or(p.locator(ref)).first().click({ timeout: 5000 });
    } catch {
      await p.getByText(ref, { exact: false }).first().click({ timeout: 5000 });
    }
  }

  async type(ref: string, text: string, submit?: boolean): Promise<void> {
    const p = await this.ready();
    try {
      await p.locator(`[data-ref="${ref}"]`).or(p.locator(ref)).first().fill(text, { timeout: 5000 });
    } catch {
      await p.getByText(ref, { exact: false }).first().fill(text, { timeout: 5000 });
    }
    if (submit) await p.keyboard.press("Enter");
  }

  async extract(): Promise<ExtractResult> {
    const p = await this.ready();
    const url: string = p.url() ?? this.currentUrl;
    const title: string = await p.title();
    const text: string = await p.evaluate("document.body ? document.body.innerText : ''");
    const links: string[] = await p.evaluate(
      "Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(Boolean).slice(0, 100)",
    );
    return { url, title, text: String(text).slice(0, 20000), links };
  }

  async screenshot(path?: string): Promise<{ path: string }> {
    const p = await this.ready();
    const dest = path ?? `/tmp/jarvis-page-${Date.now()}.png`;
    await mkdir(dirname(dest), { recursive: true });
    await p.screenshot({ path: dest });
    return { path: dest };
  }

  async wait(ms: number): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, Math.min(Math.max(ms, 0), 5000)));
  }

  async close(): Promise<void> {
    try {
      await this.page?.close();
    } catch {}
    try {
      await this.browser?.close();
    } catch {}
    this.page = null;
    this.browser = null;
  }
}

export function createBackend(kind: string | undefined): BrowserBackend {
  return kind === "playwright" ? new PlaywrightBackend() : new MemoryBackend();
}

export const BrowserSchemas = {
  navigate: z.object({ url: z.string().url() }),
  click: z.object({ ref: z.string().min(1) }),
  type: z.object({ ref: z.string().min(1), text: z.string(), submit: z.boolean().optional() }),
  extract: z.object({}),
  screenshot: z.object({ path: z.string().optional() }),
  wait: z.object({ ms: z.number().int().min(0).max(10000) }),
};
