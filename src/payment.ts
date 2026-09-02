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
  buildPaywallConfig,
  createTollgatePaywall,
  isBrowserPaymentRequest,
} from "./paywall.js";
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
import {
  atomicUsdcToDollarPrice,
  createGasFloorService,
  dollarPriceToAtomic as dollarPriceToAtomicBigint,
  type GasFloorService,
} from "./gas-floor.js";
import {
  isEip155,
  isSolana,
  usdcForNetwork,
  type AcceptSpec,
} from "./networks.js";

/** @deprecated Import from `./networks.js`. */
export { DEFAULT_USDC } from "./networks.js";
export { usdcForNetwork } from "./networks.js";

function dollarPriceToAtomic(price: string, decimals: number = 6): string {
  return dollarPriceToAtomicBigint(price, decimals).toString();
}

export interface PaymentLayerOptions {
  /** Shared gas-floor service (tests / app). Created from config when omitted. */
  gasFloor?: GasFloorService;
}

export type ResolveSellerPayToOptions = {
  feeFreeBelowUsdc?: bigint;
  network?: string;
  asset?: `0x${string}`;
};

/** Resolve permissionless seller payTo from amount + config (threshold / CREATE2). */
export function resolveSellerPayTo(
  config: TollgateConfig,
  amountAtomic: bigint | string,
  networkOrOptions: string | ResolveSellerPayToOptions = config.network,
  assetOverride?: `0x${string}`,
): `0x${string}` {
  if (!config.seller) {
    throw new Error("seller is not configured");
  }

  let network = config.network;
  let feeFreeBelowUsdc = config.feeFreeBelowUsdc;
  let asset: `0x${string}` | undefined = assetOverride;

  if (typeof networkOrOptions === "string") {
    network = networkOrOptions;
  } else if (networkOrOptions && typeof networkOrOptions === "object") {
    feeFreeBelowUsdc = networkOrOptions.feeFreeBelowUsdc ?? feeFreeBelowUsdc;
    network = networkOrOptions.network ?? network;
    asset = networkOrOptions.asset ?? asset;
  }

  if (!isEip155(network)) {
    throw new Error(`FeeSplitter / seller CREATE2 is EVM-only (got ${network})`);
  }
  const usdc = usdcForNetwork(network);
  const resolvedAsset = asset ?? usdc.asset;
  const factoryAddress =
    config.factoryAddresses[network] ??
    (network === config.network ? config.factoryAddress : undefined);
  return resolvePayTo({
    amountAtomic,
    seller: config.seller,
    feeFreeBelowUsdc,
    factoryAddress,
    feeCollector: config.feeCollector,
    asset: resolvedAsset,
    feeBps: config.feeBps,
  });
}

function resolveAcceptPayTo(
  config: TollgateConfig,
  spec: AcceptSpec,
  merchantPayTo: `0x${string}` | undefined,
  sellerMode: boolean | undefined,
  amountAtomic: string,
  feeFreeBelowUsdc?: bigint,
): string {
  if (spec.payTo) return spec.payTo;
  if (merchantPayTo) return merchantPayTo;
  if (sellerMode && config.seller && isEip155(spec.network)) {
    return resolveSellerPayTo(config, amountAtomic, {
      network: spec.network,
      asset: isEip155(spec.network) ? (spec.asset as `0x${string}`) : undefined,
      feeFreeBelowUsdc,
    });
  }
  if (isSolana(spec.network)) {
    const sol = config.solanaPayTo ?? spec.payTo;
    if (!sol) {
      throw new Error("Solana accept missing SOLANA_PAY_TO / payTo");
    }
    return sol;
  }
  return (
    config.payTo ??
    config.seller ??
    config.merchants[config.defaultMerchant]?.payTo ??
    "0x0000000000000000000000000000000000000001"
  );
}

/** Scale a 6-decimal USDC atomic floor to another token's decimals. */
function scaleUsdc6Floor(floor6: bigint, decimals: number): bigint {
  if (decimals === 6) return floor6;
  if (decimals > 6) return floor6 * 10n ** BigInt(decimals - 6);
  return floor6 / 10n ** BigInt(6 - decimals);
}

