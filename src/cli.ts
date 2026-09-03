#!/usr/bin/env node
/**
 * npm bin entry: `npx x402-micro-tollgate`
 *
 * Default: HTTP gateway + /mcp on PORT (8402)
 * --stdio: stdio MCP only (Cursor / Claude Desktop)
 * --seller / -s: set X402_PAY_TO before boot
 * --port N: override PORT
 */
import { applyCliEnv, parseCliArgs } from "./cli-args.js";

function printHelp(): void {
  // Help exits before MCP stdio; stdout is fine (banners stay on stderr).
  console.log(`x402-micro-tollgate — x402 HTTP gateway + MCP server

Usage:
  npx x402-micro-tollgate                         Start HTTP + /mcp (default port 8402)
  npx x402-micro-tollgate --stdio                 Stdio MCP (for Cursor / Claude Desktop)
  npx x402-micro-tollgate --seller 0x… --stdio    Stdio MCP with receive wallet
  npx x402-micro-tollgate -s 0x… --stdio          Same (short flag)
  npx x402-micro-tollgate --port 9000             Override listen port
  npx x402-micro-tollgate --help

Flags:
  --seller, -s <0x…>   Set X402_PAY_TO (EVM receive address) before boot
  --stdio              Stdio MCP transport only
  --port, -p <N>       Override PORT
  --help, -h           Show this help

Env (see .env.example; flags override when set):
  CDP_API_KEY_ID, CDP_API_KEY_SECRET, X402_PAY_TO, UPSTREAM_URL, PRICE, NETWORK
`);
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (opts.sellerMissingValue) {
    console.error("Error: --seller / -s requires a wallet address (0x…)");
    process.exit(1);
  }

  applyCliEnv(opts);

  if (opts.stdio) {
    await import("./mcp-stdio.js");
    return;
  }

  await import("./server.js");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
