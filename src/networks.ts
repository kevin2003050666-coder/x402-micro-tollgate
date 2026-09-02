/**
 * Network × asset matrix for x402 `exact` accepts.
 *
 * Honesty rules:
 * - Default active accept = primary Base USDC (dev: Base Sepolia) — Render-safe.
 * - CDP facilitator “live” networks per docs (Base, Polygon, Arbitrum, Solana, …).
 * - Optimism / BSC / Ethereum: config-ready asset addresses; facilitator-dependent.
 * - TRON: planned only — never emitted into `accepts[]` (no scheme in current deps).
 * - Solana: experimental stub unless operator opts in (`ACCEPTS_JSON` / `NETWORKS` + payTo).
 *
 * USDC: https://developers.circle.com/stablecoins/usdc-contract-addresses
 * USDT: Tether / chain explorers (bridged where no native); BSC-USD is 18 decimals.
 * CDP: https://docs.cdp.coinbase.com/x402/network-support
 */

export type AssetSymbol = "USDC" | "USDT";
export type FacilitatorStatus =
  | "live" // CDP facilitator documents this network for `exact`
  | "config-ready" // Addresses wired; settle depends on facilitator / operator
  | "experimental" // Partial wire (e.g. Solana paywall/scheme available, not default)
  | "planned"; // Documented only — never auto-added to accepts[]

export type TransferMethod = "eip3009" | "permit2" | "spl" | "none";

export type AssetEntry = {
  symbol: AssetSymbol;
  /** Contract address (EVM) or mint (Solana). */
  asset: string;
  decimals: number;
  /** EIP-712 token name (EVM) / display name. */
  name: string;
  /** EIP-712 version for EVM exact; omit for SVM. */
  version?: string;
  transferMethod: TransferMethod;
};

export type NetworkCatalogEntry = {
  network: string;
  label: string;
  family: "eip155" | "solana" | "tron";
  status: FacilitatorStatus;
  /** FeeSplitterFactory live on this chain in-repo. */
  factoryLive: boolean;
  assets: AssetEntry[];
  notes: string;
};

/** CAIP-2 / planned ids used in docs + env. */
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
/** Placeholder — not a facilitated x402 CAIP-2 in current deps. */
export const TRON_MAINNET_PLANNED = "tron:mainnet";

/** Human-friendly network aliases → CAIP-2 (env NETWORKS / X402_NETWORKS). */
export const NETWORK_ALIASES: Record<string, string> = {
  base: "eip155:8453",
  "base-mainnet": "eip155:8453",
  "base-sepolia": "eip155:84532",
  basesepolia: "eip155:84532",
  optimism: "eip155:10",
  op: "eip155:10",
  arbitrum: "eip155:42161",
  arb: "eip155:42161",
  polygon: "eip155:137",
  matic: "eip155:137",
  bsc: "eip155:56",
  bnb: "eip155:56",
  "bnb-smart-chain": "eip155:56",
  ethereum: "eip155:1",
  eth: "eip155:1",
  mainnet: "eip155:1",
  avalanche: "eip155:43114",
  "avalanche-c": "eip155:43114",
  avax: "eip155:43114",
  celo: "eip155:42220",
  sei: "eip155:1329",
  solana: SOLANA_MAINNET,
  "solana-mainnet": SOLANA_MAINNET,
  "solana-devnet": SOLANA_DEVNET,
  tron: TRON_MAINNET_PLANNED,
  trx: TRON_MAINNET_PLANNED,
};

export function normalizeNetworkId(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  const lower = t.toLowerCase();
  return NETWORK_ALIASES[lower] ?? t;
}

/**
 * Canonical catalog. Status reflects CDP facilitator docs + this repo’s wiring —
 * not a claim that every ERC-20 on every chain is production-settled here.
 */
