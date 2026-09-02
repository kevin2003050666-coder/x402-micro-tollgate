import type { Request, RequestHandler, Response } from "express";
import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import {
  decodePaymentRequiredHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import type { TollgateConfig } from "./config.js";
import { gatedRoutePatterns, isFreePath, isGatedPath } from "./config.js";
import {
  httpFetchMdBazaarExtension,
  httpProxyBazaarExtension,
  httpQuoteBazaarExtension,
} from "./bazaar.js";
import { paymentRequiredJsonBody } from "./payment-required-body.js";
import {
  merchantIdFromRequest,
  resolveMerchant,
  rewritePaymentRequiredPayTo,
  type MerchantEntry,
} from "./merchants.js";
import {
  SignatureDedupeCache,
  withPaymentSignatureDedupe,
  type PaymentDedupeStore,
} from "./payment-dedupe.js";
import { resolvePayTo } from "./resolve-pay-to.js";

/** Base Sepolia / Base mainnet default USDC (from @x402/evm defaults). */
export const DEFAULT_USDC: Record<string, { asset: `0x${string}`; decimals: number }> = {
  "eip155:84532": {
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
  },
  "eip155:8453": {
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
  },
};

function usdcForNetwork(network: string): { asset: `0x${string}`; decimals: number } {
  return DEFAULT_USDC[network] ?? DEFAULT_USDC["eip155:84532"]!;
}

/** Resolve permissionless seller payTo from amount + config (threshold / CREATE2). */
export function resolveSellerPayTo(
  config: TollgateConfig,
  amountAtomic: bigint | string,
): `0x${string}` {
  if (!config.seller) {
    throw new Error("seller is not configured");
  }
  const usdc = usdcForNetwork(config.network);
  return resolvePayTo({
    amountAtomic,
    seller: config.seller,
    feeFreeBelowUsdc: config.feeFreeBelowUsdc,
    factoryAddress: config.factoryAddress,
    feeCollector: config.feeCollector,
    asset: usdc.asset,
    feeBps: config.feeBps,
  });
}

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

/** Request locals set by merchant gate / rewrite wrappers. */
export type MerchantLocals = {
  merchantId?: string;
  merchant?: MerchantEntry;
  /** Permissionless seller path (no registry entry). */
  sellerMode?: boolean;
};

type RequestWithMerchant = Request & {
  merchantId?: string;
  merchant?: MerchantEntry;
  sellerMode?: boolean;
};

function setMerchantLocals(
  req: Request,
  id: string,
  merchant: MerchantEntry,
): void {
  const locals = req as RequestWithMerchant;
  locals.merchantId = id;
  locals.merchant = merchant;
  locals.sellerMode = false;
}

function setSellerModeLocals(req: Request): void {
  const locals = req as RequestWithMerchant;
  locals.merchantId = undefined;
  locals.merchant = undefined;
  locals.sellerMode = true;
}

function getMerchantLocals(req: Request): MerchantLocals {
  const locals = req as RequestWithMerchant;
  return {
    merchantId: locals.merchantId,
    merchant: locals.merchant,
    sellerMode: locals.sellerMode,
  };
}

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

/**
 * Public resource URL for Bazaar / PAYMENT-REQUIRED.
 * Prefer PUBLIC_BASE_URL so TLS terminators (Render) never advertise http://.
 * Preserves path + query (fetch-md needs ?url=).
 */
export function buildPublicResourceUrl(
  config: TollgateConfig,
  req: Pick<Request, "originalUrl">,
): string {
  const pathAndQuery = req.originalUrl.startsWith("/")
    ? req.originalUrl
    : `/${req.originalUrl}`;
  return `${config.publicBaseUrl}${pathAndQuery}`;
}

/**
 * On gated paths: resolve merchant (query `merchant` / header `x-merchant-id` /
 * DEFAULT_MERCHANT) **or** permissionless seller mode when `config.seller` is set.
 * Unknown merchant → 400 `{error:"unknown_merchant"}`. Free paths pass through.
 *
 * When `REQUIRE_MERCHANT=true`, omitting merchant id → 400 `{error:"merchant_required"}`
 * (hosted multi-tenant harden — still applies if seller is unset).
 *
 * Permissionless: with `SELLER` / `x402Tollgate({ seller })` and no `?merchant=`,
 * registry is not required.
 */
export function withMerchantGate(
  middleware: RequestHandler,
  config: TollgateConfig,
): RequestHandler {
  return (req, res, next) => {
    if (isFreePath(req.path) || !isGatedPath(req.path, config.gatedPrefix)) {
      return middleware(req, res, next);
    }

    const explicit = merchantIdFromRequest(req, "");
    const hasRegistry = Object.keys(config.merchants).length > 0;

    if (config.requireMerchant && !explicit) {
      res.status(400).json({ error: "merchant_required" });
      return;
    }

    // Explicit ?merchant= / header → registry (hosted multi-tenant compat).
    if (explicit) {
      if (!hasRegistry || !config.merchants[explicit]) {
        res.status(400).json({ error: "unknown_merchant" });
        return;
      }
      setMerchantLocals(req, explicit, config.merchants[explicit]!);
      return middleware(req, res, next);
    }

    // Permissionless seller path — no registry lookup required.
    if (config.seller) {
      setSellerModeLocals(req);
      return middleware(req, res, next);
    }

    // Legacy hosted: default merchant from registry.
    if (!hasRegistry) {
      res.status(500).json({
        error: "config_error",
        message: "No seller (SELLER/X402_SELLER) and no MERCHANTS_JSON registry configured",
      });
      return;
    }

    const resolved = resolveMerchant(req, config.merchants, config.defaultMerchant);
    if (!resolved.ok) {
      res.status(400).json({ error: "unknown_merchant" });
      return;
    }

    setMerchantLocals(req, resolved.id, resolved.merchant);
    return middleware(req, res, next);
  };
}

/**
 * Live SDK builds resource.url via ExpressAdapter.getUrl() =
 * `${req.protocol}://${host}${originalUrl}`. Behind Render, Node sees http
 * unless trust proxy is on. createX402Server has a single global payTo — rewrite
 * PAYMENT-REQUIRED resource.url to PUBLIC_BASE_URL and accepts[].payTo to the
 * resolved merchant FeeSplitter after the SDK sets the header.
 */
export function withPublicResourceUrl(
  middleware: RequestHandler,
  config: TollgateConfig,
): RequestHandler {
  return (req, res, next) => {
    const rewrite = (value: unknown): unknown => {
      if (typeof value !== "string" || !value) return value;
      try {
        const decoded = decodePaymentRequiredHeader(value);
        if (!decoded.resource || typeof decoded.resource !== "object") {
          return value;
        }
        const resource = decoded.resource as { url?: string } & Record<string, unknown>;
        resource.url = buildPublicResourceUrl(config, req);

        // CDP SDK payTo is global; per-request payTo is applied here.
        // Registry merchant → fixed FeeSplitter. Seller mode → threshold resolver.
        const { merchant, sellerMode } = getMerchantLocals(req);
        if (merchant?.payTo) {
          rewritePaymentRequiredPayTo(
            decoded as unknown as Record<string, unknown>,
            merchant.payTo,
          );
        } else if (sellerMode && config.seller) {
          const accepts = (decoded as { accepts?: Array<{ amount?: string }> }).accepts;
          const amount = accepts?.[0]?.amount ?? "0";
          const payTo = resolveSellerPayTo(config, amount);
          rewritePaymentRequiredPayTo(
            decoded as unknown as Record<string, unknown>,
            payTo,
          );
        }

        return encodePaymentRequiredHeader(
          decoded as Parameters<typeof encodePaymentRequiredHeader>[0],
        );
      } catch {
        return value;
      }
    };

    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: unknown) => {
      if (String(name).toLowerCase() === "payment-required") {
        value = rewrite(value);
      }
      return originalSetHeader(name, value as string);
    }) as Response["setHeader"];

    const originalAppend = res.appendHeader?.bind(res);
    if (originalAppend) {
      res.appendHeader = ((name: string, value: string | readonly string[]) => {
        if (String(name).toLowerCase() === "payment-required") {
          if (Array.isArray(value)) {
            value = value.map((v) => String(rewrite(v)));
          } else {
            value = String(rewrite(value));
          }
        }
        return originalAppend(name, value);
      }) as Response["appendHeader"];
    }

    return middleware(req, res, next);
  };
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

