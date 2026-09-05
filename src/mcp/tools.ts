import { z } from "zod";
import type { TollgateConfig } from "../config.js";
import { fetchMarkdownFromUrl, type FetchMarkdownOptions } from "../fetch-md.js";
import { forwardUpstreamRequest } from "../upstream.js";
import type { McpPaymentLayer } from "./payment.js";

export const proxyRequestSchema = {
  method: z
    .string()
    .default("GET")
    .describe("HTTP method to forward (GET, POST, PUT, PATCH, DELETE, …)"),
  path: z.string().describe("Upstream path, e.g. /v1/quote"),
  query: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .describe("Optional query string parameters"),
  headers: z.record(z.string()).optional().describe("Optional request headers (payment headers stripped)"),
  body: z.unknown().optional().describe("Optional JSON body for non-GET requests"),
};

export type ProxyRequestArgs = {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | null>;
  headers?: Record<string, string>;
  body?: unknown;
};

export const fetchMdSchema = {
  url: z
    .string()
    .describe("Public http(s) URL to fetch and convert to Markdown (same as GET /v1/fetch-md)"),
};

export type FetchMdArgs = {
  url: string;
};

function textResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function createServerInfoHandler(config: TollgateConfig, payment: McpPaymentLayer) {
  return async () =>
    textResult({
      name: "x402-micro-tollgate",
      mode: payment.mode,
      environment: config.environment,
      network: config.network,
      price: config.price,
      gatedPrefix: config.gatedPrefix || "*",
      upstream: config.upstreamUrl ?? "mock",
      payTo: payment.payTo,
      mcp: {
        streamableHttp: "/mcp",
        sse: "/sse",
        messages: "/messages",
      },
      docs: {
        seller: "https://docs.cdp.coinbase.com/x402/seller/mcp-payments",
        buyer: "https://docs.cdp.coinbase.com/x402/buyer/mcp-payments",
      },
    });
}

export function createGetQuoteHandler(config: TollgateConfig) {
  return async () => {
    const result = await forwardUpstreamRequest(config, {
      method: "GET",
      path: "/v1/quote",
    });
    return textResult(
      {
        status: result.status,
        body: result.body,
      },
      result.status >= 400,
    );
  };
}

export function createProxyRequestHandler(config: TollgateConfig) {
  return async (args: ProxyRequestArgs) => {
    const method = args.method ?? "GET";
    const result = await forwardUpstreamRequest(config, {
      method,
      path: args.path,
      query: args.query,
      headers: args.headers,
      body: args.body,
    });
    return textResult(
      {
        status: result.status,
        method: method.toUpperCase(),
        path: args.path.startsWith("/") ? args.path : `/${args.path}`,
        body: result.body,
      },
      result.status >= 400,
    );
  };
}

/** Paid MCP twin of HTTP GET /v1/fetch-md — reuses SSRF-hardened fetchMarkdownFromUrl. */
export function createFetchMdToolHandler(options: FetchMarkdownOptions = {}) {
  return async (args: FetchMdArgs) => {
    try {
      const result = await fetchMarkdownFromUrl(args.url, options);
      return textResult(result);
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: string }).code)
          : "fetch_failed";
      const message = err instanceof Error ? err.message : "Fetch failed";
      return textResult({ error: code, message }, true);
    }
  };
}