export const NETWORK_CATALOG: Record<string, NetworkCatalogEntry> = {
  "eip155:8453": {
    network: "eip155:8453",
    label: "Base",
    family: "eip155",
    status: "live",
    factoryLive: true,
    notes: "CDP facilitator `exact`. Live FeeSplitterFactory in contracts/deployments/base.json.",
    assets: [
      {
        symbol: "USDC",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        decimals: 6,
        name: "USD Coin",
        version: "2",
        transferMethod: "eip3009",
      },
      {
        symbol: "USDT",
        asset: "0xfde4C96c8593536E31F1268f9C6E2eC6A3CEF3b2",
        decimals: 6,
        name: "Tether USD",
        version: "2",
        transferMethod: "permit2",
      },
    ],
  },
  "eip155:84532": {
    network: "eip155:84532",
    label: "Base Sepolia",
    family: "eip155",
    status: "live",
    factoryLive: false,
    notes: "CDP facilitator `exact` (testnet).",
    assets: [
      {
        symbol: "USDC",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        decimals: 6,
        name: "USDC",
        version: "2",
        transferMethod: "eip3009",
      },
    ],
  },
  "eip155:10": {
    network: "eip155:10",
    label: "Optimism",
    family: "eip155",
    status: "config-ready",
    factoryLive: false,
    notes: "Native USDC + bridged USDT addresses wired. Not listed on current CDP facilitator matrix — alternate facilitator or future CDP support required.",
    assets: [
      {
        symbol: "USDC",
        asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        decimals: 6,
        name: "USD Coin",
        version: "2",
        transferMethod: "eip3009",
      },
      {
        symbol: "USDT",
        asset: "0x94b008aA00579c1307B0AD2A4316A7eD9A5E2e5c",
        decimals: 6,
        name: "Tether USD",
        version: "2",
        transferMethod: "permit2",
      },
    ],
  },
  "eip155:42161": {
    network: "eip155:42161",
    label: "Arbitrum One",
    family: "eip155",
    status: "live",
    factoryLive: false,
    notes: "CDP facilitator `exact`. FeeSplitter factory config-ready (deploy optional).",
    assets: [
      {
        symbol: "USDC",
        asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        decimals: 6,
        name: "USD Coin",
        version: "2",
        transferMethod: "eip3009",
      },
      {
        symbol: "USDT",
        asset: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
        decimals: 6,
        name: "Tether USD",
        version: "2",
        transferMethod: "permit2",
      },
    ],
  },
  "eip155:137": {
    network: "eip155:137",
    label: "Polygon PoS",
    family: "eip155",
    status: "live",
    factoryLive: false,
    notes: "CDP facilitator `exact`. Native Circle USDC (not USDC.e).",
    assets: [
      {
        symbol: "USDC",
        asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        decimals: 6,
        name: "USD Coin",
        version: "2",
        transferMethod: "eip3009",
      },
      {
        symbol: "USDT",
        asset: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
        decimals: 6,
        name: "Tether USD",
        version: "1",
        transferMethod: "permit2",
      },
    ],
  },
  "eip155:56": {
    network: "eip155:56",
    label: "BNB Smart Chain",
    family: "eip155",
    status: "config-ready",
    factoryLive: false,
    notes: "Binance-peg USDC/USDT (18 decimals). Not on current CDP facilitator list — config + alternate facilitator only.",
    assets: [
      {
        symbol: "USDC",
        asset: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
        decimals: 18,
        name: "USD Coin",
        version: "2",
        transferMethod: "permit2",
      },
      {
        symbol: "USDT",
        asset: "0x55d398326f99059fF775485246999027B3197955",
        decimals: 18,
        name: "Tether USD",
        version: "2",
        transferMethod: "permit2",
      },
    ],
  },
  "eip155:1": {
    network: "eip155:1",
    label: "Ethereum",
    family: "eip155",
    status: "config-ready",
    factoryLive: false,
    notes: "Addresses in @x402/evm defaults. Not on current CDP facilitator CAIP-2 list — facilitator-dependent.",
    assets: [
      {
        symbol: "USDC",
        asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        decimals: 6,
        name: "USD Coin",
        version: "2",
        transferMethod: "eip3009",
      },
      {
        symbol: "USDT",
        asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        decimals: 6,
        name: "Tether USD",
        version: "1",
        transferMethod: "permit2",
      },
    ],
  },
  "eip155:43114": {
    network: "eip155:43114",
    label: "Avalanche C-Chain",
    family: "eip155",
    status: "config-ready",
    factoryLive: false,
    notes: "USDC in @x402/evm defaults. Not on current CDP facilitator matrix — config-ready / alternate facilitator.",
    assets: [
      {
        symbol: "USDC",
        asset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
        decimals: 6,
        name: "USD Coin",
        version: "2",
        transferMethod: "eip3009",
      },
      {
        symbol: "USDT",
        asset: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
        decimals: 6,
        name: "TetherToken",
        version: "1",
        transferMethod: "permit2",
      },
    ],
  },
  "eip155:42220": {
    network: "eip155:42220",
    label: "Celo",
    family: "eip155",
    status: "config-ready",
    factoryLive: false,
    notes: "USDC in @x402/evm defaults. Facilitator-dependent.",
    assets: [
      {
        symbol: "USDC",
        asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
        decimals: 6,
        name: "USDC",
        version: "2",
        transferMethod: "eip3009",
      },
    ],
  },
  "eip155:1329": {
    network: "eip155:1329",
    label: "Sei",
    family: "eip155",
    status: "config-ready",
    factoryLive: false,
    notes: "USDC in @x402/evm defaults. Facilitator-dependent.",
    assets: [
      {
        symbol: "USDC",
        asset: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392",
        decimals: 6,
        name: "USDC",
        version: "2",
        transferMethod: "eip3009",
      },
    ],
  },
  [SOLANA_MAINNET]: {
    network: SOLANA_MAINNET,
    label: "Solana",
    family: "solana",
    status: "experimental",
    factoryLive: false,
    notes: "CDP facilitator lists Solana `exact` + SPL USDC. This gateway stubs SVM accepts + optional `@x402/paywall` SVM UI; FeeSplitter is EVM-only.",
    assets: [
      {
        symbol: "USDC",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimals: 6,
        name: "USD Coin",
        transferMethod: "spl",
      },
      {
        symbol: "USDT",
        asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        decimals: 6,
        name: "Tether USD",
        transferMethod: "spl",
      },
    ],
  },
  [SOLANA_DEVNET]: {
    network: SOLANA_DEVNET,
    label: "Solana Devnet",
    family: "solana",
    status: "experimental",
    factoryLive: false,
    notes: "CDP lists Solana Devnet `exact`. Experimental in this gateway.",
    assets: [
      {
        symbol: "USDC",
        asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        decimals: 6,
        name: "USDC",
        transferMethod: "spl",
      },
    ],
  },
  [TRON_MAINNET_PLANNED]: {
    network: TRON_MAINNET_PLANNED,
    label: "TRON",
    family: "tron",
    status: "planned",
    factoryLive: false,
    notes: "No official x402 scheme/facilitator in current deps — do not fake settle. Env placeholder only; never emitted into accepts[].",
    assets: [
      {
        symbol: "USDT",
        asset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        decimals: 6,
        name: "Tether USD",
        transferMethod: "none",
      },
      {
        symbol: "USDC",
        asset: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8",
        decimals: 6,
        name: "USD Coin",
        transferMethod: "none",
      },
    ],
  },
};

