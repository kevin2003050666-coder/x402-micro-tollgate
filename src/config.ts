import { config as loadEnv } from "dotenv";
import {
  loadMerchantsRegistry,
  OPERATOR_FEE_COLLECTOR,
  type MerchantRegistry,
  isEvmAddress,
} from "./merchants.js";
import { assertValidSeller, tryParseAddress } from "./address.js";
import { DEFAULT_FEE_FREE_BELOW_USDC } from "./resolve-pay-to.js";
import {
  DEFAULT_ETH_USD,
  DEFAULT_GAS_COST_MAX_FRACTION,
  DEFAULT_GAS_ORACLE_TTL_MS,
  DEFAULT_GAS_USED_ESTIMATE,
  clampTtl,
  defaultRpcUrlForNetwork,
} from "./gas-floor.js";
import {
  parseAcceptSpecs,
  parseFactoryAddresses,
  parseNetworksList,
  type AcceptSpec,
} from "./networks.js";

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
  /**
   * Primary CAIP-2 network (first settle / CREATE2 asset default).
   * Always equal to `networks[0]` after load when NETWORKS drives the list.
   */
  network: string;
  /**
   * Networks from `NETWORKS` / `NETWORK` (EVM + optional Solana).
   * Default: single Base Sepolia (dev) or Base (prod) — Render-safe.
   */
  networks: string[];
  /**
   * Active 402 `accepts[]` specs (network × asset). From `ACCEPTS_JSON` or
   * `NETWORKS` × `ASSETS` (default USDC only). Never includes TRON/planned.
   */
  accepts: AcceptSpec[];
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
  /**
   * WalletConnect Cloud project id for browser paywall (public).
   * When set, paywall injects WalletConnect alongside Smart Wallet / injected.
   */
  walletConnectProjectId: string | undefined;
  /**
   * Enable `@x402/paywall` SVM handler when Solana appears in accepts
   * (or force with PAYWALL_SVM=true). Off by default.
   */
  paywallSvm: boolean;
  /** Solana receive address for experimental SVM accepts (base58). */
  solanaPayTo: string | undefined;
  /** True when CDP facilitator credentials + pay-to are present. */
  useLiveFacilitator: boolean;
  /**
   * Optional CDP / alternate x402 facilitator base URL
   * (`X402_FACILITATOR_URL` or `CDP_FACILITATOR_URL`).
   * Applied to MCP `createCdpFacilitatorClient({ baseUrl })`. HTTP live
   * `createX402Server` still uses the CDP default until the SDK exposes an
   * override — no multi-facilitator routing engine yet.
   */
  facilitatorUrl: string | undefined;
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
   * Env: `FEE_FREE_BELOW_USDC` or `X402_FEE_FREE_BELOW_USDC`.
   */
  feeFreeBelowUsdc: bigint;
  /**
   * FeeSplitterFactory for primary `network` (CREATE2 predict ≥ threshold).
   * Live Base reference: `contracts/deployments/base.json`.
   */
  factoryAddress: `0x${string}` | undefined;
  /**
   * Optional per-CAIP-2 factory map (`FACTORY_ADDRESSES` JSON + `FACTORY_ADDRESS`).
   * Other chains are config-ready stubs until an operator deploys.
   */
  factoryAddresses: Record<string, `0x${string}`>;
  /**
   * Static minimum accept amount in atomic USDC (`X402_MIN_PRICE_USDC`).
   * 0 = unset (use PRICE only, unless dynamic gas floor bumps).
   */
  minPriceUsdc: bigint;
  /**
   * When true, Base gas oracle may raise effective min price / feeFreeBelow
   * if estimated gas exceeds `gasCostMaxFraction` of the payment. Default OFF.
   */
  dynamicMinEnabled: boolean;
  /** Max gas-cost / payment ratio before bumping (default 0.5). */
  gasCostMaxFraction: number;
  /** Public Base JSON-RPC for baseFee (cached). */
  gasOracleRpcUrl: string;
  /** Base-fee cache TTL ms (clamped 15–60s). */
  gasOracleTtlMs: number;
  /** Rough L2 gas units for settle estimate. */
  gasUsedEstimate: number;
  /** Conservative ETH/USD floor for gas→USD (no live FX required). */
  ethUsd: number;
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
      `Invalid FEE_FREE_BELOW_USDC / X402_FEE_FREE_BELOW_USDC: "${raw}" (expected non-negative integer atomic USDC)`,
    );
  }
  return BigInt(trimmed);
}

function parseAtomicUsdcEnv(raw: string | undefined, label: string): bigint {
  if (raw === undefined || raw.trim() === "") return 0n;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${label}: "${raw}" (expected non-negative integer atomic USDC)`);
  }
  return BigInt(trimmed);
}

function parsePositiveNumber(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${label}: "${raw}" (expected positive number)`);
  }
  return n;
}

function parseFacilitatorUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(
      `Invalid X402_FACILITATOR_URL / CDP_FACILITATOR_URL: "${raw}" (expected http(s) URL)`,
    );
  }
  return trimmed.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TollgateConfig {
  const environment = parseEnvironment(env.X402_ENVIRONMENT ?? env.CDP_X402_SERVER_ENVIRONMENT);
  const { network, networks } = parseNetworksList(
    env,
    DEFAULT_NETWORK_BY_ENV[environment],
  );

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
  const walletConnectProjectId =
    env.WALLETCONNECT_PROJECT_ID?.trim() ||
    env.WC_PROJECT_ID?.trim() || // alias
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

  const feeFreeBelowUsdc = parseFeeFreeBelow(
    env.FEE_FREE_BELOW_USDC ?? env.X402_FEE_FREE_BELOW_USDC,
  );
  const { factoryAddress, factoryAddresses } = parseFactoryAddresses(
    env,
    network,
    tryParseAddress,
  );

  const accepts = parseAcceptSpecs(env, networks, network);
  const solanaPayTo =
    env.SOLANA_PAY_TO?.trim() || env.X402_SOLANA_PAY_TO?.trim() || undefined;
  const paywallSvm =
    env.PAYWALL_SVM?.trim().toLowerCase() === "true" ||
    accepts.some((a) => a.network.startsWith("solana:"));

  const minPriceUsdc = parseAtomicUsdcEnv(env.X402_MIN_PRICE_USDC, "X402_MIN_PRICE_USDC");
  const dynamicMinEnabled =
    env.X402_DYNAMIC_MIN_ENABLED?.trim().toLowerCase() === "true";

  const fractionRaw = env.X402_GAS_COST_MAX_FRACTION?.trim();
  let gasCostMaxFraction = DEFAULT_GAS_COST_MAX_FRACTION;
  if (fractionRaw) {
    const n = Number(fractionRaw);
    if (!Number.isFinite(n) || n <= 0 || n > 1) {
      throw new Error(
        `Invalid X402_GAS_COST_MAX_FRACTION: "${fractionRaw}" (expected (0, 1])`,
      );
    }
    gasCostMaxFraction = n;
  }

  const gasOracleTtlMs = clampTtl(
    Number(env.X402_GAS_ORACLE_TTL_MS) > 0
      ? Number(env.X402_GAS_ORACLE_TTL_MS)
      : DEFAULT_GAS_ORACLE_TTL_MS,
  );
  const gasUsedEstimate = Math.floor(
    parsePositiveNumber(
      env.X402_GAS_USED_ESTIMATE,
      DEFAULT_GAS_USED_ESTIMATE,
      "X402_GAS_USED_ESTIMATE",
    ),
  );
  const ethUsd = parsePositiveNumber(env.X402_ETH_USD, DEFAULT_ETH_USD, "X402_ETH_USD");
  const gasOracleRpcUrl =
    env.X402_GAS_RPC_URL?.trim() ||
    env.BASE_RPC_URL?.trim() ||
    defaultRpcUrlForNetwork(network);
  const facilitatorUrl = parseFacilitatorUrl(
    env.X402_FACILITATOR_URL ?? env.CDP_FACILITATOR_URL,
  );

  return {
    port,
    upstreamUrl: env.UPSTREAM_URL?.trim() || undefined,
    upstreamSharedSecret,
    payTo,
    price: env.PRICE?.trim() || "$0.001",
    network,
    networks,
    accepts,
    environment,
    gatedPrefix: normalizePrefix(env.GATED_PREFIX),
    cdpApiKeyId,
    cdpApiKeySecret,
    cdpClientApiKey,
    walletConnectProjectId,
    paywallSvm,
    solanaPayTo,
    useLiveFacilitator: Boolean(cdpApiKeyId && cdpApiKeySecret && payTo),
    facilitatorUrl,
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
    factoryAddresses,
    minPriceUsdc,
    dynamicMinEnabled,
    gasCostMaxFraction,
    gasOracleRpcUrl,
    gasOracleTtlMs,
    gasUsedEstimate,
    ethUsd,
  };
}

/**
 * Free HTTP paths that never require x402 payment (MCP has its own payment loop).
 * `/merchants` and `/v1/merchants` are free registry listing endpoints.
 * `/x402/discover` (+ `/discover` alias) is the agent-readable yellow pages catalog.
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
  "/x402/discover",
  "/discover",
  "/llms.txt",
  "/.well-known/llms.txt",
  "/openapi.yaml",
  "/docs/openapi.yaml",
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
