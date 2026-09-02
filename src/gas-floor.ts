/**
 * Defensive “gas eats profit” floor for Base micropayments.
 *
 * When L2 gas spikes, $0.001–$0.01 charges can become uneconomic. With
 * `X402_DYNAMIC_MIN_ENABLED=true`, we estimate settle gas in USD from a
 * cached base-fee oracle and bump the minimum accept amount (and optionally
 * raise feeFreeBelow so FeeSplitter+release isn’t used until larger amounts).
 *
 * Default OFF — demo `$0.001` still works under normal Base fees.
 */

/** Subset of TollgateConfig needed by the gas floor (avoids circular imports). */
export interface GasFloorConfig {
  price: string;
  feeBps: number;
  feeFreeBelowUsdc: bigint;
  minPriceUsdc: bigint;
  dynamicMinEnabled: boolean;
  gasCostMaxFraction: number;
  gasOracleRpcUrl: string;
  gasOracleTtlMs: number;
  gasUsedEstimate: number;
  ethUsd: number;
}

/** Default gas units for a rough L2 EIP-3009 / ERC-20 settle estimate. */
export const DEFAULT_GAS_USED_ESTIMATE = 100_000;
/** Conservative ETH/USD floor when no live price feed (higher → more protective). */
export const DEFAULT_ETH_USD = 4_000;
/** Max fraction of payment that estimated gas may consume before bumping (50%). */
export const DEFAULT_GAS_COST_MAX_FRACTION = 0.5;
/** Base-fee cache TTL (ms). Clamped to 15–60s. */
export const DEFAULT_GAS_ORACLE_TTL_MS = 30_000;
export const MIN_GAS_ORACLE_TTL_MS = 15_000;
export const MAX_GAS_ORACLE_TTL_MS = 60_000;

const DEFAULT_RPC_BY_NETWORK: Record<string, string> = {
  "eip155:84532": "https://sepolia.base.org",
  "eip155:8453": "https://mainnet.base.org",
};

export type GasFloorReason = "disabled" | "static" | "min_floor" | "gas";

export interface GasFloorSnapshot {
  enabled: boolean;
  /** Configured PRICE as atomic USDC. */
  configuredPriceAtomic: bigint;
  /** Static X402_MIN_PRICE_USDC (0 when unset). */
  minPriceUsdc: bigint;
  /** Configured fee-free threshold. */
  configuredFeeFreeBelowUsdc: bigint;
  /** Enforced / displayed minimum accept amount (atomic USDC). */
  effectiveMinPriceAtomic: bigint;
  /** Effective fee-free threshold after optional gas-aware raise. */
  effectiveFeeFreeBelowUsdc: bigint;
  /** Dollar form of effective min (e.g. `$0.001`). */
  effectiveMinPrice: string;
  /** Last observed / injected base fee (wei), or null. */
  baseFeeWei: string | null;
  /** Estimated L2 gas cost in USD, or null when unknown / disabled. */
  estimatedGasCostUsd: number | null;
  gasCostMaxFraction: number;
  ethUsd: number;
  gasUsedEstimate: number;
  bumped: boolean;
  reason: GasFloorReason;
  oracleTtlMs: number;
  cachedAt: number | null;
}

export interface ComputeEffectiveMinsInput {
  priceAtomic: bigint;
  minPriceUsdc: bigint;
  feeFreeBelowUsdc: bigint;
  dynamicMinEnabled: boolean;
  /** null → skip gas bump (static floors only). */
  gasCostUsd: number | null;
  gasCostMaxFraction: number;
  /** Operator fee bps — used to raise feeFreeBelow so 0.1% can cover release gas. */
  feeBps: number;
  usdcDecimals?: number;
}

/**
 * Pure floor math (unit-testable with mocked gas USD).
 *
 * - effectiveMin = max(price, minPriceUsdc, gasDerivedMin when enabled)
 * - gasDerivedMin = ceil(gasCostUsd / maxFraction) in atomic USDC
 * - When gas forces a bump, also raise feeFreeBelow so FeeSplitter+release
 *   is deferred until amounts where feeBps can cover estimated gas.
 */