/** @deprecated Prefer resolveAsset / NETWORK_CATALOG — kept for callers expecting USDC-only map. */
export const DEFAULT_USDC: Record<string, { asset: `0x${string}`; decimals: number; label: string; factoryLive: boolean }> =
  Object.fromEntries(
    Object.values(NETWORK_CATALOG)
      .filter((n) => n.family === "eip155")
      .map((n) => {
        const usdc = n.assets.find((a) => a.symbol === "USDC");
        if (!usdc) return null;
        return [
          n.network,
          {
            asset: usdc.asset as `0x${string}`,
            decimals: usdc.decimals,
            label: n.label,
            factoryLive: n.factoryLive,
          },
        ] as const;
      })
      .filter(Boolean) as Array<
      [
        string,
        { asset: `0x${string}`; decimals: number; label: string; factoryLive: boolean },
      ]
    >,
  );

export type AcceptSpec = {
  network: string;
  symbol: AssetSymbol;
  asset: string;
  decimals: number;
  name: string;
  version?: string;
  transferMethod: TransferMethod;
  status: FacilitatorStatus;
  /** Optional override payTo (required for Solana when seller is EVM-only). */
  payTo?: string;
};

export function isEip155(network: string): boolean {
  return /^eip155:\d+$/.test(network);
}

