/**
 * Human-delegated agent credit (CLI) PoC
 *
 * Architecture lock: Human sets B_max → Agent uses createX402Fetch for 402 micro-pays.
 * Chrome extension / Telegram bot / Session Key / Passkey UI are out of scope.
 *
 * Local import (default): ../src/client — CI-safe; no network pay required for dry runs.
 * Live demo can instead use: import { createX402Fetch } from "x402-micro-tollgate/client"
 *
 * Run:
 *   BUYER_PRIVATE_KEY=0x… npm run poc:buyer-agent
 *   # or: npx tsx scripts/buyer-agent-poc.ts
 *
 * SAFETY: fund the signing key with ≤ $5–$10 USDC only. Never commit private keys.
 */

import "dotenv/config";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import {
  createX402Fetch,
  usdcFromAccept,
  DEFAULT_MAX_SINGLE_SPEND_USDC,
  DEFAULT_MAX_TOTAL_SPEND_USDC,
  type X402Fetch,
} from "../src/client/index.js";

export const SAFETY_BANNER = [
  "╔══════════════════════════════════════════════════════════════════╗",
  "║  SAFETY — Human-delegated agent credit (CLI) PoC               ║",
  "║  • Hot wallet only: keep ≤ $5–$10 USDC on BUYER_PRIVATE_KEY     ║",
  "║  • Never commit keys / .env — treat the key as an agent faucet  ║",
  "║  • Budgets: MAX_SINGLE_USDC / MAX_TOTAL_USDC stop overspend     ║",
  "╚══════════════════════════════════════════════════════════════════╝",
].join("\n");

export type BuyerAgentPocConfig = {
  targetUrl: string;
  maxSingleUsdc: number;
  maxTotalUsdc: number;
  rounds: number;
  privateKey: `0x${string}`;
  /** Injectable fetch for tests; default globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  log?: (line: string) => void;
  logErr?: (line: string) => void;
};

export type RoundResult = {
  round: number;
  status: number | null;
  autoPaid: boolean;
  sessionSpendUsdc: number;
  error?: string;
  stopped?: "budget" | "rounds" | "error";
};

function parsePositiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a finite number > 0 (got ${JSON.stringify(raw)})`);
  }
  return n;
}

function parseRounds(raw: string | undefined, fallback: number): number {
  const n = parsePositiveNumber(raw, fallback, "ROUNDS");
  if (!Number.isInteger(n)) {
    throw new Error(`ROUNDS must be an integer (got ${JSON.stringify(raw)})`);
  }
  return n;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Omit<
  BuyerAgentPocConfig,
  "fetch" | "log" | "logErr"
> {
  const privateKey = env.BUYER_PRIVATE_KEY?.trim();
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error(
      "BUYER_PRIVATE_KEY is required (0x-prefixed 32-byte hex). Export it in the shell — never commit it.",
    );
  }
  return {
    privateKey: privateKey as `0x${string}`,
    targetUrl:
      env.TARGET_URL?.trim() ||
      "https://x402-micro-tollgate.onrender.com/v1/quote",
    maxSingleUsdc: parsePositiveNumber(
      env.MAX_SINGLE_USDC,
      DEFAULT_MAX_SINGLE_SPEND_USDC,
      "MAX_SINGLE_USDC",
    ),
    maxTotalUsdc: parsePositiveNumber(
      env.MAX_TOTAL_USDC,
      DEFAULT_MAX_TOTAL_SPEND_USDC,
      "MAX_TOTAL_USDC",
    ),
    rounds: parseRounds(env.ROUNDS, 3),
  };
}

/**
 * Wrap fetch so we can report whether a 402 was auto-paid and session spend.
 * createX402Fetch keeps its own budget tracker; this only observes for CLI output.
 */
export function createObservingFetch(baseFetch: typeof globalThis.fetch): {
  fetch: typeof globalThis.fetch;
  getSessionSpendUsdc: () => number;
  consumeAutoPaid: () => boolean;
} {
  let sessionSpendUsdc = 0;
  let pendingAmountUsdc: number | undefined;
  let autoPaid = false;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const hasSig =
      req.headers.has("PAYMENT-SIGNATURE") ||
      req.headers.has("payment-signature");

    if (hasSig) {
      autoPaid = true;
      if (pendingAmountUsdc !== undefined) {
        sessionSpendUsdc += pendingAmountUsdc;
        pendingAmountUsdc = undefined;
      }
    }

    const res = await baseFetch(input, init);

    if (res.status === 402) {
      const hdr =
        res.headers.get("PAYMENT-REQUIRED") ??
        res.headers.get("payment-required");
      if (hdr) {
        try {
          const required = decodePaymentRequiredHeader(hdr);
          const accepts = required.accepts ?? [];
          let cheapest: number | undefined;
          for (const accept of accepts) {
            try {
              const usdc = usdcFromAccept(accept);
              if (cheapest === undefined || usdc < cheapest) cheapest = usdc;
            } catch {
              // skip malformed accept
            }
          }
          if (cheapest !== undefined) pendingAmountUsdc = cheapest;
        } catch {
          // leave pending unset; autoPaid still reflects signature retry
        }
      }
    }

    return res;
  };

  return {
    fetch,
    getSessionSpendUsdc: () => sessionSpendUsdc,
    consumeAutoPaid: () => {
      const v = autoPaid;
      autoPaid = false;
      return v;
    },
  };
}

