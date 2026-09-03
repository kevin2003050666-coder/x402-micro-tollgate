/**
 * Optional FeeSplitter release keeper (OFF by default).
 *
 * When `KEEPER_ENABLED=true`, periodically reads USDC balances of merchant
 * FeeSplitter addresses (`payTo` from the registry) and calls `release()` when
 * balance >= `KEEPER_MIN_USDC` (default 1_000_000 = $1 USDC).
 *
 * Never enable on Render by default — gas for `release()` can exceed the 0.1%
 * fee on sub-cent payments; the min-balance gate exists for that reason.
 * Do not put private keys in the repo.
 *
 * Dry-run: `KEEPER_DRY_RUN=true` logs would-release without sending txs.
 * Live release needs `KEEPER_PRIVATE_KEY` + RPC (`KEEPER_RPC_URL` or public Base default).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { TollgateConfig } from "./config.js";
import type { MerchantRegistry } from "./merchants.js";

/** Default: $1 USDC (6 decimals). */
export const DEFAULT_KEEPER_MIN_USDC = 1_000_000n;
/** Default poll interval: 1 hour. */
export const DEFAULT_KEEPER_INTERVAL_MS = 3_600_000;

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const FEE_SPLITTER_ABI = [
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "asset",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/** Native Circle USDC per CAIP-2 network (same as gateway defaults). */
const USDC_BY_NETWORK: Record<string, Address> = {
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

const CHAIN_BY_NETWORK: Record<string, Chain> = {
  "eip155:84532": baseSepolia,
  "eip155:8453": base,
};

const DEFAULT_RPC_BY_NETWORK: Record<string, string> = {
  "eip155:84532": "https://sepolia.base.org",
  "eip155:8453": "https://mainnet.base.org",
};

export interface KeeperConfig {
  enabled: boolean;
  dryRun: boolean;
  privateKey: Hex | undefined;
  rpcUrl: string | undefined;
  intervalMs: number;
  minUsdc: bigint;
  network: string;
  merchants: MerchantRegistry;
}

export interface KeeperHandle {
  /** Stop the interval timer. */
  stop: () => void;
  /** Run one tick immediately (tests / ops). */
  tick: () => Promise<void>;
}

export function loadKeeperConfig(
  env: NodeJS.ProcessEnv,
  tollgate: Pick<TollgateConfig, "network" | "merchants">,
): KeeperConfig {
  const enabled = env.KEEPER_ENABLED?.trim().toLowerCase() === "true";
  // Explicit: KEEPER_DRY_RUN=true → dry; =false → live; unset → dry if no key, else live.
  const dryRunExplicit = env.KEEPER_DRY_RUN?.trim().toLowerCase();
  const privateKeyRaw = env.KEEPER_PRIVATE_KEY?.trim();
  const privateKey =
    privateKeyRaw && /^0x[a-fA-F0-9]{64}$/.test(privateKeyRaw)
      ? (privateKeyRaw as Hex)
      : undefined;

  let resolvedDryRun: boolean;
  if (dryRunExplicit === "true") {
    resolvedDryRun = true;
  } else if (dryRunExplicit === "false") {
    resolvedDryRun = false;
  } else {
    // Unset: never auto-send txs without a key — default to dry-run.
    resolvedDryRun = !privateKey;
  }

  const intervalRaw = Number(env.KEEPER_INTERVAL_MS);
  const intervalMs =
    Number.isFinite(intervalRaw) && intervalRaw >= 1_000
      ? Math.floor(intervalRaw)
      : DEFAULT_KEEPER_INTERVAL_MS;

  const minRaw = env.KEEPER_MIN_USDC?.trim();
  let minUsdc = DEFAULT_KEEPER_MIN_USDC;
  if (minRaw) {
    try {
      const parsed = BigInt(minRaw);
      if (parsed >= 0n) minUsdc = parsed;
    } catch {
      // keep default
    }
  }

  return {
    enabled,
    dryRun: resolvedDryRun,
    privateKey,
    rpcUrl: env.KEEPER_RPC_URL?.trim() || undefined,
    intervalMs,
    minUsdc,
    network: tollgate.network,
    merchants: tollgate.merchants,
  };
}

function uniquePayTos(merchants: MerchantRegistry): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const entry of Object.values(merchants)) {
    const addr = entry.payTo.toLowerCase() as Address;
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(entry.payTo);
  }
  return out;
}