export function buildAcceptEntries(
  config: TollgateConfig,
  opts: {
    merchantPayTo?: `0x${string}`;
    sellerMode?: boolean;
    fallbackPayTo: string;
    feeFreeBelowUsdc?: bigint;
    /** Gas / static floor in 6-decimal USDC atomic units. */
    minAmountAtomic?: bigint;
  },
): Array<Record<string, unknown>> {
  const specs =
    config.accepts.length > 0
      ? config.accepts
      : [
          {
            network: config.network,
            symbol: "USDC" as const,
            asset: usdcForNetwork(config.network).asset,
            decimals: 6,
            name: "USDC",
            version: "2",
            transferMethod: "eip3009" as const,
            status: "live" as const,
          },
        ];

  return specs.map((spec) => {
    let amount = dollarPriceToAtomic(config.price, spec.decimals);
    if (opts.minAmountAtomic !== undefined && opts.minAmountAtomic > 0n) {
      const floor = scaleUsdc6Floor(opts.minAmountAtomic, spec.decimals);
      const current = BigInt(amount);
      if (current < floor) amount = floor.toString();
    }
    let payTo: string;
    try {
      payTo = resolveAcceptPayTo(
        config,
        spec,
        opts.merchantPayTo,
        opts.sellerMode,
        amount,
        opts.feeFreeBelowUsdc,
      );
    } catch {
      payTo = opts.fallbackPayTo;
    }
    const extra: Record<string, unknown> = {
      name: spec.name,
      version: spec.version ?? "2",
    };
    if (spec.transferMethod === "permit2") {
      extra.assetTransferMethod = "permit2";
    }
    return {
      scheme: "exact",
      network: spec.network as `${string}:${string}`,
      amount,
      asset: spec.asset,
      payTo,
      maxTimeoutSeconds: 300,
      extra,
    };
  });
}

export interface PaymentLayer {
  middleware: RequestHandler;
  mode: "live" | "demo";
  payToEvmAddress?: string;
  /** Present when created via createPaymentLayer / createDemoPaymentLayer. */
  gasFloor?: GasFloorService;
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
  // Live CDP createX402Server is EVM-oriented; advertise EVM networks from accepts.
  const fromAccepts = config.accepts
    .map((a) => a.network)
    .filter((n) => isEip155(n));
  const networks =
    fromAccepts.length > 0
      ? [...new Set(fromAccepts)]
      : config.networks.filter(isEip155).length > 0
        ? config.networks.filter(isEip155)
        : [config.network];
  const routes: Record<string, RouteEntry> = {
    "GET /v1/quote": {
      price: config.price,
      networks,
      description:
        "Sample quote JSON from upstream (or built-in mock). Pay-per-call via x402 USDC.",
      extensions: quoteExt,
    },
    "GET /v1/fetch-md": {
      price: config.price,
      networks,
      description:
        "Fetch a public http(s) URL and return Markdown. Pay-per-call via x402 USDC.",
      extensions: fetchMdExt,
    },
  };

