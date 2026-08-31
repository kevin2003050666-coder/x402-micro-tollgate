#!/usr/bin/env node
/**
 * Stdio MCP entry (also: `npx x402-micro-tollgate --stdio`).
 * Usage: npx tsx src/mcp-stdio.ts   or   node dist/mcp-stdio.js
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createTollgateMcpServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, payment } = await createTollgateMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    JSON.stringify({
      msg: "x402-micro-tollgate MCP stdio ready",
      mode: payment.mode,
      network: config.network,
      price: config.price,
      payTo: payment.payTo,
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
