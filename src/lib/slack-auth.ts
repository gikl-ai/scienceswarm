import crypto from "crypto";

/**
 * Verify a Slack request signature to ensure the request came from Slack.
 * See: https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackRequest(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string
): boolean {
  // Reject requests older than 5 minutes to prevent replay attacks
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) {
    return false;
  }

  const basestring = `v0:${timestamp}:${body}`;
  const hash =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(basestring)
      .digest("hex");

  // Use timing-safe comparison to prevent timing attacks
  if (hash.length !== signature.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
}