  for (const pattern of gatedRoutePatterns(config.gatedPrefix)) {
    if (routes[pattern]) continue;
    routes[pattern] = {
      price: config.price,
      networks,
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
 *
 * Also enforces the gas-aware minimum accept amount when the floor is active
 * (rewrites accepts[].amount upward; does not lower).
 */
export function withPublicResourceUrl(
  middleware: RequestHandler,
  config: TollgateConfig,
  gasFloor?: GasFloorService,
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

        const mins = gasFloor?.getSnapshotSync();
        const accepts = (
          decoded as {
            accepts?: Array<{
              amount?: string;
              network?: string;
              asset?: string;
              payTo?: string;
              recipient?: string;
            }>;
          }
        ).accepts;
        if (mins && Array.isArray(accepts)) {
          const floor = mins.effectiveMinPriceAtomic;
          for (const accept of accepts) {
            if (!accept || accept.amount === undefined) continue;
            try {
              const current = BigInt(accept.amount);
              // Live SDK amounts are typically 6-decimal USDC; bump when below floor.
              if (current < floor) {
                accept.amount = floor.toString();
              }
            } catch {
              // leave non-numeric amounts alone
            }
          }
        }

        // CDP SDK payTo is global; per-request payTo is applied here.
        // Registry merchant → fixed FeeSplitter. Seller mode → threshold resolver.
        const { merchant, sellerMode } = getMerchantLocals(req);
        if (merchant?.payTo) {
          rewritePaymentRequiredPayTo(
            decoded as unknown as Record<string, unknown>,
            merchant.payTo,
          );
        } else if (sellerMode && config.seller) {
          if (Array.isArray(accepts)) {
            for (const entry of accepts) {
              if (!entry || typeof entry !== "object") continue;
              const amount = entry.amount ?? "0";
              const net = entry.network ?? config.network;
              if (!isEip155(net)) continue;
              const asset =
                entry.asset && /^0x[a-fA-F0-9]{40}$/.test(String(entry.asset))
                  ? (entry.asset as `0x${string}`)
                  : undefined;
              const payTo = resolveSellerPayTo(config, amount, {
                network: net,
                asset,
                feeFreeBelowUsdc: mins?.effectiveFeeFreeBelowUsdc,
              });
              entry.payTo = payTo;
              if (entry.recipient !== undefined) {
                entry.recipient = payTo;
              }
            }
          }
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
  gasFloor?: GasFloorService,
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
        const price = gasFloor?.getSnapshotSync().effectiveMinPrice;
        return originalJson(paymentRequiredJsonBody(config, price ? { price } : undefined));
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
  gasFloor?: GasFloorService,
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
      withReadable402Body(withPublicResourceUrl(raw, config, gasFloor), config, gasFloor),
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
export async function createLivePaymentLayer(
  config: TollgateConfig,
  options: PaymentLayerOptions = {},
): Promise<PaymentLayer> {
  if (!config.payTo) {
    throw new Error("X402_PAY_TO is required for live facilitator mode");
  }

  const gasFloor = options.gasFloor ?? createGasFloorService(config);

  // Fail fast if seller mode price is ≥ threshold without factory (would 500 on every 402).
  if (config.seller) {
    const mins = gasFloor.getSnapshotSync();
    for (const spec of config.accepts) {
      if (!isEip155(spec.network)) continue;
      const amount = dollarPriceToAtomic(config.price, spec.decimals);
      resolveSellerPayTo(config, amount, {
        network: spec.network,
        asset: spec.asset as `0x${string}`,
        feeFreeBelowUsdc: mins.effectiveFeeFreeBelowUsdc,
      });
      resolveSellerPayTo(config, mins.effectiveMinPriceAtomic.toString(), {
        network: spec.network,
        asset: spec.asset as `0x${string}`,
        feeFreeBelowUsdc: mins.effectiveFeeFreeBelowUsdc,
      });
    }
  }

  // Advertise at least the static min floor in route config; gas bumps rewrite at 402 time.
  const routeConfig =
    config.minPriceUsdc > 0n
      ? {
          ...config,
          price: (() => {
            const priceAtomic = dollarPriceToAtomicBigint(config.price);
            const floor =
              priceAtomic > config.minPriceUsdc ? priceAtomic : config.minPriceUsdc;
            return atomicUsdcToDollarPrice(floor);
          })(),
        }
      : config;

  const server = await createX402Server({
    environment: config.environment,
    apiKeyId: config.cdpApiKeyId,
    apiKeySecret: config.cdpApiKeySecret,
    payToConfig: {
      type: "address",
      evm: config.payTo,
    },
    routes: buildGatedHttpRoutes(routeConfig),
  });

  const paywallConfig = buildPaywallConfig(config);
  const paywall = createTollgatePaywall(config);
  const raw = paymentMiddlewareFromHTTPServer(
    server as unknown as Parameters<typeof paymentMiddlewareFromHTTPServer>[0],
    paywallConfig,
    paywall,
  );

  return {
    middleware: wrapPaymentMiddleware(
      raw,
      config,
      new SignatureDedupeCache({
        ttlMs: config.paymentDedupeTtlMs,
        maxEntries: config.paymentDedupeMaxEntries,
      }),
      undefined,
      gasFloor,
    ),
    mode: "live",
    payToEvmAddress: server.payToEvmAddress,
    gasFloor,
  };
}

/**
 * Demo / offline payment middleware.
 * Returns a protocol-shaped 402 + PAYMENT-REQUIRED (with Bazaar extension) when gated and unpaid.
 * Uses resolved merchant FeeSplitter, or permissionless seller resolvePayTo, as payTo.
 */
export function createDemoPaymentLayer(
  config: TollgateConfig,
  options: PaymentLayerOptions = {},
): PaymentLayer {
  const gasFloor = options.gasFloor ?? createGasFloorService(config);

  // Fail fast for misconfigured ≥ threshold seller mode (missing FACTORY_ADDRESS).
  if (config.seller) {
    const mins = gasFloor.getSnapshotSync();
    for (const spec of config.accepts) {
      if (!isEip155(spec.network)) continue;
      const amount = dollarPriceToAtomic(config.price, spec.decimals);
      resolveSellerPayTo(config, amount, {
        network: spec.network,
        asset: spec.asset as `0x${string}`,
        feeFreeBelowUsdc: mins.effectiveFeeFreeBelowUsdc,
      });
      resolveSellerPayTo(config, mins.effectiveMinPriceAtomic.toString(), {
        network: spec.network,
        asset: spec.asset as `0x${string}`,
        feeFreeBelowUsdc: mins.effectiveFeeFreeBelowUsdc,
      });
    }
  }

  const fallbackPayTo =
    config.payTo ??
    config.seller ??
    config.merchants[config.defaultMerchant]?.payTo ??
    ("0x0000000000000000000000000000000000000001" as `0x${string}`);
  const quoteExt = httpQuoteBazaarExtension();
  const proxyExt = httpProxyBazaarExtension();
  const fetchMdExt = httpFetchMdBazaarExtension();
  const paywall = createTollgatePaywall(config);
  const paywallConfig = buildPaywallConfig(config);

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

    // Warm oracle in background when enabled; sync snapshot uses cache (or static floors).
    if (config.dynamicMinEnabled) {
      void gasFloor.refresh();
    }
    const mins = gasFloor.getSnapshotSync();
    const amount = mins.effectiveMinPriceAtomic.toString();

    const { merchant, sellerMode } = getMerchantLocals(req);
    const fallbackPayToLocal =
      merchant?.payTo ??
      (sellerMode && config.seller ? config.seller : undefined) ??
      fallbackPayTo;

    let accepts: Array<Record<string, unknown>>;
    try {
      accepts = buildAcceptEntries(config, {
        merchantPayTo: merchant?.payTo,
        sellerMode,
        fallbackPayTo: fallbackPayToLocal,
        feeFreeBelowUsdc: mins.effectiveFeeFreeBelowUsdc,
        minAmountAtomic: mins.effectiveMinPriceAtomic,
      });
      if (accepts.length === 0) {
        throw new Error("No payment accepts configured");
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
      accepts,
      extensions: {
        bazaar,
      },
    };

    const paymentRequiredHeader = encodePaymentRequiredHeader(
      paymentRequired as unknown as Parameters<typeof encodePaymentRequiredHeader>[0],
    );

    res
      .status(402)
      .setHeader("PAYMENT-REQUIRED", paymentRequiredHeader)
      .setHeader("Cache-Control", "no-store");

    // Browser path: thin Smart Wallet paywall HTML. Agents/MCP keep JSON.
    if (isBrowserPaymentRequest(req)) {
      const html = paywall.generateHtml(
        paymentRequired as unknown as Parameters<typeof paywall.generateHtml>[0],
        paywallConfig,
      );
      res.type("html").send(html);
      return;
    }

    res.json(paymentRequiredJsonBody(config, { price: mins.effectiveMinPrice }));
  };

  return {
    middleware: wrapPaymentMiddleware(
      middleware,
      config,
      new SignatureDedupeCache({
        ttlMs: config.paymentDedupeTtlMs,
        maxEntries: config.paymentDedupeMaxEntries,
      }),
      undefined,
      gasFloor,
    ),
    mode: "demo",
    payToEvmAddress: fallbackPayTo,
    gasFloor,
  };
}

export async function createPaymentLayer(
  config: TollgateConfig,
  options: PaymentLayerOptions = {},
): Promise<PaymentLayer> {
  if (config.useLiveFacilitator) {
    return createLivePaymentLayer(config, options);
  }
  return createDemoPaymentLayer(config, options);
}
