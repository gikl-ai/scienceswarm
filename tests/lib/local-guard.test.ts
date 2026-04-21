import { afterEach, describe, expect, it, vi } from "vitest";

import { isLocalRequest } from "@/lib/local-guard";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isLocalRequest", () => {
  it("allows direct loopback requests when the frontend is loopback-bound", async () => {
    vi.stubEnv("FRONTEND_HOST", "127.0.0.1");

    await expect(
      isLocalRequest(new Request("http://localhost:3001/api/setup")),
    ).resolves.toBe(true);
  });

  it("allows same-origin browser requests from localhost", async () => {
    vi.stubEnv("FRONTEND_HOST", "127.0.0.1");

    await expect(
      isLocalRequest(
        new Request("http://localhost:3001/api/setup", {
          headers: {
            origin: "http://localhost:3001",
            "sec-fetch-site": "same-origin",
          },
        }),
      ),
    ).resolves.toBe(true);
  });

  it("rejects cross-site browser requests even when they target localhost", async () => {
    vi.stubEnv("FRONTEND_HOST", "127.0.0.1");

    await expect(
      isLocalRequest(
        new Request("http://localhost:3001/api/setup", {
          headers: {
            origin: "https://evil.example",
            "sec-fetch-site": "cross-site",
          },
        }),
      ),
    ).resolves.toBe(false);
  });

  it("allows loopback browser requests when localhost and 127.0.0.1 differ", async () => {
    vi.stubEnv("FRONTEND_HOST", "127.0.0.1");

    await expect(
      isLocalRequest(
        new Request("http://127.0.0.1:3001/api/setup", {
          headers: {
            origin: "http://localhost:3001",
            "sec-fetch-site": "same-site",
          },
        }),
      ),
    ).resolves.toBe(true);
  });

  it("rejects headerless requests when the frontend is not loopback-bound", async () => {
    vi.stubEnv("FRONTEND_HOST", "0.0.0.0");

    await expect(
      isLocalRequest(new Request("http://localhost:3001/api/setup")),
    ).resolves.toBe(false);
  });

  it("allows Docker-style internal binds when the published host is loopback", async () => {
    vi.stubEnv("FRONTEND_HOST", "0.0.0.0");
    vi.stubEnv("FRONTEND_PUBLIC_HOST", "127.0.0.1");

    await expect(
      isLocalRequest(new Request("http://localhost:3001/api/setup")),
    ).resolves.toBe(true);
  });

  it("rejects Docker-internal service hostnames even when the published host is loopback", async () => {
    vi.stubEnv("FRONTEND_HOST", "0.0.0.0");
    vi.stubEnv("FRONTEND_PUBLIC_HOST", "127.0.0.1");

    await expect(
      isLocalRequest(new Request("http://frontend:3000/api/setup/reset")),
    ).resolves.toBe(false);
  });

  it("rejects Docker-internal service hostnames before forwarded IP headers", async () => {
    vi.stubEnv("FRONTEND_HOST", "0.0.0.0");
    vi.stubEnv("FRONTEND_PUBLIC_HOST", "127.0.0.1");

    await expect(
      isLocalRequest(
        new Request("http://frontend:3000/api/setup/reset", {
          headers: { "x-forwarded-for": "127.0.0.1" },
        }),
      ),
    ).resolves.toBe(false);
  });

  it("allows IPv4-mapped IPv6 loopback published hosts", async () => {
    vi.stubEnv("FRONTEND_HOST", "0.0.0.0");
    vi.stubEnv("FRONTEND_PUBLIC_HOST", "[::ffff:7f00:1]");

    await expect(
      isLocalRequest(new Request("http://localhost:3001/api/setup")),
    ).resolves.toBe(true);
  });

  it("allows IPv4-mapped IPv6 loopback forwarded clients", async () => {
    vi.stubEnv("FRONTEND_HOST", "127.0.0.1");

    await expect(
      isLocalRequest(
        new Request("http://localhost:3001/api/setup", {
          headers: { "x-forwarded-for": "::ffff:127.0.0.2" },
        }),
      ),
    ).resolves.toBe(true);
  });

  it("uses the rightmost forwarded-for entry", async () => {
    vi.stubEnv("FRONTEND_HOST", "127.0.0.1");

    await expect(
      isLocalRequest(
        new Request("http://localhost:3001/api/setup", {
          headers: { "x-forwarded-for": "127.0.0.1, 203.0.113.10" },
        }),
      ),
    ).resolves.toBe(false);
  });

  it("allows forwarded-for chains whose trusted final hop is loopback", async () => {
    vi.stubEnv("FRONTEND_HOST", "127.0.0.1");

    await expect(
      isLocalRequest(
        new Request("http://localhost:3001/api/setup", {
          headers: { "x-forwarded-for": "203.0.113.10, 127.0.0.1" },
        }),
      ),
    ).resolves.toBe(true);
  });

  it("rejects forwarded non-loopback clients", async () => {
    vi.stubEnv("FRONTEND_HOST", "127.0.0.1");

    await expect(
      isLocalRequest(
        new Request("http://localhost:3001/api/setup", {
          headers: { "x-forwarded-for": "203.0.113.10" },
        }),
      ),
    ).resolves.toBe(false);
  });

  it("rejects IPv4-mapped IPv6 non-loopback forwarded clients", async () => {
    vi.stubEnv("FRONTEND_HOST", "127.0.0.1");

    await expect(
      isLocalRequest(
        new Request("http://localhost:3001/api/setup", {
          headers: { "x-forwarded-for": "::ffff:192.168.0.1" },
        }),
      ),
    ).resolves.toBe(false);
  });
});
