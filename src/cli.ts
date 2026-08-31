#!/usr/bin/env node
/**
 * npm bin entry: `npx x402-micro-tollgate`
 *
 * Default: HTTP gateway + /mcp on PORT (8402)
 * --stdio: stdio MCP only (Cursor / Claude Desktop)
 * --port N: override PORT
 */
function printHelp(): void {
  console.log(`x402-micro-tollgate — x402 HTTP gateway + MCP server

Usage:
  npx x402-micro-tollgate              Start HTTP + /mcp (default port 8402)
  npx x402-micro-tollgate --stdio      Stdio MCP (for Cursor / Claude Desktop)
  npx x402-micro-tollgate --port 9000  Override listen port
  npx x402-micro-tollgate --help

Env (see .env.example):
  CDP_API_KEY_ID, CDP_API_KEY_SECRET, X402_PAY_TO, UPSTREAM_URL, PRICE, NETWORK
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const portIdx = args.findIndex((a) => a === "--port" || a === "-p");
  if (portIdx !== -1 && args[portIdx + 1]) {
    process.env.PORT = args[portIdx + 1];
  }

  if (args.includes("--stdio")) {
    await import("./mcp-stdio.js");
    return;
  }

  await import("./server.js");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
