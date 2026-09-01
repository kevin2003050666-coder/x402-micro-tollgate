import dns from "node:dns/promises";
import net from "node:net";
import type { Request, Response, RequestHandler } from "express";
import { jsonError } from "./http.js";

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

export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1" || normalized === "::") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // ULA
    if (normalized.startsWith("fe80")) return true; // link-local
    if (normalized.startsWith("::ffff:")) {
      const v4 = normalized.slice("::ffff:".length);
      if (net.isIPv4(v4)) return isBlockedIp(v4);
    }
    return false;
  }
  return true;
}

export async function assertSafePublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("Invalid URL"), { code: "invalid_url" });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw Object.assign(new Error("Only http and https URLs are allowed"), {
      code: "invalid_scheme",
    });
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw Object.assign(new Error("Localhost and private hosts are not allowed"), {
      code: "ssrf_blocked",
    });
  }

  // Literal IP in hostname
  if (net.isIP(host)) {
    if (isBlockedIp(host)) {
      throw Object.assign(new Error("Private or reserved IP addresses are not allowed"), {
        code: "ssrf_blocked",
      });
    }
    return url;
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error("Could not resolve hostname"), { code: "dns_failed" });
  }

  if (!records.length) {
    throw Object.assign(new Error("Could not resolve hostname"), { code: "dns_failed" });
  }

  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw Object.assign(new Error("Hostname resolves to a private or reserved address"), {
        code: "ssrf_blocked",
      });
    }
  }

  return url;
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

export interface FetchMdHandlerOptions {
  /** Override URL safety checks (tests may allow loopback fixture servers). */
  assertSafeUrl?: (raw: string) => Promise<URL>;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Paid demo: GET /v1/fetch-md?url=… — runs after x402 middleware settles.
 * Fetches a public page and returns Markdown (SSRF-hardened).
 */
export function createFetchMdHandler(options: FetchMdHandlerOptions = {}): RequestHandler {
  const assertUrl = options.assertSafeUrl ?? assertSafePublicHttpUrl;
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  return async (req: Request, res: Response) => {
    const rawUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
    if (!rawUrl) {
      jsonError(res, 400, "missing_url", "Query parameter url is required");
      return;
    }

    let target: URL;
    try {
      target = await assertUrl(rawUrl);
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: string }).code)
          : "invalid_url";
      const message = err instanceof Error ? err.message : "Invalid URL";
      jsonError(res, 400, code, message);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Do not follow redirects — keeps SSRF surface small (no private hop via Location).
      const response = await fetchImpl(target, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "user-agent": "x402-micro-tollgate-fetch-md/0.2",
        },
      });

      if (!response.ok) {
        jsonError(res, 502, "fetch_failed", `Upstream returned HTTP ${response.status}`);
        return;
      }

      const html = await readLimitedBody(response, maxBytes);
      const { markdown, title } = htmlToMarkdown(html);
      res.status(200).json({
        url: target.toString(),
        markdown,
        ...(title ? { title } : {}),
      });
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "too_large") {
        jsonError(res, 413, "too_large", `Page exceeds ${maxBytes} byte limit`);
        return;
      }
      const aborted =
        (err instanceof Error && err.name === "AbortError") ||
        (typeof err === "object" &&
          err !== null &&
          "name" in err &&
          (err as { name: string }).name === "AbortError");
      if (aborted) {
        jsonError(res, 504, "timeout", `Fetch timed out after ${timeoutMs}ms`);
        return;
      }
      const message = err instanceof Error ? err.message : "Fetch failed";
      jsonError(res, 502, "fetch_failed", message);
    } finally {
      clearTimeout(timer);
    }
  };
}
