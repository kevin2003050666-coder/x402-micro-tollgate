import type { TollgateConfig } from "./config.js";
import type { MerchantRegistry } from "./merchants.js";

/** Stable discovery document version for agent-readable yellow pages. */
export const DISCOVER_VERSION = 1 as const;

/** Primary free discovery path (no 402). */
export const DISCOVER_PATH = "/x402/discover";

/** Convenience alias — same payload as {@link DISCOVER_PATH}. */
export const DISCOVER_ALIAS_PATH = "/discover";

export type DiscoverServiceStatus = "live" | "demo" | "config";

export interface DiscoverService {
  id: string;
  label: string;
  endpoint: string;
  mcp: string;
  capabilities: string[];
  price: string;
  asset: string;
  payTo: string;
  seller: string;
  status: DiscoverServiceStatus;
}

export interface DiscoverDocument {
  version: typeof DISCOVER_VERSION;
  network: string;
  updatedAt: string;
  /**
   * Honesty note: this catalog is built from local merchant JSON / SELLER /
   * demo — not an on-chain Agent Registry stake contract.
   */
  source: "merchants" | "seller" | "mixed";
  services: DiscoverService[];
}

const GATEWAY_CAPABILITIES = ["quote", "proxy", "fetch-md"] as const;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function primaryAssetSymbol(config: TollgateConfig): string {
  const first = config.accepts[0];
  return first?.symbol ?? "USDC";
}

/**
 * Health-ish status for a listed service.
 * - live: CDP facilitator credentials + payTo present (real settle path)
 * - demo: protocol-shaped 402 / MCP PaymentRequired, no on-chain settle
 * - config: merchant/seller entry present but primary accept is not CDP-live
 */
export function resolveDiscoverStatus(config: TollgateConfig): DiscoverServiceStatus {
  if (config.useLiveFacilitator) {
    const primary = config.accepts[0];
    if (primary && primary.status !== "live") return "config";
    return "live";
  }
  return "demo";
}

function merchantEndpoint(base: string, merchantId: string, gatedPrefix: string): string {
  const prefix = gatedPrefix || "/v1";
  const path = `${prefix}/quote`;
  const q = new URLSearchParams({ merchant: merchantId });
  return `${base}${path}?${q.toString()}`;
}

function sellerEndpoint(base: string, gatedPrefix: string): string {
  const prefix = gatedPrefix || "/v1";
  return `${base}${prefix}/quote`;
}

/**
 * Build agent-readable discovery yellow pages from existing sources only:
 * MERCHANTS_JSON / merchants file / SELLER / built-in demo.
 * Does **not** deploy or require Registry.sol.
 */
export function buildDiscoverDocument(
  config: TollgateConfig,
  now: Date = new Date(),
): DiscoverDocument {
  const base = stripTrailingSlash(config.publicBaseUrl);
  const status = resolveDiscoverStatus(config);
  const asset = primaryAssetSymbol(config);
  const mcp = `${base}/mcp`;
  const services: DiscoverService[] = [];

  const merchants: MerchantRegistry = config.merchants;
  const merchantIds = Object.keys(merchants).sort((a, b) => a.localeCompare(b));

  for (const id of merchantIds) {
    const m = merchants[id]!;
    services.push({
      id,
      label: m.label,
      endpoint: merchantEndpoint(base, id, config.gatedPrefix),
      mcp,
      capabilities: [...GATEWAY_CAPABILITIES],
      price: config.price,
      asset,
      payTo: m.payTo,
      seller: m.seller,
      status,
    });
  }

  // Permissionless seller with empty/optional registry — still advertise one route.
  if (config.seller) {
    const sellerLower = config.seller.toLowerCase();
    const alreadyListed = services.some(
      (s) => s.seller.toLowerCase() === sellerLower && s.id === "seller",
    );
    const onlySellerSource = merchantIds.length === 0;
    if (onlySellerSource && !alreadyListed) {
      const payTo = config.payTo ?? config.seller;
      services.push({
        id: "seller",
        label: "permissionless seller",
        endpoint: sellerEndpoint(base, config.gatedPrefix),
        mcp,
        capabilities: [...GATEWAY_CAPABILITIES],
        price: config.price,
        asset,
        payTo,
        seller: config.seller,
        status,
      });
    }
  }

  let source: DiscoverDocument["source"] = "merchants";
  if (merchantIds.length === 0 && config.seller) {
    source = "seller";
  } else if (merchantIds.length > 0 && config.seller) {
    // Seller env is active alongside a file/JSON registry (permissionless + tenants).
    source = "mixed";
  }

  return {
    version: DISCOVER_VERSION,
    network: config.network,
    updatedAt: now.toISOString(),
    source,
    services,
  };
}