export interface KeeperLogger {
  info: (msg: Record<string, unknown>) => void;
  error: (msg: Record<string, unknown>) => void;
}

const defaultLogger: KeeperLogger = {
  // Keep stdout free for MCP JSON-RPC when keeper runs alongside stdio/HTTP boot.
  info: (msg) => console.error(JSON.stringify(msg)),
  error: (msg) => console.error(JSON.stringify(msg)),
};

/**
 * Start the optional release keeper. Returns null when disabled or misconfigured.
 */
export function startFeeSplitterKeeper(
  config: KeeperConfig,
  logger: KeeperLogger = defaultLogger,
): KeeperHandle | null {
  if (!config.enabled) {
    return null;
  }

  const chain = CHAIN_BY_NETWORK[config.network];
  const fallbackUsdc = USDC_BY_NETWORK[config.network];
  const rpcUrl =
    config.rpcUrl ?? DEFAULT_RPC_BY_NETWORK[config.network];

  if (!chain || !rpcUrl) {
    logger.error({
      msg: "keeper_disabled",
      reason: "unsupported_network",
      network: config.network,
      hint: "Set KEEPER_RPC_URL and use eip155:8453 or eip155:84532, or extend keeper chain map.",
    });
    return null;
  }

  if (!config.dryRun && !config.privateKey) {
    logger.error({
      msg: "keeper_disabled",
      reason: "missing_private_key",
      hint: "Set KEEPER_PRIVATE_KEY for live release, or KEEPER_DRY_RUN=true.",
    });
    return null;
  }

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  const account = config.privateKey
    ? privateKeyToAccount(config.privateKey)
    : undefined;

  const walletClient =
    account && !config.dryRun
      ? createWalletClient({
          account,
          chain,
          transport: http(rpcUrl),
        })
      : undefined;

  const splitters = uniquePayTos(config.merchants);

  logger.info({
    msg: "keeper_started",
    dryRun: config.dryRun,
    intervalMs: config.intervalMs,
    minUsdc: config.minUsdc.toString(),
    network: config.network,
    splitterCount: splitters.length,
    // Never log the private key.
  });

  const tick = async (): Promise<void> => {
    for (const splitter of splitters) {
      try {
        let asset: Address = fallbackUsdc!;
        try {
          asset = (await publicClient.readContract({
            address: splitter,
            abi: FEE_SPLITTER_ABI,
            functionName: "asset",
          })) as Address;
        } catch {
          // Fall back to network default USDC if asset() is unavailable.
        }

        const balance = (await publicClient.readContract({
          address: asset,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [splitter],
        })) as bigint;

        if (balance < config.minUsdc) {
          logger.info({
            msg: "keeper_skip",
            splitter,
            balance: balance.toString(),
            minUsdc: config.minUsdc.toString(),
          });
          continue;
        }

        if (config.dryRun || !walletClient || !account) {
          logger.info({
            msg: "keeper_would_release",
            splitter,
            balance: balance.toString(),
            asset,
            dryRun: true,
          });
          continue;
        }

        const hash = await walletClient.writeContract({
          address: splitter,
          abi: FEE_SPLITTER_ABI,
          functionName: "release",
          account,
          chain,
        });

        logger.info({
          msg: "keeper_released",
          splitter,
          balance: balance.toString(),
          asset,
          txHash: hash,
        });
      } catch (err) {
        logger.error({
          msg: "keeper_tick_error",
          splitter,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, config.intervalMs);
  // Don't keep the process alive solely for the keeper in some hosts;
  // web server listen() already keeps it up.
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  // First tick shortly after start (don't block listen).
  void tick();

  return {
    stop: () => clearInterval(timer),
    tick,
  };
}
