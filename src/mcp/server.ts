import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TollgateConfig } from "../config.js";
import { PACKAGE_VERSION } from "../version.js";
import { createMcpPaymentLayer, type McpPaymentLayer } from "./payment.js";
import {
  createFetchMdToolHandler,
  createGetQuoteHandler,
  createProxyRequestHandler,
  createServerInfoHandler,
  fetchMdSchema,
  proxyRequestSchema,
} from "./tools.js";

export interface TollgateMcp {
  server: McpServer;
  payment: McpPaymentLayer;
}

/**
 * Build a fresh McpServer with free + paid tools.
 * Call per Streamable HTTP request (stateless) or once for stdio / SSE session.
 */
export async function createTollgateMcpServer(
  config: TollgateConfig,
  paymentLayer?: McpPaymentLayer,
): Promise<TollgateMcp> {
  const payment = paymentLayer ?? (await createMcpPaymentLayer(config));
  const server = new McpServer({
    name: "x402-micro-tollgate",
    version: PACKAGE_VERSION,
  });

  // FREE
  server.tool(
    "server_info",
    "Gateway status: mode, network, price, gatedPrefix, upstream. No payment required.",
    {},
    createServerInfoHandler(config, payment),
  );

  // PAID — same price as HTTP gated routes
  const getQuote = payment.wrapPaid(
    "get_quote",
    `Fetch /v1/quote from upstream (or mock). Requires payment of ${config.price}.`,
    createGetQuoteHandler(config),
  );
  server.tool(
    "get_quote",
    `Fetch a sample quote from the upstream API (mock when UPSTREAM_URL is unset). Requires payment of ${config.price} USDC.`,
    {},
    getQuote,
  );

  const proxyRequest = payment.wrapPaid(
    "proxy_request",
    `Forward an HTTP request to upstream after payment of ${config.price}.`,
    createProxyRequestHandler(config),
  );
  server.tool(
    "proxy_request",
    `Forward method/path/query/headers/body to UPSTREAM_URL (or mock). Requires payment of ${config.price} USDC.`,
    proxyRequestSchema,
    proxyRequest,
  );

  const fetchMd = payment.wrapPaid(
    "fetch_md",
    `Fetch a public http(s) URL and return Markdown (same as GET /v1/fetch-md). Requires payment of ${config.price}.`,
    createFetchMdToolHandler(),
  );
  server.tool(
    "fetch_md",
    `Fetch a public http(s) URL and convert HTML to Markdown. Requires payment of ${config.price} USDC. Same capability as HTTP GET /v1/fetch-md.`,
    fetchMdSchema,
    fetchMd,
  );

  return { server, payment };
}
