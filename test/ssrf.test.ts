import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import {
  isBlockedIp,
  assertSafePublicHttpUrl,
  assertSafePublicHttpUrlPinned,
} from "../src/ssrf.js";

describe("isBlockedIp", () => {
  it("blocks IPv4 private, loopback, link-local, CGNAT, multicast", () => {
    const blocked = [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
      "224.0.0.1",
      "198.18.0.1",
    ];
    for (const ip of blocked) {
      assert.equal(isBlockedIp(ip), true, ip);
    }
  });

  it("allows public IPv4", () => {
    assert.equal(isBlockedIp("8.8.8.8"), false);
    assert.equal(isBlockedIp("1.1.1.1"), false);
    assert.equal(isBlockedIp("93.184.216.34"), false);
  });

  it("blocks IPv6 loopback, ULA, link-local, mapped private", () => {
    assert.equal(isBlockedIp("::1"), true);
    assert.equal(isBlockedIp("::"), true);
    assert.equal(isBlockedIp("fc00::1"), true);
    assert.equal(isBlockedIp("fd12:3456:789a::1"), true);
    assert.equal(isBlockedIp("fe80::1"), true);
    assert.equal(isBlockedIp("::ffff:127.0.0.1"), true);
    assert.equal(isBlockedIp("::ffff:10.1.2.3"), true);
    assert.equal(isBlockedIp("::ffff:192.168.0.1"), true);
  });

  it("allows public IPv6", () => {
    assert.equal(isBlockedIp("2001:4860:4860::8888"), false);
  });
});

describe("assertSafePublicHttpUrl", () => {
  it("rejects non-http schemes", async () => {
    await assert.rejects(
      () => assertSafePublicHttpUrl("file:///etc/passwd"),
      (err: Error & { code?: string }) => err.code === "invalid_scheme",
    );
    await assert.rejects(
      () => assertSafePublicHttpUrl("ftp://example.com/"),
      (err: Error & { code?: string }) => err.code === "invalid_scheme",
    );
  });

  it("rejects localhost and .internal hostnames", async () => {
    for (const raw of [
      "http://localhost/",
      "http://foo.localhost/x",
      "http://metadata.google.internal/",
      "http://service.local/",
    ]) {
      await assert.rejects(
        () => assertSafePublicHttpUrl(raw),
        (err: Error & { code?: string }) => err.code === "ssrf_blocked",
      );
    }
  });

  it("rejects literal private IPs", async () => {
    for (const raw of [
      "http://127.0.0.1/",
      "http://10.0.0.5/secret",
      "http://192.168.0.2/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
    ]) {
      await assert.rejects(
        () => assertSafePublicHttpUrl(raw),
        (err: Error & { code?: string }) => err.code === "ssrf_blocked",
      );
    }
  });

  it("rejects DNS that resolves to any private address", async () => {
    const resolve = async (): Promise<LookupAddress[]> => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ];
    await assert.rejects(
      () => assertSafePublicHttpUrl("http://evil.example/", { resolve }),
      (err: Error & { code?: string }) => err.code === "ssrf_blocked",
    );
  });

  it("allows hostname that resolves only to public IPs", async () => {
    const resolve = async (): Promise<LookupAddress[]> => [
      { address: "93.184.216.34", family: 4 },
    ];
    const safe = await assertSafePublicHttpUrl("https://example.com/path", { resolve });
    assert.equal(safe.url.hostname, "example.com");
    assert.equal(safe.addresses[0]?.address, "93.184.216.34");
  });
});

describe("assertSafePublicHttpUrlPinned (DNS rebinding)", () => {
  it("re-checks DNS and rejects if second lookup is private", async () => {
    let calls = 0;
    const resolve = async (): Promise<LookupAddress[]> => {
      calls += 1;
      if (calls <= 1) return [{ address: "93.184.216.34", family: 4 }];
      return [{ address: "127.0.0.1", family: 4 }];
    };
    await assert.rejects(
      () => assertSafePublicHttpUrlPinned("http://rebind.example/", { resolve }),
      (err: Error & { code?: string }) => err.code === "ssrf_blocked",
    );
    assert.ok(calls >= 2);
  });

  it("pins to overlapping public addresses across lookups", async () => {
    let calls = 0;
    const resolve = async (): Promise<LookupAddress[]> => {
      calls += 1;
      if (calls === 1) {
        return [
          { address: "1.1.1.1", family: 4 },
          { address: "8.8.8.8", family: 4 },
        ];
      }
      return [
        { address: "8.8.8.8", family: 4 },
        { address: "9.9.9.9", family: 4 },
      ];
    };
    const safe = await assertSafePublicHttpUrlPinned("https://stable.example/", { resolve });
    assert.deepEqual(
      safe.addresses.map((a) => a.address),
      ["8.8.8.8"],
    );
  });
});
