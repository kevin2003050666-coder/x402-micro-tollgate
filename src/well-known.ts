import type { TollgateConfig } from "./config.js";
import {
  buildDiscoverDocument,
  type DiscoverDocument,
  type DiscoverService,
} from "./discover.js";
import {
  httpFetchMdBazaarExtension,
  httpQuoteBazaarExtension,
  mcpFetchMdBazaarExtension,
  mcpGetQuoteBazaarExtension,
  mcpProxyRequestBazaarExtension,
} from "./bazaar.js";
import { dollarPriceToAtomic } from "./gas-floor.js";
import { PACKAGE_VERSION } from "./version.js";

/** Bazaar-friendly origin manifest (no payment). */
export const WELL_KNOWN_X402_PATH = "/.well-known/x402.json";
/** Thin alias without `.json` suffix. */
export const WELL_KNOWN_X402_ALIAS_PATH = "/.well-known/x402";

/** A2A-style agent card (discovery links only; not a Coinbase product). */
export const WELL_KNOWN_AGENT_CARD_PATH = "/.well-known/agent-card.json";
/** Legacy thin alias. */
export const WELL_KNOWN_AGENT_ALIAS_PATH = "/.well-known/agent.json";

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface X402WellKnownAccept {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

export interface X402DiscoveredResource {
  resource: string;
  type: "http" | "mcp";
  x402Version: 2;
  lastUpdated: string;
  accepts: X402WellKnownAccept[];
  extensions: Record<string, unknown>;
}

export interface X402WellKnownDocument {
  x402Version: 2;
  name: "x402-micro-tollgate";
  description: string;
  version: string;
  network: string;
  updatedAt: string;
  publicBaseUrl: string;
  /** Same free yellow pages as GET /x402/discover. */
  discover: string;
  source: DiscoverDocument["source"];
  services: DiscoverService[];
  /** Live paid HTTP + MCP resources only (no invented marketplace entries). */
  resources: X402DiscoveredResource[];
}

export interface AgentCardDocument {
  name: "x402-micro-tollgate";
  description: string;
  version: string;
  url: string;
  documentationUrl: string;
  provider: {
    organization: string;
    url: string;
  };
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    x402: boolean;
    mcp: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
  }>;
  /** Machine-readable discovery surfaces (no PII). */
  discovery: {
    publicBaseUrl: string;
    mcp: string;
    openapi: string;
    llmsTxt: string;
    x402Discover: string;
    x402WellKnown: string;
    agentCard: string;
  };
}

function primaryAccepts(
  config: TollgateConfig,
  payTo: string,
): X402WellKnownAccept[] {
  const amount = dollarPriceToAtomic(config.price).toString();
  const specs =
    config.accepts.length > 0
      ? config.accepts
      : [
          {
            network: config.network,
            asset: payTo,
            name: "USDC",
            version: "2",
            decimals: 6,
            symbol: "USDC" as const,
            transferMethod: "eip3009" as const,
            status: "live" as const,
          },
        ];

  return specs.map((spec) => ({
    scheme: "exact" as const,
    network: spec.network,
    amount,
    asset: spec.asset,
    payTo: spec.payTo ?? payTo,
    maxTimeoutSeconds: 60,
    extra: {
      name: spec.name,
      version: spec.version ?? "2",
    },
  }));
}

function defaultPayTo(config: TollgateConfig, services: DiscoverService[]): string {
  return (
    services[0]?.payTo ??
    config.payTo ??
    config.seller ??
    "0x0000000000000000000000000000000000000001"
  );
}

/**
 * Origin-hosted x402 discovery manifest for Bazaar / agent crawlers.
 * Reuses {@link buildDiscoverDocument}; lists only real gated routes + MCP tools.
 */
