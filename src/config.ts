import { config as loadEnv } from "dotenv";
import {
  loadMerchantsRegistry,
  OPERATOR_FEE_COLLECTOR,
  type MerchantRegistry,
  isEvmAddress,
} from "./merchants.js";
import { assertValidSeller, tryParseAddress } from "./address.js";
import { DEFAULT_FEE_FREE_BELOW_USDC } from "./resolve-pay-to.js";

loadEnv();

export type X402Environment = "development" | "production";

export interface TollgateConfig {
  port: number;
  upstreamUrl: string | undefined;
  /**
   * Shared secret for post-payment upstream trust headers
   * (`UPSTREAM_SHARED_SECRET` or `X402_UPSTREAM_SECRET`).
   * When set, tollgate injects `X-Tollgate-Secret` / `X-Tollgate-Paid` after settle.
   * Upstream must require these and reject public direct hits. Not mTLS.
   */
  upstreamSharedSecret: string | undefined;
  payTo: `0x${string}` | undefined;
  price: string;
  network: string;
  environment: X402Environment;
  /** Path prefix that requires payment (e.g. `/v1`). Empty string gates everything except free paths. */
  gatedPrefix: string;
  cdpApiKeyId: string | undefined;
  cdpApiKeySecret: string | undefined;
  /**
   * Public CDP client / project API key for browser Smart Wallet paywall UX.
   * Safe to expose to the browser; never put `CDP_API_KEY_SECRET` here.
   */
  cdpClientApiKey: string | undefined;
  /** True when CDP facilitator credentials + pay-to are present. */
  useLiveFacilitator: boolean;
  /**
   * Public https origin for Bazaar resource URLs (no trailing slash).
   * Without this, demos use http://127.0.0.1:PORT — Bazaar listing is a no-op until set + one CDP settlement.
   */
  publicBaseUrl: string;
  /** Contact mailto on the landing page (not a SaaS CTA). */
  contactEmail: string;
  /**
   * Operator fee in basis points (default 10 = 0.1%).
   * Documented for FeeSplitter deploy; live CDP settle still pays 100% to `payTo`.
   */
  feeBps: number;
  /**
   * Fixed operator feeCollector wallet (default OPERATOR_FEE_COLLECTOR).
   * Each merchant FeeSplitter uses seller=merchant wallet, feeCollector=this address.
   */
  feeCollector: `0x${string}`;
  /** merchantId → FeeSplitter payTo + seller for display. Loaded at startup. */
  merchants: MerchantRegistry;
  /** Default merchant id when query/header omitted (env DEFAULT_MERCHANT, default `demo`). */
  defaultMerchant: string;
  /**
   * When true, gated paths require an explicit `?merchant=` / `x-merchant-id`
   * (no DEFAULT_MERCHANT fallback). Off by default — agents SHOULD send merchant id.
   */
  requireMerchant: boolean;
  /** Gateway PAYMENT-SIGNATURE dedupe TTL (ms). CDP facilitator remains source of truth for EIP-3009 nonce. */
  paymentDedupeTtlMs: number;
  /** Max fingerprints kept in the in-memory dedupe LRU. */
  paymentDedupeMaxEntries: number;
  /**
   * Local / facilitator verify budget (ms). Documented separately from settle;
   * the gateway settle waiter uses `settleTimeoutMs`.
   */
  verifyTimeoutMs: number;
  /**
   * Max time to wait for facilitator / on-chain settle before returning
   * `202 payment_pending` + `retry_with_same_proof` (ms). Default 3 minutes.
   */
  settleTimeoutMs: number;
  /**
   * Permissionless seller EOA (env SELLER / X402_SELLER).
   * When set, gated payTo uses resolvePayTo(amount, seller) unless ?merchant= hits the registry.
   */
  seller: `0x${string}` | undefined;
  /**
   * USDC atomic threshold: amount &lt; this → payTo = seller (0 protocol fee).
   * Default 10_000_000 ($10). Amount ≥ threshold → CREATE2 FeeSplitter.
   */
  feeFreeBelowUsdc: bigint;
  /** FeeSplitterFactory address for CREATE2 predict (≥ threshold). */
  factoryAddress: `0x${string}` | undefined;
}