export function isSolana(network: string): boolean {
  return network.startsWith("solana:");
}

export function isPlannedNetwork(network: string): boolean {
  return NETWORK_CATALOG[network]?.status === "planned" || network.startsWith("tron:");
}

export function resolveAsset(
  network: string,
  symbol: AssetSymbol = "USDC",
): AssetEntry | undefined {
  return NETWORK_CATALOG[network]?.assets.find((a) => a.symbol === symbol);
}

export function usdcForNetwork(network: string): { asset: `0x${string}`; decimals: number } {
  const row = resolveAsset(network, "USDC");
  if (row && isEip155(network)) {
    return { asset: row.asset as `0x${string}`, decimals: row.decimals };
  }
  return {
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
  };
}

function parseListRaw(raw: string | undefined): string[] | undefined {
  if (!raw?.trim()) return undefined;
  const t = raw.trim();
  if (t.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      throw new Error(`Invalid JSON list: ${t}`);
    }
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
      throw new Error(`Expected JSON string array, got: ${t}`);
    }
    return parsed.map((s) => normalizeNetworkId(String(s))).filter(Boolean);
  }
  return t
    .split(/[,+\s]+/)
    .map((s) => normalizeNetworkId(s))
    .filter(Boolean);
}

function envFirst(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = env[k]?.trim();
    if (v) return v;
  }
  return undefined;
}

/**
 * Parse NETWORK / NETWORKS into primary + list (EVM + optional Solana).
 * Planned networks (TRON) are rejected here — use docs / health matrix only.
 * Aliases: X402_NETWORKS, X402_NETWORK; names like `base`, `optimism` accepted.
 */
export function parseNetworksList(
  env: NodeJS.ProcessEnv,
  fallbackPrimary: string,
): { network: string; networks: string[] } {
  const fromNetworksEnv = parseListRaw(
    envFirst(env, "NETWORKS", "X402_NETWORKS"),
  );
  const primaryOverride = envFirst(env, "NETWORK", "X402_NETWORK");
  const primaryNorm = primaryOverride
    ? normalizeNetworkId(primaryOverride)
    : undefined;

  let networks: string[];
  if (fromNetworksEnv && fromNetworksEnv.length > 0) {
    networks = fromNetworksEnv;
  } else if (primaryNorm) {
    networks = [primaryNorm];
  } else {
    networks = [fallbackPrimary];
  }

  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const n of networks) {
    if (isPlannedNetwork(n)) {
      throw new Error(
        `Network "${n}" is planned only (no x402 facilitator path in this build) — omit from NETWORKS / use docs matrix`,
      );
    }
    if (!isEip155(n) && !isSolana(n)) {
      throw new Error(
        `Invalid network "${n}" — expected eip155:<chainId>, solana:<genesis>, or alias (base, optimism, …)`,
      );
    }
    if (seen.has(n)) continue;
    seen.add(n);
    cleaned.push(n);
  }
  if (cleaned.length === 0) cleaned.push(fallbackPrimary);

  let network = cleaned[0]!;
  let ordered = cleaned;
  if (primaryNorm) {
    if (isPlannedNetwork(primaryNorm)) {
      throw new Error(`NETWORK "${primaryNorm}" is planned only — cannot be primary`);
    }
    if (!isEip155(primaryNorm) && !isSolana(primaryNorm)) {
      throw new Error(`Invalid NETWORK "${primaryNorm}"`);
    }
    ordered = [primaryNorm, ...cleaned.filter((n) => n !== primaryNorm)];
    network = primaryNorm;
  }

  return { network, networks: ordered };
}

/**
 * Build active accept specs.
 * Priority: ACCEPTS_JSON / X402_ACCEPTS_JSON → NETWORKS × ASSETS → primary USDC only.
 */