export async function runBuyerAgentPoc(
  config: BuyerAgentPocConfig,
): Promise<RoundResult[]> {
  const log = config.log ?? ((line) => console.log(line));
  const logErr = config.logErr ?? ((line) => console.error(line));

  logErr(SAFETY_BANNER);
  logErr(
    `PoC config: target=${config.targetUrl} maxSingle=${config.maxSingleUsdc} maxTotal=${config.maxTotalUsdc} rounds=${config.rounds}`,
  );
  logErr(
    "Import path: local ../src/client (for published package use x402-micro-tollgate/client).",
  );

  const observer = createObservingFetch(
    config.fetch ?? globalThis.fetch.bind(globalThis),
  );

  const fetch402: X402Fetch = createX402Fetch({
    privateKey: config.privateKey,
    maxSingleSpendUsdc: config.maxSingleUsdc,
    maxTotalSpendUsdc: config.maxTotalUsdc,
    // PoC demonstrates session B_max; relax per-minute / fingerprint circuit so
    // the human total budget is the intentional stop (same URL every round).
    maxPaidRequestsPerMinute: Math.max(config.rounds * 2, 10),
    maxSpendUsdcPerMinute: Math.max(config.maxTotalUsdc * 10, 1),
    enableFingerprintBreaker: false,
    fetch: observer.fetch,
  });

  const results: RoundResult[] = [];

  for (let round = 1; round <= config.rounds; round++) {
    observer.consumeAutoPaid(); // reset per round
    try {
      const res = await fetch402(config.targetUrl);
      const autoPaid = observer.consumeAutoPaid();
      const sessionSpendUsdc = observer.getSessionSpendUsdc();
      const row: RoundResult = {
        round,
        status: res.status,
        autoPaid,
        sessionSpendUsdc,
      };
      results.push(row);
      log(
        JSON.stringify({
          round,
          status: res.status,
          autoPaid,
          sessionSpendUsdc: Number(sessionSpendUsdc.toFixed(6)),
          maxTotalUsdc: config.maxTotalUsdc,
        }),
      );

      if (sessionSpendUsdc >= config.maxTotalUsdc) {
        logErr(`Stopping: session spend reached maxTotalUsdc (${config.maxTotalUsdc}).`);
        results[results.length - 1]!.stopped = "budget";
        break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const budgetHit = /budget exceeded/i.test(message);
      const row: RoundResult = {
        round,
        status: null,
        autoPaid: observer.consumeAutoPaid(),
        sessionSpendUsdc: observer.getSessionSpendUsdc(),
        error: message,
        stopped: budgetHit ? "budget" : "error",
      };
      results.push(row);
      log(
        JSON.stringify({
          round,
          status: null,
          autoPaid: row.autoPaid,
          sessionSpendUsdc: Number(row.sessionSpendUsdc.toFixed(6)),
          error: message,
          stopped: row.stopped,
        }),
      );
      logErr(
        budgetHit
          ? `Stopping: budget exhausted — ${message}`
          : `Stopping: error — ${message}`,
      );
      break;
    }
  }

  if (results.length > 0 && !results[results.length - 1]!.stopped) {
    results[results.length - 1]!.stopped = "rounds";
  }

  logErr(
    `Done. rounds=${results.length} sessionSpendUsdc=${observer.getSessionSpendUsdc().toFixed(6)}`,
  );
  return results;
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const results = await runBuyerAgentPoc(config);
  const last = results[results.length - 1];
  if (last?.stopped === "error") {
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("buyer-agent-poc.ts") ||
    process.argv[1].endsWith("buyer-agent-poc.js"));

if (isDirectRun) {
  main().catch((err) => {
    console.error(SAFETY_BANNER);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