const DEFAULT_NETWORK_BY_ENV: Record<X402Environment, string> = {
  development: "eip155:84532",
  production: "eip155:8453",
};

function parseEnvironment(raw: string | undefined): X402Environment {
  if (raw === "production") return "production";
  return "development";
}

function normalizePrefix(raw: string | undefined): string {
  if (raw === undefined || raw === "") return "/v1";
  if (raw === "*" || raw === "/") return "";
  return raw.startsWith("/") ? raw.replace(/\/+$/, "") : `/${raw.replace(/\/+$/, "")}`;
}

function parseSellerEnv(env: NodeJS.ProcessEnv): `0x${string}` | undefined {
  const raw = env.SELLER?.trim() || env.X402_SELLER?.trim();
  if (!raw) return undefined;
  // Hard fail on invalid seller — do not silently ignore typos.
  return assertValidSeller(raw);
}

function parseFeeFreeBelow(raw: string | undefined): bigint {
  if (raw === undefined || raw.trim() === "") return DEFAULT_FEE_FREE_BELOW_USDC;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid FEE_FREE_BELOW_USDC: "${raw}" (expected non-negative integer atomic USDC)`,
    );
  }
  return BigInt(trimmed);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TollgateConfig {
  const environment = parseEnvironment(env.X402_ENVIRONMENT ?? env.CDP_X402_SERVER_ENVIRONMENT);
  const network = env.NETWORK?.trim() || DEFAULT_NETWORK_BY_ENV[environment];

  const seller = parseSellerEnv(env);
  // Permissionless seller: skip example/builtin fallback (registry truly optional).
  // Explicit MERCHANTS_JSON / existing merchants.json still loads when present.
  const merchants = loadMerchantsRegistry(env, process.cwd(), {
    optional: Boolean(seller),
  });

  const defaultMerchantRaw = env.DEFAULT_MERCHANT?.trim() || "demo";
  const merchantIds = Object.keys(merchants);
  const defaultMerchant =
    merchants[defaultMerchantRaw] !== undefined
      ? defaultMerchantRaw
      : merchantIds.length > 0
        ? merchantIds.sort()[0]!
        : defaultMerchantRaw;

  const payToRaw = env.X402_PAY_TO?.trim();
  const payToFromEnv =
    payToRaw && isEvmAddress(payToRaw) ? (payToRaw as `0x${string}`) : undefined;
  // Prefer explicit X402_PAY_TO; else seller (permissionless); else default merchant FeeSplitter.
  const payTo = payToFromEnv ?? seller ?? merchants[defaultMerchant]?.payTo;

  const cdpApiKeyId = env.CDP_API_KEY_ID?.trim() || undefined;
  const cdpApiKeySecret = env.CDP_API_KEY_SECRET?.trim() || undefined;
  const cdpClientApiKey =
    env.CDP_CLIENT_API_KEY?.trim() ||
    env.CDP_CLIENT_KEY?.trim() || // alias
    undefined;
  const port = Number(env.PORT) > 0 ? Number(env.PORT) : 8402;

  const publicRaw = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  const publicBaseUrl =
    publicRaw && /^https?:\/\//i.test(publicRaw)
      ? publicRaw
      : `http://127.0.0.1:${port}`;

  const feeBpsRaw = env.FEE_BPS?.trim();
  const feeBpsParsed = feeBpsRaw !== undefined && feeBpsRaw !== "" ? Number(feeBpsRaw) : 10;
  const feeBps =
    Number.isInteger(feeBpsParsed) && feeBpsParsed >= 0 && feeBpsParsed <= 10_000
      ? feeBpsParsed
      : 10;

  const feeCollectorRaw = env.FEE_COLLECTOR?.trim();
  const feeCollector =
    feeCollectorRaw && isEvmAddress(feeCollectorRaw)
      ? (feeCollectorRaw as `0x${string}`)
      : OPERATOR_FEE_COLLECTOR;

  const contactEmail =
    env.CONTACT_EMAIL?.trim() ||
    env.WAITLIST_EMAIL?.trim() || // legacy alias
    "2767111713@qq.com";

  const requireMerchant = env.REQUIRE_MERCHANT?.trim().toLowerCase() === "true";

  const dedupeTtlRaw = Number(env.PAYMENT_DEDUPE_TTL_MS);
  const paymentDedupeTtlMs =
    Number.isFinite(dedupeTtlRaw) && dedupeTtlRaw >= 1_000
      ? Math.floor(dedupeTtlRaw)
      : 10 * 60 * 1000;

  const dedupeMaxRaw = Number(env.PAYMENT_DEDUPE_MAX_ENTRIES);
  const paymentDedupeMaxEntries =
    Number.isFinite(dedupeMaxRaw) && dedupeMaxRaw >= 100
      ? Math.floor(dedupeMaxRaw)
      : 10_000;

  const verifyTimeoutRaw = Number(env.X402_VERIFY_TIMEOUT_MS);
  const verifyTimeoutMs =
    Number.isFinite(verifyTimeoutRaw) && verifyTimeoutRaw >= 1_000
      ? Math.floor(verifyTimeoutRaw)
      : 15_000;

  const settleTimeoutRaw = Number(env.X402_SETTLE_TIMEOUT_MS);
  const settleTimeoutMs =
    Number.isFinite(settleTimeoutRaw) && settleTimeoutRaw >= 5_000
      ? Math.floor(settleTimeoutRaw)
      : 180_000;

  const upstreamSharedSecret =
    env.UPSTREAM_SHARED_SECRET?.trim() ||
    env.X402_UPSTREAM_SECRET?.trim() ||
    undefined;

  const feeFreeBelowUsdc = parseFeeFreeBelow(env.FEE_FREE_BELOW_USDC);
  const factoryRaw = env.FACTORY_ADDRESS?.trim();
  const factoryAddress = factoryRaw ? tryParseAddress(factoryRaw) : undefined;
  if (factoryRaw && !factoryAddress) {
    throw new Error(
      `Invalid FACTORY_ADDRESS: "${factoryRaw}" is not a valid EVM address (check EIP-55 checksum)`,
    );
  }

  return {
    port,
    upstreamUrl: env.UPSTREAM_URL?.trim() || undefined,
    upstreamSharedSecret,
    payTo,
    price: env.PRICE?.trim() || "$0.001",
    network,
    environment,
    gatedPrefix: normalizePrefix(env.GATED_PREFIX),
    cdpApiKeyId,
    cdpApiKeySecret,
    cdpClientApiKey,
    useLiveFacilitator: Boolean(cdpApiKeyId && cdpApiKeySecret && payTo),
    publicBaseUrl,
    contactEmail,
    feeBps,
    feeCollector,
    merchants,
    defaultMerchant,
    requireMerchant,
    paymentDedupeTtlMs,
    paymentDedupeMaxEntries,
    verifyTimeoutMs,
    settleTimeoutMs,
    seller,
    feeFreeBelowUsdc,
    factoryAddress,
  };
}

/**
 * Free HTTP paths that never require x402 payment (MCP has its own payment loop).
 * `/merchants` and `/v1/merchants` are free registry listing endpoints.
 */
export const FREE_PATHS = new Set([
  "/",
  "/health",
  "/zh",
  "/mcp",
  "/sse",
  "/messages",
  "/merchants",
  "/v1/merchants",
  "/x402/session-token",
]);

export function isFreePath(path: string): boolean {
  const bare = path.split(/[?#]/)[0] || "/";
  return FREE_PATHS.has(bare);
}

export function isGatedPath(path: string, gatedPrefix: string): boolean {
  if (isFreePath(path)) return false;
  const bare = path.split(/[?#]/)[0] || "/";
  if (gatedPrefix === "") return true;
  return bare === gatedPrefix || bare.startsWith(`${gatedPrefix}/`);
}

export function gatedRoutePatterns(gatedPrefix: string): string[] {
  if (gatedPrefix === "") {
    return ["* /*"];
  }
  return [
    `* ${gatedPrefix}`,
    `* ${gatedPrefix}/*`,
  ];
}
