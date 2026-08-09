import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

import type { CaptureErrorCode } from "../shared/types.js";

export class CapturePipelineError extends Error {
  readonly code: CaptureErrorCode;

  constructor(
    code: CaptureErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.name = "CapturePipelineError";
  }
}

export function isPublicIp(address: string): boolean {
  try {
    const parsed = ipaddr.process(address.replace(/^\[|\]$/g, ""));
    if (parsed.range() !== "unicast") return false;
    if (parsed.kind() !== "ipv6") return true;
    const bytes = parsed.toByteArray();
    return bytes[0] !== 0x3f || bytes[1] !== 0xff || (bytes[2]! & 0xf0) !== 0;
  } catch {
    return false;
  }
}

export function validateUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input) : new URL(input);
  } catch (cause) {
    throw new CapturePipelineError("INVALID_URL", "URL 格式无效", { cause });
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.port === "0") {
    throw new CapturePipelineError("INVALID_URL", "仅支持不含凭据的 HTTP/HTTPS URL");
  }
  url.hash = "";
  return url;
}

export interface PublicTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export async function resolvePublicTarget(input: string | URL): Promise<PublicTarget> {
  const url = validateUrl(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true }).catch((cause: unknown) => {
        throw new CapturePipelineError("HTTP_ERROR", `无法解析主机 ${hostname}`, { cause });
      });

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new CapturePipelineError("BLOCKED_ADDRESS", `已阻止非公网地址: ${hostname}`);
  }
  return { url, address: addresses[0]!.address, family: addresses[0]!.family as 4 | 6 };
}
