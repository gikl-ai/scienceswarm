import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveStandaloneServerEnv,
  resolveStandaloneServerPath,
} from "../../scripts/start-standalone.mjs";

describe("start-standalone", () => {
  it("maps frontend host and port into the standalone server env", () => {
    expect(resolveStandaloneServerEnv({
      FRONTEND_HOST: "0.0.0.0",
      FRONTEND_PORT: "4100",
    })).toMatchObject({
      HOSTNAME: "0.0.0.0",
      PORT: "4100",
    });
  });

  it("falls back to existing HOSTNAME and PORT values", () => {
    expect(resolveStandaloneServerEnv({
      HOSTNAME: "127.0.0.1",
      PORT: "3009",
    })).toMatchObject({
      HOSTNAME: "127.0.0.1",
      PORT: "3009",
    });
  });

  it("resolves the packaged standalone server location", () => {
    expect(resolveStandaloneServerPath("/tmp/scienceswarm")).toBe(
      path.join("/tmp/scienceswarm", ".next", "standalone", "server.js"),
    );
  });
});
