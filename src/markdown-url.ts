import { defaultUrlTransform } from "react-markdown";

const ASSET_URI = /^zhiye:\/\/asset\/([a-f0-9]{64})$/u;

export function assetHashFromUri(src: string | undefined) {
  if (!src) return null;
  const match = ASSET_URI.exec(src.trim());
  return match ? match[1]! : null;
}

export function markdownUrlTransform(url: string) {
  return assetHashFromUri(url) ? url : defaultUrlTransform(url);
}
