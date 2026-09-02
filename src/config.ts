import { config as loadEnv } from "dotenv";
import {
  loadMerchantsRegistry,
  OPERATOR_FEE_COLLECTOR,
  type MerchantRegistry,
  isEvmAddress,
} from "./merchants.js";

loadEnv();

export type X402Environment = "development" | "production";

export interface TollgateConfig {
  port: number;
  upstreamUrl: string | undefined;
  payTo: `0x${string}` | undefined;
  price: string;
  network: string;
  environment: X402Environment;
  /** Path prefix that requires payment (e.g. `/v1`). Empty string gates everything except free paths. */
  gatedPrefix: string;
  cdpApiKeyId: string | undefined;
  cdpApiKeySecret: string | undefined;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TollgateConfig {
  const environment = parseEnvironment(env.X402_ENVIRONMENT ?? env.CDP_X402_SERVER_ENVIRONMENT);
  const network = env.NETWORK?.trim() || DEFAULT_NETWORK_BY_ENV[environment];

  const merchants = loadMerchantsRegistry(env);
  const defaultMerchantRaw = env.DEFAULT_MERCHANT?.trim() || "demo";
  const defaultMerchant =
    merchants[defaultMerchantRaw] !== undefined
      ? defaultMerchantRaw
      : Object.keys(merchants).sort()[0]!;

  const payToRaw = env.X402_PAY_TO?.trim();
  const payToFromEnv =
    payToRaw && isEvmAddress(payToRaw) ? (payToRaw as `0x${string}`) : undefined;
  // Prefer explicit X402_PAY_TO; else default merchant FeeSplitter (SDK global payTo).
  const payTo = payToFromEnv ?? merchants[defaultMerchant]?.payTo;

  const cdpApiKeyId = env.CDP_API_KEY_ID?.trim() || undefined;
  const cdpApiKeySecret = env.CDP_API_KEY_SECRET?.trim() || undefined;
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

  return {
    port,
    upstreamUrl: env.UPSTREAM_URL?.trim() || undefined,
    payTo,
    price: env.PRICE?.trim() || "$0.001",
    network,
    environment,
    gatedPrefix: normalizePrefix(env.GATED_PREFIX),
    cdpApiKeyId,
    cdpApiKeySecret,
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
