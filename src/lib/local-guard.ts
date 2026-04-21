import { headers } from "next/headers";

type HeaderReader = Pick<Headers, "get">;

function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";

  try {
    return new URL(`http://${trimmed}`).hostname.replace(/^\[(.*)]$/, "$1");
  } catch {
    if (trimmed === "::1" || trimmed.startsWith("::ffff:")) {
      return trimmed;
    }
    return trimmed.replace(/^\[(.*)]$/, "$1").replace(/:\d+$/, "");
  }
}

function normalizeIpv4MappedLoopback(value: string): string {
  if (!value.startsWith("::ffff:")) return value;

  const tail = value.slice("::ffff:".length);
  if (tail.startsWith("127.")) return tail;

  const hextets = tail.split(":");
  if (hextets.length !== 2 || hextets.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return value;
  }

  const packed = hextets.map((part) => part.padStart(4, "0")).join("");
  if (!/^[0-9a-f]{8}$/.test(packed)) return value;

  return [
    Number.parseInt(packed.slice(0, 2), 16),
    Number.parseInt(packed.slice(2, 4), 16),
    Number.parseInt(packed.slice(4, 6), 16),
    Number.parseInt(packed.slice(6, 8), 16),
  ].join(".");
}

function isLoopbackHost(value: string | null | undefined): boolean {
  if (!value) return false;
  const host = normalizeIpv4MappedLoopback(normalizeHost(value));
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function normalizeForwardedIp(value: string): string {
  const trimmed = value.trim().replace(/^"|"$/g, "");
  if (trimmed.startsWith("[") && trimmed.includes("]")) {
    return trimmed.slice(1, trimmed.indexOf("]"));
  }
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(trimmed)) {
    return trimmed.replace(/:\d+$/, "");
  }
  return trimmed;
}

function isLoopbackIp(value: string | null | undefined): boolean {
  if (!value) return false;
  const ip = normalizeIpv4MappedLoopback(normalizeForwardedIp(value).toLowerCase());
  return ip === "::1" || ip.startsWith("127.");
}

function normalizeOrigin(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function forwardedFor(headersReader: HeaderReader): string | null {
  const realIp = headersReader.get("x-real-ip");
  if (realIp) return realIp;

  const forwardedForHeader = headersReader.get("x-forwarded-for");
  if (forwardedForHeader) {
    const entries = forwardedForHeader
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return entries[entries.length - 1] ?? null;
  }

  const forwarded = headersReader.get("forwarded");
  if (forwarded) {
    const entries = forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const finalHop = entries[entries.length - 1] ?? "";
    const match = finalHop.match(/(?:^|;)\s*for=([^;]+)/i);
    return match?.[1]?.trim() ?? null;
  }

  return null;
}

function requestHost(headersReader: HeaderReader, request?: Request): string | null {
  const forwardedHost = headersReader.get("x-forwarded-host");
  if (forwardedHost) {
    return forwardedHost.split(",")[0]?.trim() || null;
  }

  const host = headersReader.get("host");
  if (host) return host;

  if (!request) return null;

  try {
    return new URL(request.url).host;
  } catch {
    return null;
  }
}

function requestOrigin(headersReader: HeaderReader, request?: Request): string | null {
  const host = requestHost(headersReader, request);
  if (host) {
    const protoHeader = headersReader.get("x-forwarded-proto");
    const proto = protoHeader?.split(",")[0]?.trim() || (() => {
      if (!request) return "http";
      try {
        return new URL(request.url).protocol.replace(/:$/, "");
      } catch {
        return "http";
      }
    })();

    return normalizeOrigin(`${proto}://${host}`);
  }

  if (!request) return null;

  try {
    return normalizeOrigin(new URL(request.url).origin);
  } catch {
    return null;
  }
}

function browserRequestOrigin(headersReader: HeaderReader): string | null {
  const directOrigin = normalizeOrigin(headersReader.get("origin"));
  if (directOrigin) return directOrigin;

  const referer = headersReader.get("referer");
  if (!referer) return null;

  try {
    return normalizeOrigin(new URL(referer).origin);
  } catch {
    return null;
  }
}

function isBrowserInitiatedRequest(headersReader: HeaderReader): boolean {
  return Boolean(
    headersReader.get("sec-fetch-site") ||
    headersReader.get("origin") ||
    headersReader.get("referer"),
  );
}

function isTrustedBrowserRequest(
  headersReader: HeaderReader,
  request?: Request,
): boolean {
  const fetchSite = headersReader.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite === "cross-site") {
    return false;
  }

  if (!isBrowserInitiatedRequest(headersReader)) {
    return true;
  }

  const origin = browserRequestOrigin(headersReader);
  if (!origin) {
    return fetchSite !== "cross-site";
  }

  let originHost: string;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    return false;
  }

  if (!isLoopbackHost(originHost)) {
    return false;
  }

  const targetOrigin = requestOrigin(headersReader, request);
  if (!targetOrigin) {
    return false;
  }

  try {
    return isLoopbackHost(new URL(targetOrigin).hostname);
  } catch {
    return false;
  }
}

/**
 * Check whether the current request originates from localhost.
 *
 * Local-only routes are safe only when the ScienceSwarm frontend itself is
 * bound to a loopback interface. `start.sh` and `npm run dev` set
 * FRONTEND_HOST=127.0.0.1 by default. Docker can bind the process to 0.0.0.0
 * internally while publishing only 127.0.0.1; in that case
 * FRONTEND_PUBLIC_HOST records the externally reachable bind host.
 */
export async function isLocalRequest(request?: Request): Promise<boolean> {
  const h: HeaderReader = request?.headers ?? await headers();
  const publicHost = process.env.FRONTEND_PUBLIC_HOST ?? process.env.FRONTEND_HOST;
  if (publicHost && !isLoopbackHost(publicHost)) {
    return false;
  }

  if (publicHost) {
    const host = requestHost(h, request);
    if (host && !isLoopbackHost(host)) {
      return false;
    }
  }

  const ip = forwardedFor(h);
  if (ip !== null) {
    return isLoopbackIp(ip) && isTrustedBrowserRequest(h, request);
  }

  if (publicHost) {
    return isLoopbackHost(publicHost) && isTrustedBrowserRequest(h, request);
  }

  if (request && process.env.NODE_ENV === "test") {
    // Runtime startup scripts set a frontend host; this fallback only keeps
    // request-object unit tests from depending on machine env state.
    try {
      return (
        isLoopbackHost(new URL(request.url).hostname) &&
        isTrustedBrowserRequest(h, request)
      );
    } catch {
      return false;
    }
  }

  return false;
}