export function buildX402WellKnownDocument(
  config: TollgateConfig,
  now: Date = new Date(),
): X402WellKnownDocument {
  const catalog = buildDiscoverDocument(config, now);
  const base = stripTrailingSlash(config.publicBaseUrl);
  const updatedAt = catalog.updatedAt;
  const payTo = defaultPayTo(config, catalog.services);
  const accepts = primaryAccepts(config, payTo);

  const quoteExt = httpQuoteBazaarExtension();
  const fetchMdExt = httpFetchMdBazaarExtension();

  const resources: X402DiscoveredResource[] = [];

  for (const svc of catalog.services) {
    const svcAccepts = primaryAccepts(config, svc.payTo);
    resources.push({
      resource: svc.endpoint,
      type: "http",
      x402Version: 2,
      lastUpdated: updatedAt,
      accepts: svcAccepts,
      extensions: quoteExt,
    });
  }

  resources.push({
    resource: `${base}/v1/fetch-md`,
    type: "http",
    x402Version: 2,
    lastUpdated: updatedAt,
    accepts,
    extensions: fetchMdExt,
  });

  const mcpUrl = `${base}/mcp`;
  resources.push(
    {
      resource: mcpUrl,
      type: "mcp",
      x402Version: 2,
      lastUpdated: updatedAt,
      accepts,
      extensions: mcpGetQuoteBazaarExtension(),
    },
    {
      resource: mcpUrl,
      type: "mcp",
      x402Version: 2,
      lastUpdated: updatedAt,
      accepts,
      extensions: mcpProxyRequestBazaarExtension(),
    },
    {
      resource: mcpUrl,
      type: "mcp",
      x402Version: 2,
      lastUpdated: updatedAt,
      accepts,
      extensions: mcpFetchMdBazaarExtension(),
    },
  );

  return {
    x402Version: 2,
    name: "x402-micro-tollgate",
    description:
      "Thin self-hosted x402 payment gateway + MCP server. Independent OSS; not a Coinbase product.",
    version: PACKAGE_VERSION,
    network: catalog.network,
    updatedAt,
    publicBaseUrl: base,
    discover: `${base}/x402/discover`,
    source: catalog.source,
    services: catalog.services,
    resources,
  };
}

/**
 * Agent discovery card pointing at live MCP / OpenAPI / llms / x402 surfaces.
 * No contact email or other PII.
 */
export function buildAgentCardDocument(
  config: TollgateConfig,
): AgentCardDocument {
  const base = stripTrailingSlash(config.publicBaseUrl);
  return {
    name: "x402-micro-tollgate",
    description:
      "Self-hosted x402 micropayment gateway and MCP server for USDC pay-per-call HTTP routes and tools. Independent MIT OSS — not an official Coinbase product.",
    version: PACKAGE_VERSION,
    url: base,
    documentationUrl: `${base}/llms.txt`,
    provider: {
      organization: "x402-micro-tollgate (independent OSS)",
      url: "https://github.com/kevin2003050666-coder/x402-micro-tollgate",
    },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      x402: true,
      mcp: true,
    },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/markdown", "text/plain"],
    skills: [
      {
        id: "paid-http-proxy",
        name: "Paid HTTP reverse-proxy",
        description:
          "Gate upstream HTTP routes with HTTP 402 / x402 USDC (default Base).",
        tags: ["x402", "http", "proxy"],
      },
      {
        id: "fetch-md",
        name: "Fetch URL as Markdown",
        description:
          "Paid demo: fetch a public http(s) page and return Markdown (HTTP + MCP).",
        tags: ["x402", "fetch-md", "markdown"],
      },
      {
        id: "mcp-tools",
        name: "Paid MCP tools",
        description:
          "Streamable HTTP MCP at /mcp with paid get_quote, proxy_request, fetch_md.",
        tags: ["mcp", "x402"],
      },
    ],
    discovery: {
      publicBaseUrl: base,
      mcp: `${base}/mcp`,
      openapi: `${base}/openapi.yaml`,
      llmsTxt: `${base}/llms.txt`,
      x402Discover: `${base}/x402/discover`,
      x402WellKnown: `${base}${WELL_KNOWN_X402_PATH}`,
      agentCard: `${base}${WELL_KNOWN_AGENT_CARD_PATH}`,
    },
  };
}
