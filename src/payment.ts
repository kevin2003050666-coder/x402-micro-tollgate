import type { RequestHandler } from "express";
import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { TollgateConfig } from "./config.js";
import { gatedRoutePatterns, isFreePath, isGatedPath } from "./config.js";
import {
  httpFetchMdBazaarExtension,
  httpProxyBazaarExtension,
  httpQuoteBazaarExtension,
} from "./bazaar.js";
import { paymentRequiredJsonBody } from "./payment-required-body.js";

/** Base Sepolia / Base mainnet default USDC (from @x402/evm defaults). */
const DEFAULT_USDC: Record<string, { asset: string; decimals: number }> = {
  "eip155:84532": {
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
  },
  "eip155:8453": {
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
  },
};

function dollarPriceToAtomic(price: string, decimals: number): string {
  const match = price.trim().match(/^\$(\d+(?:\.\d+)?)$/);
  if (!match) {
    return price.trim();
  }
  const [whole, frac = ""] = match[1].split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const atomic = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return atomic || "0";
}

export interface PaymentLayer {
  middleware: RequestHandler;
  mode: "live" | "demo";
  payToEvmAddress?: string;
}

type RouteEntry = {
  price: string;
  networks: string[];
  description: string;
  extensions: Record<string, unknown>;
};

/** Build gated HTTP routes with Bazaar discovery metadata. createX402Server also auto-injects bazaar; explicit extensions override with richer schemas. */
function buildGatedHttpRoutes(config: TollgateConfig): Record<string, RouteEntry> {
  const quoteExt = httpQuoteBazaarExtension();
  const proxyExt = httpProxyBazaarExtension();
  const fetchMdExt = httpFetchMdBazaarExtension();
  const routes: Record<string, RouteEntry> = {
    "GET /v1/quote": {
      price: config.price,
      networks: [config.network],
      description:
        "Sample quote JSON from upstream (or built-in mock). Pay-per-call via x402 USDC.",
      extensions: quoteExt,
    },
    "GET /v1/fetch-md": {
      price: config.price,
      networks: [config.network],
      description:
        "Fetch a public http(s) URL and return Markdown. Pay-per-call via x402 USDC.",
      extensions: fetchMdExt,
    },
  };

  for (const pattern of gatedRoutePatterns(config.gatedPrefix)) {
    if (routes[pattern]) continue;
    routes[pattern] = {
      price: config.price,
      networks: [config.network],
      description:
        "Paid reverse-proxy to UPSTREAM_URL via x402-micro-tollgate. Forwards method, path, query, headers, and body after settlement.",
      extensions: proxyExt,
    };
  }

  return routes;
}

/** Ensure unpaid 402 responses keep protocol headers and include a readable JSON body. */
function withReadable402Body(
  middleware: RequestHandler,
  config: TollgateConfig,
): RequestHandler {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = ((body?: unknown) => {
      if (
        res.statusCode === 402 &&
        (body === undefined ||
          body === null ||
          (typeof body === "object" &&
            !Array.isArray(body) &&
            Object.keys(body as object).length === 0))
      ) {
        return originalJson(paymentRequiredJsonBody(config));
      }
      return originalJson(body);
    }) as typeof res.json;
    return middleware(req, res, next);
  };
}

/**
 * Live CDP facilitator path — official seller pattern.
 * Requires CDP_API_KEY_ID, CDP_API_KEY_SECRET, and X402_PAY_TO.
 * Bazaar: createX402Server auto-injects bazaar; we override with discoverable + schemas.
 */
export async function createLivePaymentLayer(config: TollgateConfig): Promise<PaymentLayer> {
  if (!config.payTo) {
    throw new Error("X402_PAY_TO is required for live facilitator mode");
  }

  const server = await createX402Server({
    environment: config.environment,
    apiKeyId: config.cdpApiKeyId,
    apiKeySecret: config.cdpApiKeySecret,
    payToConfig: {
      type: "address",
      evm: config.payTo,
    },
    routes: buildGatedHttpRoutes(config),
  });

  const raw = paymentMiddlewareFromHTTPServer(
    server as unknown as Parameters<typeof paymentMiddlewareFromHTTPServer>[0],
  );

  return {
    middleware: withReadable402Body(raw, config),
    mode: "live",
    payToEvmAddress: server.payToEvmAddress,
  };
}