export function parseAcceptSpecs(
  env: NodeJS.ProcessEnv,
  networks: string[],
  primaryNetwork: string,
): AcceptSpec[] {
  const rawAccepts = envFirst(env, "ACCEPTS_JSON", "X402_ACCEPTS_JSON");
  if (rawAccepts) {
    return parseAcceptsJson(rawAccepts, env);
  }

  const assetsRaw =
    parseListRaw(envFirst(env, "ASSETS", "X402_ASSETS")) ?? ["USDC"];
  const symbols = assetsRaw.map((s) => s.toUpperCase());
  for (const s of symbols) {
    if (s !== "USDC" && s !== "USDT") {
      throw new Error(`Unsupported ASSETS entry "${s}" — only USDC and USDT in this MVP`);
    }
  }

  const specs: AcceptSpec[] = [];
  const nets = networks.length > 0 ? networks : [primaryNetwork];
  for (const network of nets) {
    if (isPlannedNetwork(network)) continue;
    const catalog = NETWORK_CATALOG[network];
    for (const sym of symbols as AssetSymbol[]) {
      const asset = catalog?.assets.find((a) => a.symbol === sym) ?? resolveAsset(network, sym);
      if (!asset) {
        throw new Error(`No canonical ${sym} for network ${network}`);
      }
      const spec: AcceptSpec = {
        network,
        symbol: sym,
        asset: asset.asset,
        decimals: asset.decimals,
        name: asset.name,
        version: asset.version,
        transferMethod: asset.transferMethod,
        status: catalog?.status ?? "config-ready",
      };
      if (isSolana(network)) {
        const payTo = envFirst(env, "SOLANA_PAY_TO", "X402_SOLANA_PAY_TO");
        if (!payTo) continue;
        spec.payTo = payTo;
      }
      specs.push(spec);
    }
  }

  if (specs.length === 0) {
    const usdc = resolveAsset(primaryNetwork, "USDC")!;
    specs.push({
      network: primaryNetwork,
      symbol: "USDC",
      asset: usdc.asset,
      decimals: usdc.decimals,
      name: usdc.name,
      version: usdc.version,
      transferMethod: usdc.transferMethod,
      status: NETWORK_CATALOG[primaryNetwork]?.status ?? "config-ready",
    });
  }

  return specs;
}

function parseAcceptsJson(raw: string, env: NodeJS.ProcessEnv): AcceptSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ACCEPTS_JSON: ${raw}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("ACCEPTS_JSON must be a non-empty JSON array");
  }

  const specs: AcceptSpec[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("ACCEPTS_JSON entries must be objects");
    }
    const r = row as Record<string, unknown>;
    const network = normalizeNetworkId(String(r.network ?? "").trim());
    const symbol = String(r.asset ?? r.symbol ?? "USDC").trim().toUpperCase() as AssetSymbol;
    if (isPlannedNetwork(network)) {
      throw new Error(
        `ACCEPTS_JSON includes planned network "${network}" — not facilitated; remove it`,
      );
    }
    if (symbol !== "USDC" && symbol !== "USDT") {
      throw new Error(`ACCEPTS_JSON asset must be USDC or USDT, got "${symbol}"`);
    }
    const catalog = NETWORK_CATALOG[network];
    const resolved = resolveAsset(network, symbol);
    if (!resolved && typeof r.address !== "string") {
      throw new Error(`Unknown network/asset ${network}/${symbol} — pass address override`);
    }
    const assetAddr =
      (typeof r.address === "string" && r.address.trim()) ||
      resolved!.asset;
    const decimals =
      typeof r.decimals === "number" ? r.decimals : (resolved?.decimals ?? 6);
    const name =
      (typeof r.name === "string" && r.name.trim()) || resolved?.name || symbol;
    const version =
      (typeof r.version === "string" && r.version) || resolved?.version;
    const transferMethod =
      (typeof r.transferMethod === "string" && r.transferMethod) ||
      resolved?.transferMethod ||
      (isSolana(network) ? "spl" : "eip3009");
    const payTo =
      (typeof r.payTo === "string" && r.payTo.trim()) ||
      (isSolana(network)
        ? env.SOLANA_PAY_TO?.trim() ||
          env.X402_SOLANA_PAY_TO?.trim()
        : undefined);
    if (isSolana(network) && !payTo) {
      throw new Error(
        `Solana accept requires payTo (entry.payTo or SOLANA_PAY_TO) — FeeSplitter is EVM-only`,
      );
    }
    specs.push({
      network,
      symbol,
      asset: assetAddr,
      decimals,
      name,
      version,
      transferMethod: transferMethod as TransferMethod,
      status: catalog?.status ?? "config-ready",
      payTo,
    });
  }
  return specs;
}

