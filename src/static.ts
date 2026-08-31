import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolve the package `public/` directory whether running from:
 * - repo root via `tsx src/server.ts`
 * - published package `node dist/server.js` / `npx x402-micro-tollgate`
 */
export function resolvePublicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.cwd(), "public"),
    path.join(here, "..", "public"),
    path.join(here, "public"),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return candidates[0]!;
}
