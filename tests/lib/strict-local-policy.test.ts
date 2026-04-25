import { describe, expect, it } from "vitest";

import {
  assertStrictLocalDestinationAllowed,
  evaluateStrictLocalDestination,
  StrictLocalPolicyError,
} from "@/lib/runtime";

describe("strict local destination policy", () => {
  it("allows hosted destinations when strict local-only mode is disabled", () => {
    const decision = evaluateStrictLocalDestination(
      {
        destination: "openai",
        dataClass: "model-prompt",
        feature: "direct chat",
      },
      {},
    );

    expect(decision).toMatchObject({
      allowed: true,
      strictLocalOnly: false,
      privacy: "hosted",
    });
  });

  it("blocks cloud model, critique, embedding, search, enrichment, and execution payloads in strict local-only mode", () => {
    const env = { SCIENCESWARM_STRICT_LOCAL_ONLY: "1" };

    for (const request of [
      { destination: "openai", dataClass: "model-prompt" },
      { destination: "anthropic", dataClass: "model-prompt" },
      { destination: "hosted-critique", dataClass: "critique-payload" },
      { destination: "hosted-embeddings", dataClass: "embedding-input" },
      { destination: "hosted-search", dataClass: "web-search-query" },
      { destination: "openhands-cloud", dataClass: "hosted-execution-payload" },
      { destination: "openai", dataClass: "import-enrichment-content" },
    ] as const) {
      expect(
        evaluateStrictLocalDestination(
          { ...request, feature: request.dataClass },
          env,
        ),
      ).toMatchObject({
        allowed: false,
        strictLocalOnly: true,
      });
    }
  });

  it("allows local runtime destinations in strict local-only mode", () => {
    const env = { SCIENCESWARM_STRICT_LOCAL_ONLY: "true" };

    expect(
      evaluateStrictLocalDestination(
        {
          destination: "local-ollama",
          dataClass: "model-prompt",
          feature: "local chat",
        },
        env,
      ),
    ).toMatchObject({
      allowed: true,
      privacy: "local-network",
    });

    expect(
      evaluateStrictLocalDestination(
        {
          destination: "local-gbrain",
          dataClass: "local-gbrain-data",
          feature: "gbrain write",
        },
        env,
      ),
    ).toMatchObject({
      allowed: true,
      privacy: "local-network",
    });
  });

  it("allows labeled non-model external setup and routing destinations", () => {
    const env = { SCIENCESWARM_STRICT_LOCAL_ONLY: "1" };

    for (const destination of [
      "ollama-registry",
      "telegram",
      "github",
      "arxiv",
    ] as const) {
      expect(
        evaluateStrictLocalDestination(
          {
            destination,
            dataClass: "setup-metadata",
            feature: destination,
          },
          env,
        ),
      ).toMatchObject({
        allowed: true,
        privacy: "external-network",
      });
    }
  });

  it("throws a typed error when callers assert a blocked destination", () => {
    expect(() =>
      assertStrictLocalDestinationAllowed(
        {
          destination: "hosted-critique",
          dataClass: "critique-payload",
          feature: "structured critique",
        },
        { SCIENCESWARM_STRICT_LOCAL_ONLY: "1" },
      ),
    ).toThrow(StrictLocalPolicyError);
  });
});