export function parseFactoryAddresses(
  env: NodeJS.ProcessEnv,
  primaryNetwork: string,
  tryParse: (raw: string) => `0x${string}` | undefined,
): {
  factoryAddress: `0x${string}` | undefined;
  factoryAddresses: Record<string, `0x${string}`>;
} {
  const map: Record<string, `0x${string}`> = {};
  const rawJson = env.FACTORY_ADDRESSES?.trim();
  if (rawJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new Error(`Invalid FACTORY_ADDRESSES JSON: ${rawJson}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("FACTORY_ADDRESSES must be a JSON object of caip2 → address");
    }
    for (const [caip, addr] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof addr !== "string" || !addr.trim()) continue;
      const parsedAddr = tryParse(addr.trim());
      if (!parsedAddr) {
        throw new Error(
          `Invalid FACTORY_ADDRESSES[${caip}]: "${addr}" is not a valid EVM address`,
        );
      }
      map[caip] = parsedAddr;
    }
  }

  const factoryRaw = env.FACTORY_ADDRESS?.trim();
  let factoryAddress: `0x${string}` | undefined;
  if (factoryRaw) {
    factoryAddress = tryParse(factoryRaw);
    if (!factoryAddress) {
      throw new Error(
        `Invalid FACTORY_ADDRESS: "${factoryRaw}" is not a valid EVM address (check EIP-55 checksum)`,
      );
    }
    if (!map[primaryNetwork]) {
      map[primaryNetwork] = factoryAddress;
    }
  } else if (map[primaryNetwork]) {
    factoryAddress = map[primaryNetwork];
  }

  return { factoryAddress, factoryAddresses: map };
}

/** Full honesty matrix for README /health (includes planned TRON). */
export function fullNetworkMatrixPublic(
  factoryAddresses: Record<string, `0x${string}`> = {},
): Array<{
  network: string;
  label: string;
  family: string;
  status: FacilitatorStatus;
  assets: Array<{ symbol: string; address: string; decimals: number; transferMethod: string }>;
  factoryAddress: string | null;
  factoryLive: boolean;
  notes: string;
}> {
  return Object.values(NETWORK_CATALOG).map((n) => ({
    network: n.network,
    label: n.label,
    family: n.family,
    status: n.status,
    assets: n.assets.map((a) => ({
      symbol: a.symbol,
      address: a.asset,
      decimals: a.decimals,
      transferMethod: a.transferMethod,
    })),
    factoryAddress: factoryAddresses[n.network] ?? null,
    factoryLive: n.factoryLive,
    notes: n.notes,
  }));
}

export function networkMatrixPublic(
  networks: string[],
  factoryAddresses: Record<string, `0x${string}`>,
): Array<{
  network: string;
  label: string;
  usdc: string | null;
  factoryAddress: `0x${string}` | null;
  factoryStatus: "live" | "config-ready" | "unknown";
}> {
  return networks.map((network) => {
    const row = NETWORK_CATALOG[network];
    const usdc = resolveAsset(network, "USDC");
    const factory = factoryAddresses[network];
    let factoryStatus: "live" | "config-ready" | "unknown" = "unknown";
    if (row?.factoryLive && factory) factoryStatus = "live";
    else if (row) factoryStatus = "config-ready";
    return {
      network,
      label: row?.label ?? network,
      usdc: usdc?.asset ?? null,
      factoryAddress: factory ?? null,
      factoryStatus,
    };
  });
}
