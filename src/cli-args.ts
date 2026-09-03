/**
 * CLI flag parsing for `x402-micro-tollgate` bin entry.
 * Kept side-effect free so tests can import without booting the server.
 */

export type CliOptions = {
  help: boolean;
  stdio: boolean;
  port?: string;
  /** EVM receive address → applied as `X402_PAY_TO` before server/MCP import. */
  seller?: string;
  /** True when `--seller` / `-s` was present but value was missing. */
  sellerMissingValue: boolean;
};

/**
 * Parse argv tokens (without `node` / script path).
 * Does not mutate env — call {@link applyCliEnv} after.
 */
export function parseCliArgs(args: string[]): CliOptions {
  const help = args.includes("--help") || args.includes("-h");
  const stdio = args.includes("--stdio");

  let port: string | undefined;
  const portIdx = args.findIndex((a) => a === "--port" || a === "-p");
  if (portIdx !== -1) {
    const value = args[portIdx + 1];
    if (value && !value.startsWith("-")) {
      port = value;
    }
  }

  let seller: string | undefined;
  let sellerMissingValue = false;
  const sellerIdx = args.findIndex((a) => a === "--seller" || a === "-s");
  if (sellerIdx !== -1) {
    const value = args[sellerIdx + 1];
    if (value && !value.startsWith("-")) {
      seller = value;
    } else {
      sellerMissingValue = true;
    }
  }

  return { help, stdio, port, seller, sellerMissingValue };
}

/**
 * Apply CLI overrides to env before dynamic-importing server / mcp-stdio.
 * Existing env vars are preserved unless an explicit flag overrides them.
 */
export function applyCliEnv(
  opts: Pick<CliOptions, "port" | "seller">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (opts.port) {
    env.PORT = opts.port;
  }
  if (opts.seller) {
    env.X402_PAY_TO = opts.seller;
  }
}