/**
 * Demo / offline payment middleware.
 * Returns a protocol-shaped 402 + PAYMENT-REQUIRED (with Bazaar extension) when gated and unpaid.
 */
export function createDemoPaymentLayer(config: TollgateConfig): PaymentLayer {
  const payTo =
    config.payTo ??
    ("0x0000000000000000000000000000000000000001" as `0x${string}`);
  const usdc = DEFAULT_USDC[config.network] ?? DEFAULT_USDC["eip155:84532"]!;
  const amount = dollarPriceToAtomic(config.price, usdc.decimals);
  const quoteExt = httpQuoteBazaarExtension();
  const proxyExt = httpProxyBazaarExtension();
  const fetchMdExt = httpFetchMdBazaarExtension();

  const middleware: RequestHandler = (req, res, next) => {
    if (isFreePath(req.path) || !isGatedPath(req.path, config.gatedPrefix)) {
      next();
      return;
    }

    const signature =
      req.header("payment-signature") ??
      req.header("PAYMENT-SIGNATURE") ??
      "";
    const demo =
      req.header("x-demo-payment")?.toLowerCase() === "settled" ||
      signature === "demo-settled";

    if (demo) {
      res.setHeader(
        "PAYMENT-RESPONSE",
        Buffer.from(
          JSON.stringify({
            success: true,
            demo: true,
            network: config.network,
            payer: "demo",
          }),
          "utf8",
        ).toString("base64"),
      );
      next();
      return;
    }

    const resourcePath = req.path === "/v1/quote" ? "/v1/quote" : req.path;
    const resourceUrl = `${config.publicBaseUrl}${resourcePath}`;
    const bazaar =
      req.path === "/v1/quote" || req.path === "/quote"
        ? quoteExt.bazaar
        : req.path === "/v1/fetch-md"
          ? fetchMdExt.bazaar
          : proxyExt.bazaar;

    const description =
      req.path === "/v1/quote"
        ? "Sample quote JSON from upstream (or built-in mock). Pay-per-call via x402 USDC."
        : req.path === "/v1/fetch-md"
          ? "Fetch a public http(s) URL and return Markdown. Pay-per-call via x402 USDC."
          : "Paid reverse-proxy to UPSTREAM_URL via x402-micro-tollgate.";

    const paymentRequired = {
      x402Version: 2 as const,
      error: "Payment required",
      resource: {
        url: resourceUrl,
        description,
        mimeType: "application/json",
        serviceName: "x402-micro-tollgate",
        tags: ["x402", "gateway", "proxy", "bazaar"],
      },
      accepts: [
        {
          scheme: "exact",
          network: config.network as `${string}:${string}`,
          amount,
          asset: usdc.asset,
          payTo,
          maxTimeoutSeconds: 300,
          extra: {
            name: "USDC",
            version: "2",
          },
        },
      ],
      extensions: {
        bazaar,
      },
    };

    res
      .status(402)
      .setHeader(
        "PAYMENT-REQUIRED",
        encodePaymentRequiredHeader(
          paymentRequired as Parameters<typeof encodePaymentRequiredHeader>[0],
        ),
      )
      .setHeader("Cache-Control", "no-store")
      .json(paymentRequiredJsonBody(config));
  };

  return {
    middleware: withReadable402Body(middleware, config),
    mode: "demo",
    payToEvmAddress: payTo,
  };
}

export async function createPaymentLayer(config: TollgateConfig): Promise<PaymentLayer> {
  if (config.useLiveFacilitator) {
    return createLivePaymentLayer(config);
  }
  return createDemoPaymentLayer(config);
}
