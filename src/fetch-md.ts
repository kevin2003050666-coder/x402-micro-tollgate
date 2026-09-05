import type { Request, Response, RequestHandler } from "express";
import { jsonError } from "./http.js";
import {
  assertSafePublicHttpUrlPinned,
  type SafePublicUrl,
} from "./ssrf.js";
import { PACKAGE_VERSION } from "./version.js";

export {
  isBlockedIp,
  assertSafePublicHttpUrl,
  assertSafePublicHttpUrlPinned,
  type SafePublicUrl,
} from "./ssrf.js";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BYTES = 512_000;

/** Minimal HTML → Markdown for the paid demo (no heavy parser dependency). */
export function htmlToMarkdown(html: string): { markdown: string; title?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1]?.replace(/\s+/g, " ").trim() || undefined;

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  const mainMatch = body.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (mainMatch) body = mainMatch[1];

  body = body
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n# ${stripTags(t).trim()}\n\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n## ${stripTags(t).trim()}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n### ${stripTags(t).trim()}\n\n`)
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, t) => `\n#### ${stripTags(t).trim()}\n\n`)
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, t) => `\n##### ${stripTags(t).trim()}\n\n`)
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, t) => `\n###### ${stripTags(t).trim()}\n\n`)
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => `\n${inlineMarkdown(t).trim()}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${inlineMarkdown(t).trim()}\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, t) => `\n\`\`\`\n${decodeEntities(t)}\n\`\`\`\n\n`)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, t) => `\n\`\`\`\n${stripTags(t)}\n\`\`\`\n\n`)
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) =>
      `\n${inlineMarkdown(t)
        .trim()
        .split(/\n/)
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`,
    );

  body = inlineMarkdown(body);
  body = stripTags(body);
  body = decodeEntities(body);
  const markdown = body.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return title ? { markdown, title } : { markdown };
}

function inlineMarkdown(fragment: string): string {
  return fragment
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const label = stripTags(text).trim() || href;
      return `[${label}](${href})`;
    })
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, text) => `**${stripTags(text).trim()}**`)
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, text) => `*${stripTags(text).trim()}*`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, text) => `\`${stripTags(text).trim()}\``);
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

async function readLimitedBody(response: globalThis.Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw Object.assign(new Error("Response too large"), { code: "too_large" });
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw Object.assign(new Error("Response too large"), { code: "too_large" });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export interface FetchMarkdownOptions {
  /**
   * Override URL safety checks (tests may allow loopback fixture servers).
   * May return `URL` or `SafePublicUrl`.
   */
  assertSafeUrl?: (raw: string) => Promise<URL | SafePublicUrl>;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface FetchMarkdownResult {
  url: string;
  markdown: string;
  title?: string;
}

/**
 * Shared HTML→Markdown fetch used by HTTP `/v1/fetch-md` and MCP `fetch_md`.
 * Throws Error with `.code` for mapped failures (`missing_url`, `invalid_url`, …).
 */
export async function fetchMarkdownFromUrl(
  rawUrl: string,
  options: FetchMarkdownOptions = {},
): Promise<FetchMarkdownResult> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw Object.assign(new Error("Query parameter url is required"), { code: "missing_url" });
  }

  const assertUrl = options.assertSafeUrl ?? assertSafePublicHttpUrlPinned;
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  let target: URL;
  try {
    const safe = await assertUrl(trimmed);
    target = safe instanceof URL ? safe : safe.url;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: string }).code)
        : "invalid_url";
    const message = err instanceof Error ? err.message : "Invalid URL";
    throw Object.assign(new Error(message), { code });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Do not follow redirects — blocks private-hop Location rebinding.
    const response = await fetchImpl(target, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "user-agent": `x402-micro-tollgate-fetch-md/${PACKAGE_VERSION}`,
      },
    });

    if (!response.ok) {
      throw Object.assign(new Error(`Upstream returned HTTP ${response.status}`), {
        code: "fetch_failed",
      });
    }

    const html = await readLimitedBody(response, maxBytes);
    const { markdown, title } = htmlToMarkdown(html);
    return {
      url: target.toString(),
      markdown,
      ...(title ? { title } : {}),
    };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }
    const aborted =
      (err instanceof Error && err.name === "AbortError") ||
      (typeof err === "object" &&
        err !== null &&
        "name" in err &&
        (err as { name: string }).name === "AbortError");
    if (aborted) {
      throw Object.assign(new Error(`Fetch timed out after ${timeoutMs}ms`), {
        code: "timeout",
      });
    }
    const message = err instanceof Error ? err.message : "Fetch failed";
    throw Object.assign(new Error(message), { code: "fetch_failed" });
  } finally {
    clearTimeout(timer);
  }
}

export type FetchMdHandlerOptions = FetchMarkdownOptions;

/**
 * Paid demo: GET /v1/fetch-md?url=… — runs after x402 middleware settles.
 * Fetches a public page and returns Markdown (SSRF-hardened: scheme allowlist,
 * private IP deny, DNS re-check before fetch, no redirects).
 */
export function createFetchMdHandler(options: FetchMdHandlerOptions = {}): RequestHandler {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  return async (req: Request, res: Response) => {
    const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
    try {
      const result = await fetchMarkdownFromUrl(rawUrl, options);
      res.status(200).json(result);
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: string }).code)
          : "fetch_failed";
      const message = err instanceof Error ? err.message : "Fetch failed";
      if (code === "too_large") {
        jsonError(res, 413, "too_large", `Page exceeds ${maxBytes} byte limit`);
        return;
      }
      if (code === "timeout") {
        jsonError(res, 504, "timeout", `Fetch timed out after ${timeoutMs}ms`);
        return;
      }
      if (code === "fetch_failed") {
        jsonError(res, 502, "fetch_failed", message);
        return;
      }
      // missing_url / invalid_* / ssrf_blocked / dns_failed / …
      jsonError(res, 400, code, message);
    }
  };
}
