import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BUILTIN_DEMO_MERCHANTS,
  OPERATOR_FEE_COLLECTOR,
  loadMerchantsRegistry,
  merchantIdFromRequest,
  parseMerchantsRegistry,
  resolveMerchant,
  rewritePaymentRequiredPayTo,
  listMerchantsPublic,
} from "../src/merchants.js";

describe("merchants registry", () => {
  it("parses valid registry and rejects invalid addresses", () => {
    const ok = parseMerchantsRegistry({
      acme: {
        seller: "0x1111111111111111111111111111111111111111",
        payTo: "0x2222222222222222222222222222222222222222",
        label: "Acme",
      },
    });
    assert.equal(ok.acme?.seller, "0x1111111111111111111111111111111111111111");
    assert.equal(ok.acme?.payTo, "0x2222222222222222222222222222222222222222");

    assert.throws(
      () =>
        parseMerchantsRegistry({
          bad: { seller: "nope", payTo: "0x2222222222222222222222222222222222222222" },
        }),
      /seller/,
    );
  });

  it("loads from MERCHANTS_JSON", () => {
    const registry = loadMerchantsRegistry({
      MERCHANTS_JSON: JSON.stringify({
        shop: {
          seller: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          label: "Shop",
        },
      }),
    });
    assert.equal(registry.shop?.label, "Shop");
    assert.equal(Object.keys(registry).length, 1);
  });

  it("loads from MERCHANTS_FILE then falls back to built-in demo", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "merchants-"));
    try {
      const file = path.join(dir, "custom.json");
      writeFileSync(
        file,
        JSON.stringify({
          filem: {
            seller: "0xcccccccccccccccccccccccccccccccccccccccc",
            payTo: "0xdddddddddddddddddddddddddddddddddddddddd",
            label: "From file",
          },
        }),
      );
      const fromFile = loadMerchantsRegistry({ MERCHANTS_FILE: file }, dir);
      assert.equal(fromFile.filem?.label, "From file");

      const emptyDir = mkdtempSync(path.join(tmpdir(), "merchants-empty-"));
      try {
        const fallback = loadMerchantsRegistry({}, emptyDir);
        assert.deepEqual(fallback, BUILTIN_DEMO_MERCHANTS);
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves merchant from query, header, then default", () => {
    assert.equal(
      merchantIdFromRequest({ query: { merchant: "acme" }, header: () => undefined }, "demo"),
      "acme",
    );
    assert.equal(
      merchantIdFromRequest(
        {
          query: {},
          header: (name: string) =>
            name.toLowerCase() === "x-merchant-id" ? "Beta" : undefined,
        },
        "demo",
      ),
      "Beta",
    );
    assert.equal(
      merchantIdFromRequest({ query: {}, header: () => undefined }, "demo"),
      "demo",
    );
  });

  it("resolveMerchant returns unknown_merchant for missing ids", () => {
    const registry = BUILTIN_DEMO_MERCHANTS;
    const ok = resolveMerchant(
      { query: {}, header: () => undefined },
      registry,
      "demo",
    );
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.id, "demo");
      assert.equal(ok.merchant.payTo, BUILTIN_DEMO_MERCHANTS.demo.payTo);
    }

    const bad = resolveMerchant(
      { query: { merchant: "nope" }, header: () => undefined },
      registry,
      "demo",
    );
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error, "unknown_merchant");
  });

  it("rewrites accepts payTo and nested recipient", () => {
    const decoded: Record<string, unknown> = {
      accepts: [
        {
          payTo: "0x1111111111111111111111111111111111111111",
          recipient: "0x1111111111111111111111111111111111111111",
          extra: {
            recipient: "0x1111111111111111111111111111111111111111",
            payTo: "0x1111111111111111111111111111111111111111",
          },
        },
      ],
    };
    const next = "0x2222222222222222222222222222222222222222" as `0x${string}`;
    rewritePaymentRequiredPayTo(decoded, next);
    const accept = (decoded.accepts as Array<Record<string, unknown>>)[0]!;
    assert.equal(accept.payTo, next);
    assert.equal(accept.recipient, next);
    assert.equal((accept.extra as Record<string, unknown>).recipient, next);
    assert.equal((accept.extra as Record<string, unknown>).payTo, next);
  });

  it("optional mode returns empty registry when no file/env (seller path)", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "merchants-opt-"));
    try {
      const empty = loadMerchantsRegistry({}, emptyDir, { optional: true });
      assert.deepEqual(empty, {});
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("lists merchants without secrets", () => {
    const list = listMerchantsPublic(BUILTIN_DEMO_MERCHANTS);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], {
      id: "demo",
      label: BUILTIN_DEMO_MERCHANTS.demo.label,
      seller: OPERATOR_FEE_COLLECTOR,
      payTo: BUILTIN_DEMO_MERCHANTS.demo.payTo,
    });
  });
});
