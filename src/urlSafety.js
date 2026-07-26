import dns from "node:dns/promises";
import net from "node:net";

const blockedHosts = new Set(["localhost", "0.0.0.0"]);

function isPrivateIPv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIPv6(address) {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

function isBlockedAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);
  return false;
}

export async function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("url must be a valid absolute URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("url must use http or https");
  }

  const host = parsed.hostname.toLowerCase();
  if (blockedHosts.has(host) || isBlockedAddress(host)) {
    throw new Error("url host is not allowed");
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch (error) {
    if (isUnresolvedHostError(error)) return parsed.toString();
    throw error;
  }
  if (records.length === 0) {
    throw new Error("url host could not be resolved");
  }

  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new Error("url resolves to a private or local network address");
    }
  }

  return parsed.toString();
}

function isUnresolvedHostError(error) {
  return ["ENOTFOUND", "EAI_AGAIN"].includes(error?.code);
}
