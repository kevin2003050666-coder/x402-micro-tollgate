import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

/** Shared Bazaar declarations for HTTP gated routes and MCP paid tools. */

/**
 * SDK typings omit `method` from DeclareDiscoveryExtensionInput (DistributiveOmit),
 * but the runtime helper and JSDoc still accept HTTP method — pass via cast.
 */
function declareHttpDiscovery(
  config: {
    method: "GET" | "HEAD" | "DELETE" | "POST" | "PUT" | "PATCH";
    input?: Record<string, unknown>;
    inputSchema?: Record<string, unknown>;
    bodyType?: "json" | "form-data" | "text";
    output?: { example?: unknown; schema?: Record<string, unknown> };
  },
) {
  return declareDiscoveryExtension(
    config as Parameters<typeof declareDiscoveryExtension>[0],
  );
}

function withDiscoverable(declared: Record<string, unknown>) {
  const bazaar = declared.bazaar as Record<string, unknown>;
  return {
    bazaar: {
      ...bazaar,
      discoverable: true,
    },
  };
}

export function httpQuoteBazaarExtension() {
  return withDiscoverable(
    declareHttpDiscovery({
      method: "GET",
      input: {},
      inputSchema: {
        properties: {},
        additionalProperties: false,
      },
      output: {
        example: {
          symbol: "ETH-USD",
          price: 3245.67,
          currency: "USD",
          source: "x402-micro-tollgate",
        },
        schema: {
          type: "object",
          properties: {
            symbol: { type: "string", description: "Trading pair symbol" },
            price: { type: "number", description: "Quoted price" },
            currency: { type: "string" },
            source: { type: "string" },
            at: { type: "string", description: "ISO timestamp" },
          },
        },
      },
    }),
  );
}

export function httpProxyBazaarExtension() {
  return withDiscoverable(
    declareHttpDiscovery({
      method: "GET",
      input: {},
      inputSchema: {
        properties: {},
        additionalProperties: true,
      },
      output: {
        example: { message: "Mock upstream OK" },
        schema: {
          type: "object",
          additionalProperties: true,
        },
      },
    }),
  );
}

export function httpFetchMdBazaarExtension() {
  return withDiscoverable(
    declareHttpDiscovery({
      method: "GET",
      input: { url: "https://example.com" },
      inputSchema: {
        properties: {
          url: {
            type: "string",
            description: "Public http(s) URL to fetch and convert to Markdown",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
      output: {
        example: {
          url: "https://example.com",
          title: "Example Domain",
          markdown: "# Example Domain\n\nThis domain is for use in illustrative examples.",
        },
        schema: {
          type: "object",
          properties: {
            url: { type: "string" },
            title: { type: "string" },
            markdown: { type: "string" },
          },
          required: ["url", "markdown"],
        },
      },
    }),
  );
}

export function mcpGetQuoteBazaarExtension() {
  return withDiscoverable(
    declareDiscoveryExtension({
      toolName: "get_quote",
      description:
        "Fetch /v1/quote from the configured upstream (or built-in mock). Requires x402 USDC payment.",
      transport: "streamable-http",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      example: {},
      output: {
        example: {
          status: 200,
          body: { symbol: "ETH-USD", price: 3245.67, currency: "USD" },
        },
        schema: {
          type: "object",
          properties: {
            status: { type: "number" },
            body: { type: "object" },
          },
        },
      },
    }),
  );
}

export function mcpProxyRequestBazaarExtension() {
  return withDiscoverable(
    declareDiscoveryExtension({
      toolName: "proxy_request",
      description:
        "Forward method/path/query/headers/body to UPSTREAM_URL (or mock) after x402 payment.",
      transport: "streamable-http",
      inputSchema: {
        type: "object",
        properties: {
          method: {
            type: "string",
            description: "HTTP method (GET, POST, PUT, PATCH, DELETE, …)",
            default: "GET",
          },
          path: {
            type: "string",
            description: "Upstream path, e.g. /v1/quote",
          },
          query: {
            type: "object",
            description: "Optional query string parameters",
            additionalProperties: true,
          },
          headers: {
            type: "object",
            description: "Optional request headers (payment headers stripped)",
            additionalProperties: { type: "string" },
          },
          body: {
            description: "Optional JSON body for non-GET requests",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      example: { method: "GET", path: "/v1/quote" },
      output: {
        example: {
          status: 200,
          method: "GET",
          path: "/v1/quote",
          body: { symbol: "ETH-USD", price: 3245.67 },
        },
        schema: {
          type: "object",
          properties: {
            status: { type: "number" },
            method: { type: "string" },
            path: { type: "string" },
            body: {},
          },
        },
      },
    }),
  );
}
