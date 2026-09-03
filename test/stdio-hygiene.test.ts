import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("MCP stdio stdout hygiene", () => {
  it("HTTP boot listening banner uses stderr, not console.log", () => {
    const src = readSrc("src/server.ts");
    assert.equal(
      /console\.log\s*\(/.test(src),
      false,
      "server.ts must not write operational banners to stdout",
    );
    assert.match(src, /console\.error\s*\(/);
    assert.match(src, /x402-micro-tollgate listening/);
  });

  it("stdio MCP ready banner uses stderr", () => {
    const src = readSrc("src/mcp-stdio.ts");
    assert.equal(
      /console\.log\s*\(/.test(src),
      false,
      "mcp-stdio.ts must not write to stdout",
    );
    assert.match(src, /console\.error\s*\(/);
    assert.match(src, /MCP stdio ready/);
  });

  it("keeper default info logger uses stderr", () => {
    const src = readSrc("src/keeper.ts");
    assert.match(
      src,
      /info:\s*\(msg\)\s*=>\s*console\.error\(JSON\.stringify\(msg\)\)/,
    );
  });
});
