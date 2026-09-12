import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ProjectContext {
  root: string;
  isGit: boolean;
  branch?: string;
  status?: string;
  remote?: string;
  packageManager?: "pnpm" | "npm" | "yarn" | "bun" | "cargo" | "uv" | "unknown";
  language?: string;
  framework?: string;
  importantFiles: string[];
}

const LOCKS: Array<[string, "pnpm" | "npm" | "yarn" | "bun" | "cargo" | "uv"]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["Cargo.lock", "cargo"],
  ["uv.lock", "uv"],
];

function git(params: string[], cwd: string): string | undefined {
  try {
    const result = spawnSync("git", params, { cwd, encoding: "utf8" });
    if (result.status !== 0) return undefined;
    const out = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return out ? out : undefined;
  } catch {
    return undefined;
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function depNames(pkg: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[key];
    if (deps && typeof deps === "object") for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}

function rankFile(name: string): number {
  if (name === "README" || name.startsWith("README.")) return 0;
  if (name === "package.json") return 1;
  if (name.startsWith("tsconfig")) return 2;
  if (name === "pyproject.toml") return 3;
  if (name === "Cargo.toml") return 4;
  if (name === "go.mod") return 5;
  if (name === "Dockerfile") return 6;
  if (name.startsWith("compose")) return 7;
  if (name === ".env.example") return 8;
  return 99;
}

export function detectProject(dir: string): ProjectContext {
  const root = resolve(dir);
  const context: ProjectContext = { root, isGit: false, importantFiles: [] };
  try {
    context.isGit = git(["rev-parse", "--git-dir"], root) !== undefined;
    if (context.isGit) {
      context.branch = git(["branch", "--show-current"], root);
      const status = git(["status", "--porcelain"], root);
      if (status) context.status = status.slice(0, 2048);
      context.remote = git(["remote", "get-url", "origin"], root);
    }
    for (const [lock, manager] of LOCKS) {
      if (existsSync(join(root, lock))) {
        context.packageManager = manager;
        break;
      }
    }
    const pkg = existsSync(join(root, "package.json")) ? readJson(join(root, "package.json")) : undefined;
    if (pkg) {
      const deps = depNames(pkg);
      context.language = deps.has("typescript") ? "typescript" : "javascript";
      if (deps.has("next")) context.framework = "Next.js";
      else if (deps.has("react")) context.framework = "React";
      else if (deps.has("vue")) context.framework = "Vue";
      context.packageManager ??= "unknown";
    } else if (existsSync(join(root, "Cargo.toml"))) {
      context.language = "rust";
    } else if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt"))) {
      context.language = "python";
    } else if (existsSync(join(root, "go.mod"))) {
      context.language = "go";
    }
    const entries = readdirSync(root);
    context.importantFiles = entries
      .filter((entry) => rankFile(entry) < 99)
      .sort((a, b) => rankFile(a) - rankFile(b) || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, 8);
  } catch {
    context.isGit = false;
    context.importantFiles = [];
  }
  return context;
}