export function computeEffectiveMins(input: ComputeEffectiveMinsInput): {
  effectiveMinPriceAtomic: bigint;
  effectiveFeeFreeBelowUsdc: bigint;
  bumped: boolean;
  reason: GasFloorReason;
  gasDerivedMinAtomic: bigint | null;
} {
  const decimals = input.usdcDecimals ?? 6;
  const priceAtomic = input.priceAtomic < 0n ? 0n : input.priceAtomic;
  const minFloor = input.minPriceUsdc < 0n ? 0n : input.minPriceUsdc;

  let effectiveMin = priceAtomic > minFloor ? priceAtomic : minFloor;
  let reason: GasFloorReason =
    minFloor > priceAtomic ? "min_floor" : input.dynamicMinEnabled ? "static" : "disabled";
  let bumped = minFloor > priceAtomic;
  let gasDerivedMinAtomic: bigint | null = null;

  if (
    input.dynamicMinEnabled &&
    input.gasCostUsd !== null &&
    Number.isFinite(input.gasCostUsd) &&
    input.gasCostUsd >= 0 &&
    input.gasCostMaxFraction > 0 &&
    input.gasCostMaxFraction <= 1
  ) {
    gasDerivedMinAtomic = usdToAtomicUsdc(
      input.gasCostUsd / input.gasCostMaxFraction,
      decimals,
    );
    if (gasDerivedMinAtomic > effectiveMin) {
      effectiveMin = gasDerivedMinAtomic;
      bumped = true;
      reason = "gas";
    }
  }

  let effectiveFeeFree = input.feeFreeBelowUsdc;
  if (
    input.dynamicMinEnabled &&
    input.gasCostUsd !== null &&
    Number.isFinite(input.gasCostUsd) &&
    input.gasCostUsd > 0 &&
    input.feeBps > 0
  ) {
    // Raise fee-free floor so FeeSplitter+release isn’t used until protocol fee
    // can roughly cover estimated gas (gas / feeFraction).
    const feeFraction = input.feeBps / 10_000;
    if (feeFraction > 0) {
      const coverageMin = usdToAtomicUsdc(input.gasCostUsd / feeFraction, decimals);
      if (coverageMin > effectiveFeeFree) {
        effectiveFeeFree = coverageMin;
        if (reason === "disabled" || reason === "static") {
          reason = "gas";
          bumped = true;
        }
      }
    }
  }

  return {
    effectiveMinPriceAtomic: effectiveMin,
    effectiveFeeFreeBelowUsdc: effectiveFeeFree,
    bumped,
    reason,
    gasDerivedMinAtomic,
  };
}

/** gasUsed * baseFeeWei * ethUsd / 1e18 */
export function estimateGasCostUsd(
  baseFeeWei: bigint,
  gasUsedEstimate: number,
  ethUsd: number,
): number {
  if (baseFeeWei < 0n || gasUsedEstimate <= 0 || !(ethUsd > 0)) return 0;
  // Avoid float overflow: (gas * baseFee / 1e18) * ethUsd
  const gas = BigInt(Math.floor(gasUsedEstimate));
  const weiCost = gas * baseFeeWei;
  const eth = Number(weiCost) / 1e18;
  if (!Number.isFinite(eth)) {
    // Fallback for huge values: divide in bigint space (lossy but safe).
    const ethScaled = weiCost / 10n ** 12n; // 1e-6 ETH units
    return (Number(ethScaled) / 1e6) * ethUsd;
  }
  return eth * ethUsd;
}

export function usdToAtomicUsdc(usd: number, decimals = 6): bigint {
  if (!(usd > 0) || !Number.isFinite(usd)) return 0n;
  const scale = 10 ** decimals;
  return BigInt(Math.ceil(usd * scale - Number.EPSILON));
}

export function dollarPriceToAtomic(price: string, decimals = 6): bigint {
  const match = price.trim().match(/^\$(\d+(?:\.\d+)?)$/);
  if (!match) {
    const trimmed = price.trim();
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
    return 0n;
  }
  const [whole, frac = ""] = match[1]!.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const atomic = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return BigInt(atomic || "0");
}

export function atomicUsdcToDollarPrice(atomic: bigint, decimals = 6): string {
  if (atomic <= 0n) return "$0";
  const negative = atomic < 0n;
  const value = negative ? -atomic : atomic;
  const raw = value.toString().padStart(decimals + 1, "0");
  const whole = raw.slice(0, -decimals) || "0";
  const frac = raw.slice(-decimals).replace(/0+$/, "");
  const dollar = frac ? `$${whole}.${frac}` : `$${whole}`;
  return negative ? `-${dollar}` : dollar;
}

export type BaseFeeFetcher = () => Promise<bigint>;