function wrapPaymentMiddleware(
  raw: RequestHandler,
  config: TollgateConfig,
  dedupeCache?: SignatureDedupeCache,
  dedupeStore?: PaymentDedupeStore,
): RequestHandler {
  // Order: merchant gate → payment idempotency / settle-latency guard → readable 402 / public URL → settle.
  //
  // Idempotency policy (see payment-dedupe.ts):
  // - Mutex per PAYMENT-SIGNATURE fingerprint, then PaymentDedupeStore (set-if-absent).
  // - Mark durable settled only after facilitator settle success; hold short-lived lock during settle.
  // - Settle wait uses config.settleTimeoutMs (minutes-scale). On timeout → 202 payment_pending +
  //   retry_with_same_proof (never treat buyer payment as failed solely due to HTTP timeout).
  // - CDP facilitator EIP-3009 nonce remains the on-chain source of truth.
  return withMerchantGate(
    withPaymentSignatureDedupe(
      withReadable402Body(withPublicResourceUrl(raw, config), config),
      {
        cache: dedupeCache,
        store: dedupeStore ?? dedupeCache?.getStore(),
        ttlMs: config.paymentDedupeTtlMs,
        maxEntries: config.paymentDedupeMaxEntries,
        gatedPrefix: config.gatedPrefix,
        settleTimeoutMs: config.settleTimeoutMs,
        verifyTimeoutMs: config.verifyTimeoutMs,
      },
    ),
    config,
  );
}

