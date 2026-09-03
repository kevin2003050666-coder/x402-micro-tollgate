import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig, isFreePath, isGatedPath } from "../src/config.js";
import { createDemoPaymentLayer } from "../src/payment.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("llms.txt + OpenAPI SEO surfaces", () => {
  it("ships llms.txt and docs/openapi.yaml at known paths", () => {
    const llms = join(root, "llms.txt");
    const openapi = join(root, "docs/openapi.yaml");
    assert.equal(existsSync(llms), true);
    assert.equal(existsSync(openapi), true);
    const text = readFileSync(llms, "utf8");
    assert.match(text, /x402-micro-tollgate/);
    assert.match(text, /--seller/);
    assert.match(text, /PAYMENT-SIGNATURE/);
    assert.match(text, /PAYMENT-REQUIRED/);
    assert.match(text, /x402-micro-tollgate\.onrender\.com/);
    assert.doesNotMatch(text, /\bX-PAYMENT\b/);
    const spec = readFileSync(openapi, "utf8");
    assert.match(spec, /openapi:\s*3\.1\.0/);
    assert.match(spec, /PAYMENT-SIGNATURE/);
    assert.match(spec, /\/x402\/discover/);
    assert.match(spec, /\/health/);
    assert.match(spec, /\/mcp/);
  });

  it("treats /llms.txt paths as free", () => {
    assert.equal(isFreePath("/llms.txt"), true);
    assert.equal(isFreePath("/.well-known/llms.txt"), true);
    assert.equal(isGatedPath("/llms.txt", "/v1"), false);
    assert.equal(isGatedPath("/.well-known/llms.txt", "/v1"), false);
  });

  it("GET /llms.txt and /.well-known/llms.txt return the same plain text", async () => {
    const config = loadConfig({
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const a = await request(app).get("/llms.txt");
    const b = await request(app).get("/.well-known/llms.txt");
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.match(String(a.headers["content-type"]), /text\/plain/);
    assert.match(a.text, /npx x402-micro-tollgate@0\.3\.1 --seller/);
    assert.equal(a.text, b.text);
  });
});
