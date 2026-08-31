import type { TollgateConfig } from "./config.js";

export interface MockUpstreamResult {
  status: number;
  body: unknown;
}

/** Shared mock upstream used by HTTP proxy and MCP tools. */
export function mockUpstreamResponse(
  method: string,
  path: string,
  query?: Record<string, unknown>,
  body?: unknown,
): MockUpstreamResult {
  const upper = method.toUpperCase();
  if (upper === "GET" && (path === "/v1/quote" || path === "/quote")) {
    return {
      status: 200,
      body: {
        symbol: "ETH-USD",
        price: 3245.67,
        currency: "USD",
        source: "x402-micro-tollgate-mock",
        at: new Date().toISOString(),
      },
    };
  }

  if (upper === "GET" && path.startsWith("/v1/")) {
    return {
      status: 200,
      body: {
        path,
        query: query ?? {},
        message: "Mock upstream OK",
        at: new Date().toISOString(),
      },
    };
  }

  if (upper === "POST" && path.startsWith("/v1/")) {
    return {
      status: 201,
      body: {
        path,
        received: body ?? null,
        message: "Mock upstream accepted",
        at: new Date().toISOString(),
      },
    };
  }

  return {
    status: 404,
    body: {
      error: {
        code: "mock_not_found",
        message: `No mock handler for ${upper} ${path}`,
      },
    },
  };
}

export async function forwardUpstreamRequest(
  config: TollgateConfig,
  args: {
    method: string;
    path: string;
    query?: Record<string, string | number | boolean | null | undefined>;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<MockUpstreamResult> {
  const path = args.path.startsWith("/") ? args.path : `/${args.path}`;

  if (!config.upstreamUrl) {
    return mockUpstreamResponse(args.method, path, args.query as Record<string, unknown> | undefined, args.body);
  }

  const url = new URL(path, config.upstreamUrl.endsWith("/") ? config.upstreamUrl : `${config.upstreamUrl}/`);
  if (args.query) {
    for (const [key, value] of Object.entries(args.query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = { ...(args.headers ?? {}) };
  delete headers["payment-signature"];
  delete headers["PAYMENT-SIGNATURE"];
  delete headers["x-demo-payment"];
  delete headers.host;
  delete headers.Host;

  const init: RequestInit = {
    method: args.method.toUpperCase(),
    headers,
  };

  if (args.body !== undefined && args.method.toUpperCase() !== "GET" && args.method.toUpperCase() !== "HEAD") {
    if (!headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
    init.body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  }

  const response = await fetch(url, init);
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }

  return { status: response.status, body: parsed };
}
