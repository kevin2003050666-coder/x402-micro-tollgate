/**
 * Thin buyer-side fetch wrapper for agent apps.
 *
 * Composes official `@x402/fetch` (`wrapFetchWithPayment`) + `@x402/evm`
 * (`ExactEvmScheme`) so we do not reinvent PAYMENT-REQUIRED / PAYMENT-SIGNATURE.
 *
 * Hard locks:
 * - Headers: PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE
 * - Max automatic payment retries = 1 (official wrapFetchWithPayment; we do not
 *   register recovery hooks that would authorize a second paid retry)
 * - Budgets enforced BEFORE signing via onBeforePaymentCreation
 */

import {
  wrapFetchWithPayment,
  x402Client,
  type Network,
  type PaymentRequirements,
  type SelectPaymentRequirements,
} from "@x402/fetch";
import { ExactEvmScheme, type ClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  assertWithinBudget,
  createBudgetTracker,
  recordSpend,
  usdcFromAccept,
  type BudgetLimits,
  type BudgetTracker,
} from "./budget.js";

/** Hardcoded: never loop payment retries (official client retries once). */
export const MAX_AUTOMATIC_PAYMENT_RETRIES = 1 as const;

/** Local / signing account usable with ExactEvmScheme (needs signTypedData). */
export type X402BuyerAccount = PrivateKeyAccount | ClientEvmSigner;

export type CreateX402FetchOptions = {
  /** Hex private key for EIP-3009 signing (viem privateKeyToAccount). */
  privateKey?: `0x${string}`;
  /** Pre-built signing account (alternative to privateKey). */
  account?: X402BuyerAccount;
  /** Max USDC for a single accept (default 0.05). */
  maxSingleSpendUsdc?: number;
  /** Max cumulative USDC across calls on this fetch instance (default 1.00). */
  maxTotalSpendUsdc?: number;
  /**
   * CAIP-2 networks to register (default `["eip155:*"]`).
   * Pass specific ids (e.g. `eip155:8453`) to restrict.
   */
  networks?: Network[];
  /** Underlying fetch (default globalThis.fetch). Injectable for tests. */
  fetch?: typeof globalThis.fetch;
};

export type X402Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function resolveAccount(options: CreateX402FetchOptions): ClientEvmSigner {
  if (options.account && options.privateKey) {
    throw new Error("createX402Fetch: pass privateKey or account, not both");
  }
  if (options.account) {
    if (typeof options.account.signTypedData !== "function") {
      throw new Error(
        "createX402Fetch: account must implement signTypedData (use viem privateKeyToAccount)",
      );
    }
    return options.account as ClientEvmSigner;
  }
  if (options.privateKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(options.privateKey)) {
      throw new Error("createX402Fetch: privateKey must be a 0x-prefixed 32-byte hex string");
    }
    return privateKeyToAccount(options.privateKey) as unknown as ClientEvmSigner;
  }
  throw new Error("createX402Fetch: privateKey or account is required");
}

/**
 * Prefer the cheapest accept that fits budgets; throw a clear Error if none do.
 * Used as paymentRequirementsSelector so amount is checked before EIP-3009 sign.
 */
export function createBudgetSelector(
  tracker: BudgetTracker,
): SelectPaymentRequirements {
  return (_x402Version, paymentRequirements: PaymentRequirements[]) => {
    if (!paymentRequirements || paymentRequirements.length === 0) {
      throw new Error("x402: no payment options available");
    }

    const ranked = [...paymentRequirements].sort((a, b) => {
      try {
        return usdcFromAccept(a) - usdcFromAccept(b);
      } catch {
        return 0;
      }
    });

    let lastSingleError: Error | undefined;
    let lastTotalError: Error | undefined;

    for (const req of ranked) {
      let amountUsdc: number;
      try {
        amountUsdc = usdcFromAccept(req);
      } catch (err) {
        lastSingleError =
          err instanceof Error ? err : new Error(String(err));
        continue;
      }
      try {
        assertWithinBudget(amountUsdc, tracker);
        return req;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (e.message.includes("single payment")) {
          lastSingleError = e;
        } else {
          lastTotalError = e;
        }
      }
    }

    throw lastTotalError ?? lastSingleError ?? new Error("x402 budget exceeded");
  };
}

/**
 * Create a fetch that auto-handles HTTP 402 once:
 * parse PAYMENT-REQUIRED → budget check → EIP-3009 sign → retry with PAYMENT-SIGNATURE.
 *
 * @example
 * ```ts
 * import { createX402Fetch } from "x402-micro-tollgate/client";
 * const fetch402 = createX402Fetch({ privateKey: process.env.BUYER_KEY as `0x${string}` });
 * const res = await fetch402("https://example.com/v1/quote");
 * ```
 */
export function createX402Fetch(options: CreateX402FetchOptions): X402Fetch {
  const account = resolveAccount(options);
  const tracker = createBudgetTracker({
    maxSingleSpendUsdc: options.maxSingleSpendUsdc,
    maxTotalSpendUsdc: options.maxTotalSpendUsdc,
  });
  const networks: Network[] =
    options.networks && options.networks.length > 0
      ? options.networks
      : (["eip155:*"] as Network[]);
  const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  const selector = createBudgetSelector(tracker);
  const client = new x402Client(selector);
  // Our selector owns clear budget Errors; disable default $1 spendControls.
  client.setSpendControls(false);

  const scheme = new ExactEvmScheme(account);
  for (const network of networks) {
    client.register(network, scheme);
  }

  // Belt-and-suspenders: abort before sign if somehow selection raced total.
  client.onBeforePaymentCreation(async (ctx) => {
    try {
      const amountUsdc = usdcFromAccept(ctx.selectedRequirements);
      assertWithinBudget(amountUsdc, tracker);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { abort: true, reason };
    }
  });

  client.onAfterPaymentCreation(async (ctx) => {
    const amountUsdc = usdcFromAccept(ctx.selectedRequirements);
    // Selection already checked; record cumulative spend after successful sign.
    recordSpend(tracker, amountUsdc);
  });

  // TODO(optional): abort when estimated GasCost > 20% of payment amount.
  // Requires a gas oracle; intentionally not blocking ship for v1 buyer client.

  // Official wrapper: initial fetch → on 402 create payment → retry once
  // (MAX_AUTOMATIC_PAYMENT_RETRIES = 1). No onPaymentResponse recovery hooks
  // → no second paid retry.
  return wrapFetchWithPayment(baseFetch, client);
}

/** Test/helper: expose remaining budget on a tracker (not on the fetch itself). */
export { createBudgetTracker, type BudgetTracker, type BudgetLimits };
