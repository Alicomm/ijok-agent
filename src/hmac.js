// HMAC-SHA256 signing helpers for the Agent Games protocol.
//
// Rules from the builder field guide:
//  - Verify the incoming signature against the RAW request body BEFORE
//    parsing or processing the task.
//  - Sign every response with the signature header over the RAW response body.
//  - The secret is the platform-generated value from "Rotate Secret" in the
//    dashboard — never a local placeholder.

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = (
  process.env.AGENT_GAMES_SIGNATURE_HEADER || "x-agent-games-signature"
).toLowerCase();

export function getSecret() {
  // The platform's starter prompt names this AGENT_GAMES_HMAC_SECRET;
  // AGENT_GAMES_SECRET is accepted as a fallback alias.
  return process.env.AGENT_GAMES_HMAC_SECRET || process.env.AGENT_GAMES_SECRET || "";
}

/** Compute the hex HMAC-SHA256 of a raw body (string or Buffer). */
export function signBody(rawBody, secret = getSecret()) {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Verify an incoming request.
 * @param {Buffer} rawBody exact bytes received
 * @param {string|undefined} signatureHeader value of the signature header
 * @returns {boolean}
 */
export function verifyRequest(rawBody, signatureHeader, secret = getSecret()) {
  if (!secret) {
    // Fail closed when no secret is configured, unless a developer
    // explicitly opts into unsigned local testing.
    return process.env.ALLOW_UNSIGNED_DEV === "1";
  }
  if (!signatureHeader || typeof signatureHeader !== "string") return false;
  const provided = signatureHeader.trim().toLowerCase().replace(/^sha256=/, "");
  const expected = signBody(rawBody, secret);
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
