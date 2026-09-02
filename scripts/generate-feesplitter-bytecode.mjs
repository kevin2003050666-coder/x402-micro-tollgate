#!/usr/bin/env node
/**
 * Compile contracts/FeeSplitter.sol and write src/fee-splitter-bytecode.ts.
 * Requires: npm i -D solc  (or npx solc) — not needed for normal gateway runs.
 *
 *   node scripts/generate-feesplitter-bytecode.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const require = createRequire(import.meta.url);
let solc;
try {
  solc = require("solc");
} catch {
  console.error("Install solc first: npm i -D solc@0.8.28");
  process.exit(1);
}

const source = readFileSync(join(root, "contracts/FeeSplitter.sol"), "utf8");
const input = {
  language: "Solidity",
  sources: { "FeeSplitter.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
if (errors.length) {
  console.error(errors.map((e) => e.formattedMessage).join("\n"));
  process.exit(1);
}

const bc = out.contracts["FeeSplitter.sol"]["FeeSplitter"].evm.bytecode.object;
const hex = `0x${bc}`;
const dest = join(root, "src/fee-splitter-bytecode.ts");
writeFileSync(
  dest,
  `/**
 * FeeSplitter creation bytecode (no constructor args).
 * Generated with solc 0.8.x, optimizer runs=200, matching contracts/FeeSplitter.sol.
 * Re-run: node scripts/generate-feesplitter-bytecode.mjs
 */
export const FEE_SPLITTER_CREATION_BYTECODE =
  "${hex}" as \`0x\${string}\`;
`,
);
console.log(`Wrote ${dest} (${hex.length} chars)`);
