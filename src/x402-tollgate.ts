import type { RequestHandler } from "express";
import { loadConfig, type TollgateConfig } from "./config.js";
import { createPaymentLayer } from "./payment.js";
import { assertValidSeller, assertValidAddress, tryParseAddress } from "./address.js";
import { DEFAULT_FEE_FREE_BELOW_USDC } from "./resolve-pay-to.js";

export interface X402TollgateOptions {
  /** Seller receive wallet (EOA). Required — validated with EIP-55 / isAddress. */
  seller: string;
  /** Operator feeCollector (default: fixed Plan A address from env / OPERATOR_FEE_COLLECTOR). */
  feeCollector?: string;
  /**
   * Fee-free threshold in USDC atomic units (6 decimals).
   * Default 10_000_000 ($10). Single payment strictly below → payTo = seller.
   */
  feeFreeBelowUsdc?: bigint | number | string;
  /** FeeSplitterFactory address (required for payments ≥ threshold). */
  factoryAddress?: string;
  /** Basis points for FeeSplitter (default 10 = 0.1%). */
  feeBps?: number;
  /** Override process.env when building TollgateConfig. */
  env?: NodeJS.ProcessEnv;
  /**
   * Path prefix gated by this middleware (default `""` so `app.use('/v1', …)`
   * charges every path under the mount).
   */
  gatedPrefix?: string;
}

/**
 * Permissionless seller Express middleware.
 *
 * @example
 * ```ts
 * import { x402Tollgate } from "x402-micro-tollgate";
 * app.use("/v1", await x402Tollgate({ seller: process.env.SELLER! }));
 * ```
 *
 * payTo rules (x402 `exact` + EIP-3009 → credits `payTo` only; no same-tx split):
 * - amount &lt; $10 USDC → seller EOA (0 protocol fee)
 * - amount ≥ $10 → CREATE2 FeeSplitter; call `release()` later (99.9% / 0.1%)
 *
 * Invalid `seller` throws at init (hard fail). Does not enable KEEPER.
 */
export async function x402Tollgate(
  options: X402TollgateOptions,
): Promise<RequestHandler> {
  const seller = assertValidSeller(options.seller);

  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    SELLER: seller,
  };

  if (options.feeCollector) {
    env.FEE_COLLECTOR = assertValidAddress(options.feeCollector, "feeCollector");
  }
  if (options.factoryAddress) {
    const factory = tryParseAddress(options.factoryAddress);
    if (!factory) {
      throw new Error(`Invalid factoryAddress: ${options.factoryAddress}`);
    }
    env.FACTORY_ADDRESS = factory;
  }
  if (options.feeFreeBelowUsdc !== undefined) {
    env.FEE_FREE_BELOW_USDC = String(options.feeFreeBelowUsdc);
  }
  if (options.feeBps !== undefined) {
    env.FEE_BPS = String(options.feeBps);
  }
  if (options.gatedPrefix !== undefined) {
    // "" / unset for mount use → gate all paths that reach this middleware.
    env.GATED_PREFIX =
      options.gatedPrefix === "" || options.gatedPrefix === "*"
        ? "*"
        : options.gatedPrefix;
  } else if (!env.GATED_PREFIX?.trim()) {
    env.GATED_PREFIX = "*";
  }

  const config = loadConfig(env);
  // Ensure seller survived loadConfig validation.
  if (!config.seller || config.seller.toLowerCase() !== seller.toLowerCase()) {
    throw new Error("x402Tollgate: seller config mismatch after loadConfig");
  }

  const layer = await createPaymentLayer(config);
  return layer.middleware;
}

/** Build TollgateConfig for a permissionless seller (sync; for tests / custom wiring). */
export function loadSellerConfig(
  options: X402TollgateOptions,
): TollgateConfig {
  const seller = assertValidSeller(options.seller);
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    SELLER: seller,
  };
  if (options.feeCollector) env.FEE_COLLECTOR = options.feeCollector;
  if (options.factoryAddress) env.FACTORY_ADDRESS = options.factoryAddress;
  if (options.feeFreeBelowUsdc !== undefined) {
    env.FEE_FREE_BELOW_USDC = String(options.feeFreeBelowUsdc);
  } else if (!env.FEE_FREE_BELOW_USDC?.trim()) {
    env.FEE_FREE_BELOW_USDC = String(DEFAULT_FEE_FREE_BELOW_USDC);
  }
  if (options.feeBps !== undefined) env.FEE_BPS = String(options.feeBps);
  if (options.gatedPrefix !== undefined) {
    env.GATED_PREFIX = options.gatedPrefix;
  }
  return loadConfig(env);
}
