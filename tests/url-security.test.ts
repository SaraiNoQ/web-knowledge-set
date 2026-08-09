import assert from "node:assert/strict";
import test from "node:test";

import { isPublicIp, validateUrl } from "../server/url-security.js";

test("accepts only credential-free HTTP URLs", () => {
  assert.equal(validateUrl("https://example.com/path#section").href, "https://example.com/path");
  assert.throws(() => validateUrl("file:///etc/passwd"), { code: "INVALID_URL" });
  assert.throws(() => validateUrl("https://user:secret@example.com"), { code: "INVALID_URL" });
  assert.throws(() => validateUrl("https://example.com:0"), { code: "INVALID_URL" });
});

test("rejects non-public IPv4 ranges", () => {
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "192.168.1.1", "192.0.2.1", "198.18.0.1", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "255.255.255.255",
  ]) assert.equal(isPublicIp(address), false, address);
  assert.equal(isPublicIp("1.1.1.1"), true);
  assert.equal(isPublicIp("8.8.8.8"), true);
});

test("rejects local, transition, documentation, and mapped IPv6 addresses", () => {
  for (const address of [
    "::", "::1", "fe80::1", "fc00::1", "ff02::1", "2001:db8::1", "2002:7f00:1::",
    "3fff::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254",
  ]) assert.equal(isPublicIp(address), false, address);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
  assert.equal(isPublicIp("::ffff:8.8.8.8"), true);
});