export interface GasFloorOracleOptions {
  rpcUrl: string;
  ttlMs: number;
  /** Inject for tests. */
  fetchBaseFee?: BaseFeeFetcher;
  /** Inject clock for tests. */
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/** Cached eth_getBlockByNumber baseFeePerGas reader (TTL 15–60s). */
export function createBaseFeeOracle(options: GasFloorOracleOptions): {
  getBaseFeeWei: () => Promise<bigint>;
  peekCache: () => { baseFeeWei: bigint; fetchedAt: number } | null;
  clearCache: () => void;
} {
  const ttlMs = clampTtl(options.ttlMs);
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  let cache: { baseFeeWei: bigint; fetchedAt: number } | null = null;
  let inFlight: Promise<bigint> | null = null;

  const fetchBaseFee =
    options.fetchBaseFee ??
    (async () => {
      const res = await fetchImpl(options.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBlockByNumber",
          params: ["latest", false],
        }),
      });
      if (!res.ok) {
        throw new Error(`gas oracle RPC HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        result?: { baseFeePerGas?: string } | null;
        error?: { message?: string };
      };
      if (body.error?.message) {
        throw new Error(`gas oracle RPC error: ${body.error.message}`);
      }
      const hex = body.result?.baseFeePerGas;
      if (!hex || typeof hex !== "string") {
        throw new Error("gas oracle: missing baseFeePerGas");
      }
      return BigInt(hex);
    });

  return {
    peekCache: () => cache,
    clearCache: () => {
      cache = null;
    },
    async getBaseFeeWei() {
      const t = now();
      if (cache && t - cache.fetchedAt < ttlMs) {
        return cache.baseFeeWei;
      }
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const baseFeeWei = await fetchBaseFee();
          cache = { baseFeeWei, fetchedAt: now() };
          return baseFeeWei;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
  };
}

export function clampTtl(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_GAS_ORACLE_TTL_MS;
  return Math.min(MAX_GAS_ORACLE_TTL_MS, Math.max(MIN_GAS_ORACLE_TTL_MS, Math.floor(ms)));
}

export function defaultRpcUrlForNetwork(network: string): string {
  return DEFAULT_RPC_BY_NETWORK[network] ?? DEFAULT_RPC_BY_NETWORK["eip155:8453"]!;
}

export interface GasFloorService {
  getSnapshot: () => Promise<GasFloorSnapshot>;
  /** Sync view using last cached base fee (no RPC). Safe for middleware rewrites. */
  getSnapshotSync: () => GasFloorSnapshot;
  /** Refresh cache (no-op when dynamic disabled). */
  refresh: () => Promise<void>;
  clearCache: () => void;
}

export function createGasFloorService(
  config: GasFloorConfig,
  options: {
    fetchBaseFee?: BaseFeeFetcher;
    now?: () => number;
    fetchImpl?: typeof fetch;
  } = {},
): GasFloorService {
  const oracle =
    config.dynamicMinEnabled
      ? createBaseFeeOracle({
          rpcUrl: config.gasOracleRpcUrl,
          ttlMs: config.gasOracleTtlMs,
          fetchBaseFee: options.fetchBaseFee,
          now: options.now,
          fetchImpl: options.fetchImpl,
        })
      : null;

  const build = (gasCostUsd: number | null, baseFeeWei: bigint | null, cachedAt: number | null): GasFloorSnapshot => {
    const priceAtomic = dollarPriceToAtomic(config.price);
    const computed = computeEffectiveMins({
      priceAtomic,
      minPriceUsdc: config.minPriceUsdc,
      feeFreeBelowUsdc: config.feeFreeBelowUsdc,
      dynamicMinEnabled: config.dynamicMinEnabled,
      gasCostUsd,
      gasCostMaxFraction: config.gasCostMaxFraction,
      feeBps: config.feeBps,
    });
    return {
      enabled: config.dynamicMinEnabled,
      configuredPriceAtomic: priceAtomic,
      minPriceUsdc: config.minPriceUsdc,
      configuredFeeFreeBelowUsdc: config.feeFreeBelowUsdc,
      effectiveMinPriceAtomic: computed.effectiveMinPriceAtomic,
      effectiveFeeFreeBelowUsdc: computed.effectiveFeeFreeBelowUsdc,
      effectiveMinPrice: atomicUsdcToDollarPrice(computed.effectiveMinPriceAtomic),
      baseFeeWei: baseFeeWei !== null ? baseFeeWei.toString() : null,
      estimatedGasCostUsd: gasCostUsd,
      gasCostMaxFraction: config.gasCostMaxFraction,
      ethUsd: config.ethUsd,
      gasUsedEstimate: config.gasUsedEstimate,
      bumped: computed.bumped,
      reason: computed.reason,
      oracleTtlMs: config.gasOracleTtlMs,
      cachedAt,
    };
  };

  return {
    clearCache() {
      oracle?.clearCache();
    },
    async refresh() {
      if (!oracle) return;
      try {
        await oracle.getBaseFeeWei();
      } catch {
        // Keep last cache; operators see null gas on /health until success.
      }
    },
    getSnapshotSync() {
      const cached = oracle?.peekCache() ?? null;
      if (!cached) {
        return build(null, null, null);
      }
      const gasCostUsd = estimateGasCostUsd(
        cached.baseFeeWei,
        config.gasUsedEstimate,
        config.ethUsd,
      );
      return build(gasCostUsd, cached.baseFeeWei, cached.fetchedAt);
    },
    async getSnapshot() {
      if (!oracle) {
        return build(null, null, null);
      }
      try {
        const baseFeeWei = await oracle.getBaseFeeWei();
        const cached = oracle.peekCache();
        const gasCostUsd = estimateGasCostUsd(
          baseFeeWei,
          config.gasUsedEstimate,
          config.ethUsd,
        );
        return build(gasCostUsd, baseFeeWei, cached?.fetchedAt ?? null);
      } catch {
        return this.getSnapshotSync();
      }
    },
  };
}
