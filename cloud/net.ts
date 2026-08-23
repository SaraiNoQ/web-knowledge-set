import ipaddr from "ipaddr.js";

import { CloudHttpError } from "./extension";

/**
 * SSRF-safe resolution for a public HTTP(S) URL.
 *
 * Used for both capture targets and embedded image sources. It rejects URL
 * schemes other than public http/https, credentials, the loopback/local
 * hostnames, and any hostname that resolves to a non-unicast (private, local,
 * link-local, multicast) network range. The DNS query goes through
 * cloudflare-dns.com so the worker does not resolve via its own resolver and
 * can reject rewritten/literally-addressed hosts before any fetch.
 */
export async function publicUrl(input: unknown) {
  let url: URL;
  try { url = new URL(typeof input === "string" ? input.trim() : ""); }
  catch { throw new CloudHttpError(400, "INVALID_URL", "A valid HTTP or HTTPS URL is required"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.port === "0") {
    throw new CloudHttpError(400, "INVALID_URL", "A public HTTP or HTTPS URL is required");
  }
  url.hash = "";
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local") || ipaddr.isValid(hostname)) {
    throw new CloudHttpError(400, "BLOCKED_ADDRESS", "IP literals and local hostnames are blocked");
  }
  const answers = await Promise.all(["A", "AAAA"].map(async (type) => {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, { headers: { "Accept": "application/dns-json" }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new CloudHttpError(502, "DNS_FAILED", "Hostname resolution failed");
    const body = await response.json() as { Answer?: Array<{ type: number; data: string }> };
    return (body.Answer || []).filter((answer) => answer.type === 1 || answer.type === 28).map((answer) => answer.data);
  }));
  const addresses = answers.flat();
  if (!addresses.length || addresses.some((address) => !ipaddr.isValid(address) || ipaddr.process(address).range() !== "unicast")) {
    throw new CloudHttpError(400, "BLOCKED_ADDRESS", "Hostname resolved to a blocked network range");
  }
  return url.href;
}
