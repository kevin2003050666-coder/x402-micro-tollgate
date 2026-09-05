import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig, isFreePath, isGatedPath } from "../src/config.js";
import { createDemoPaymentLayer } from "../src/payment.js";
import {
  BUILTIN_DEMO_MERCHANTS,
  OPERATOR_FEE_COLLECTOR,
} from "../src/merchants.js";
import { buildDiscoverDocument } from "../src/discover.js";
import {
  buildAgentCardDocument,
  buildX402WellKnownDocument,
  WELL_KNOWN_AGENT_ALIAS_PATH,
  WELL_KNOWN_AGENT_CARD_PATH,
  WELL_KNOWN_X402_ALIAS_PATH,
  WELL_KNOWN_X402_PATH,
} from "../src/well-known.js";
import { PACKAGE_VERSION } from "../src/version.js";

const TEST_SELLER = "0x1234567890123456789012345678901234567890";
const TEST_SPLITTER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

describe("well-known x402 + agent-card", () => {
  it("builds x402 manifest from discover services (no invented merchants)", () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://tollgate.example.com",
      NETWORK: "eip155:8453",
      PRICE: "$0.001",
      MERCHANTS_JSON: JSON.stringify({
        demo: {
          seller: OPERATOR_FEE_COLLECTOR,
          payTo: TEST_SPLITTER,
          label: "demo",
        },
      }),
    });
    const fixed = new Date("2026-09-05T05:00:00.000Z");
    const catalog = buildDiscoverDocument(config, fixed);
    const doc = buildX402WellKnownDocument(config, fixed);

    assert.equal(doc.x402Version, 2);
    assert.equal(doc.name, "x402-micro-tollgate");
    assert.equal(doc.version, PACKAGE_VERSION);
    assert.equal(doc.network, "eip155:8453");
    assert.equal(doc.updatedAt, catalog.updatedAt);
    assert.equal(doc.discover, "https://tollgate.example.com/x402/discover");
    assert.deepEqual(
      doc.services.map((s) => s.id),
      catalog.services.map((s) => s.id),
    );
    assert.equal(doc.services[0]?.payTo, TEST_SPLITTER);

    const quote = doc.resources.find((r) => r.resource.includes("/v1/quote"));
    assert.ok(quote);
    assert.equal(quote.type, "http");
    assert.equal(quote.accepts[0]?.amount, "1000");
    assert.equal(quote.accepts[0]?.payTo, TEST_SPLITTER);

    const fetchMd = doc.resources.find((r) => r.resource.endsWith("/v1/fetch-md"));
    assert.ok(fetchMd);
    assert.equal(fetchMd.type, "http");

    const mcpTools = doc.resources.filter((r) => r.type === "mcp");
    assert.equal(mcpTools.length, 3);
    assert.ok(
      mcpTools.every((r) => r.resource === "https://tollgate.example.com/mcp"),
    );
  });

  it("agent card points at MCP / OpenAPI / llms / x402 without PII", () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://tollgate.example.com",
      CONTACT_EMAIL: "secret@example.com",
    });
    const card = buildAgentCardDocument(config);
    assert.equal(card.name, "x402-micro-tollgate");
    assert.equal(card.version, PACKAGE_VERSION);
    assert.equal(card.url, "https://tollgate.example.com");
    assert.equal(card.discovery.mcp, "https://tollgate.example.com/mcp");
    assert.equal(card.discovery.openapi, "https://tollgate.example.com/openapi.yaml");
    assert.equal(card.discovery.llmsTxt, "https://tollgate.example.com/llms.txt");
    assert.equal(
      card.discovery.x402Discover,
      "https://tollgate.example.com/x402/discover",
    );
    assert.equal(
      card.discovery.x402WellKnown,
      "https://tollgate.example.com/.well-known/x402.json",
    );
    assert.equal(card.capabilities.x402, true);
    assert.equal(card.capabilities.mcp, true);
    assert.match(card.provider.organization, /independent OSS/i);
    assert.match(card.description, /not an official Coinbase product/i);
    const blob = JSON.stringify(card);
    assert.equal(blob.includes("secret@example.com"), false);
    assert.equal(blob.includes("2767111713"), false);
  });

  it("classifies well-known paths as free", () => {
    assert.equal(isFreePath(WELL_KNOWN_X402_PATH), true);
    assert.equal(isFreePath(WELL_KNOWN_X402_ALIAS_PATH), true);
    assert.equal(isFreePath(WELL_KNOWN_AGENT_CARD_PATH), true);
    assert.equal(isFreePath(WELL_KNOWN_AGENT_ALIAS_PATH), true);
    assert.equal(isGatedPath(WELL_KNOWN_X402_PATH, "/v1"), false);
    assert.equal(isGatedPath(WELL_KNOWN_AGENT_CARD_PATH, "/v1"), false);
  });

  it("GET well-known endpoints return 200 without payment", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://tollgate.example.com",
      MERCHANTS_JSON: JSON.stringify({
        demo: {
          seller: OPERATOR_FEE_COLLECTOR,
          payTo: BUILTIN_DEMO_MERCHANTS.demo.payTo,
          label: "demo",
        },
      }),
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const x402 = await request(app).get(WELL_KNOWN_X402_PATH);
    assert.equal(x402.status, 200);
    assert.equal(x402.body.x402Version, 2);
    assert.ok(Array.isArray(x402.body.resources));
    assert.equal(x402.headers["payment-required"], undefined);

    const x402Alias = await request(app).get(WELL_KNOWN_X402_ALIAS_PATH);
    assert.equal(x402Alias.status, 200);
    assert.equal(x402Alias.body.discover, x402.body.discover);

    const card = await request(app).get(WELL_KNOWN_AGENT_CARD_PATH);
    assert.equal(card.status, 200);
    assert.equal(card.body.discovery.mcp, "https://tollgate.example.com/mcp");
    assert.equal(card.headers["payment-required"], undefined);

    const cardAlias = await request(app).get(WELL_KNOWN_AGENT_ALIAS_PATH);
    assert.equal(cardAlias.status, 200);
    assert.equal(cardAlias.body.version, card.body.version);

    // Existing discover still works
    const discover = await request(app).get("/x402/discover");
    assert.equal(discover.status, 200);
    assert.deepEqual(
      discover.body.services.map((s: { id: string }) => s.id),
      x402.body.services.map((s: { id: string }) => s.id),
    );
  });
});