/**
 * Live CDP facilitator path — official seller pattern.
 * Requires CDP_API_KEY_ID, CDP_API_KEY_SECRET, and X402_PAY_TO (or default merchant payTo).
 * Bazaar: createX402Server auto-injects bazaar; we override with discoverable + schemas.
 * Per-request merchant payTo is applied via PAYMENT-REQUIRED header rewrite (SDK payTo is global).
 */
export async function createLivePaymentLayer(config: TollgateConfig): Promise<PaymentLayer> {
  if (!config.payTo) {
    throw new Error("X402_PAY_TO is required for live facilitator mode");
  }

  // Fail fast if seller mode price is ≥ threshold without factory (would 500 on every 402).
  if (config.seller) {
    const usdc = usdcForNetwork(config.network);
    const amount = dollarPriceToAtomic(config.price, usdc.decimals);
    resolveSellerPayTo(config, amount);
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
    middleware: wrapPaymentMiddleware(raw, config, new SignatureDedupeCache({
      ttlMs: config.paymentDedupeTtlMs,
      maxEntries: config.paymentDedupeMaxEntries,
    })),
    mode: "live",
    payToEvmAddress: server.payToEvmAddress,
  };
}

/**
 * Demo / offline payment middleware.
 * Returns a protocol-shaped 402 + PAYMENT-REQUIRED (with Bazaar extension) when gated and unpaid.
 * Uses resolved merchant FeeSplitter, or permissionless seller resolvePayTo, as payTo.
 */
export function createDemoPaymentLayer(config: TollgateConfig): PaymentLayer {
  // Fail fast for misconfigured ≥ threshold seller mode (missing FACTORY_ADDRESS).
  if (config.seller) {
    const usdc = usdcForNetwork(config.network);
    const amount = dollarPriceToAtomic(config.price, usdc.decimals);
    resolveSellerPayTo(config, amount);
  }

  const fallbackPayTo =
    config.payTo ??
    config.seller ??
    config.merchants[config.defaultMerchant]?.payTo ??
    ("0x0000000000000000000000000000000000000001" as `0x${string}`);
  const usdc = usdcForNetwork(config.network);
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

    const { merchant, sellerMode } = getMerchantLocals(req);
    let payTo: `0x${string}`;
    try {
      if (merchant?.payTo) {
        payTo = merchant.payTo;
      } else if (sellerMode && config.seller) {
        payTo = resolveSellerPayTo(config, amount);
      } else {
        payTo = fallbackPayTo;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "payTo resolution failed";
      res.status(500).json({ error: "config_error", message });
      return;
    }

    const resourceUrl = buildPublicResourceUrl(config, req);
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
    middleware: wrapPaymentMiddleware(
      middleware,
      config,
      new SignatureDedupeCache({
        ttlMs: config.paymentDedupeTtlMs,
        maxEntries: config.paymentDedupeMaxEntries,
      }),
    ),
    mode: "demo",
    payToEvmAddress: fallbackPayTo,
  };
}

export async function createPaymentLayer(config: TollgateConfig): Promise<PaymentLayer> {
  if (config.useLiveFacilitator) {
    return createLivePaymentLayer(config);
  }
  return createDemoPaymentLayer(config);
}
