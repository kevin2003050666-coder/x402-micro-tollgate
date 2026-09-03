import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

function packageRootCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [process.cwd(), path.join(here, ".."), here];
}

/**
 * Resolve the package `public/` directory whether running from:
 * - repo root via `tsx src/server.ts`
 * - published package `node dist/server.js` / `npx x402-micro-tollgate`
 */
export function resolvePublicDir(): string {
  const candidates = packageRootCandidates().map((root) => path.join(root, "public"));
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return candidates[0]!;
}

/**
 * Resolve repo-root `llms.txt` for free agent-crawler routes.
 * Returns undefined when the file is not packaged / not present.
 */
export function resolveLlmsTxtPath(): string | undefined {
  for (const root of packageRootCandidates()) {
    const candidate = path.join(root, "llms.txt");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve `docs/openapi.yaml` for free agent-SEO routes.
 * Returns undefined when the file is not packaged / not present.
 */
export function resolveOpenApiYamlPath(): string | undefined {
  for (const root of packageRootCandidates()) {
    const candidate = path.join(root, "docs", "openapi.yaml");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
