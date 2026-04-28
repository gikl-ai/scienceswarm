import { describe, expect, it } from "vitest";

import { buildRuntimeCapabilityContract } from "@/lib/runtime";

describe("runtime capability contract", () => {
  it("reports the clean no-key local path as ready when core local evidence is present", () => {
    const contract = buildRuntimeCapabilityContract({
      generatedAt: "2026-04-17T00:00:00.000Z",
      strictLocalOnly: false,
      llmProvider: "local",
      localModel: "gemma4:e4b",
      ollama: {
        running: true,
        models: ["gemma4:e4b"],
        url: "http://localhost:11434",
      },
      agent: { type: "openclaw", status: "connected" },
      openhands: {
        status: "connected",
        url: "http://localhost:3000",
        localModelConfigured: true,
        localModelVerified: true,
        gbrainWritebackVerified: true,
      },
      openaiKeyConfigured: false,
      structuredCritiqueConfigured: false,
      telegramConfigured: false,
      gbrain: {
        read: true,
        write: true,
        capture: true,
        maintenance: true,
        uploadFiles: true,
        localFolder: true,
      },
    });

    expect(contract).toMatchObject({
      generatedAt: "2026-04-17T00:00:00.000Z",
      strictLocalOnly: false,
      llmProvider: "local",
      configuredLocalModel: "gemma4:e4b",
      summary: { state: "ready" },
      legacy: {
        chat: true,
        codeExecution: true,
        github: true,
        multiChannel: true,
        structuredCritique: false,
      },
    });
    expect(
      contract.capabilities.find((capability) =>
        capability.capabilityId === "chat.local"
      ),
    ).toMatchObject({
      status: "ready",
      privacy: "local-network",
      provider: "ollama",
      model: "gemma4:e4b",
    });
    expect(
      contract.capabilities.find((capability) =>
        capability.capabilityId === "execution.openhands.local"
      ),
    ).toMatchObject({
      status: "ready",
      privacy: "local-network",
    });
    // execution.openhands.cloud was removed in the capability matrix simplification
    expect(
      contract.capabilities.find((capability) =>
        capability.capabilityId === "execution.openhands.cloud"
      ),
    ).toBeUndefined();
  });

  it("does not emit cloud or hosted critique capabilities in strict local-only mode", () => {
    const contract = buildRuntimeCapabilityContract({
      strictLocalOnly: true,
      llmProvider: "local",
      localModel: "gemma4",
      ollama: { running: true, models: ["gemma4:e4b"] },
      agent: { type: "openclaw", status: "connected" },
      openhands: {
        status: "connected",
        localModelConfigured: true,
        localModelVerified: true,
        gbrainWritebackVerified: true,
      },
      openaiKeyConfigured: true,
      structuredCritiqueConfigured: true,
      gbrain: {
        read: true,
        write: true,
        capture: true,
        maintenance: true,
        uploadFiles: true,
        localFolder: true,
      },
    });

    // Both capabilities were removed in the capability matrix simplification
    expect(
      contract.capabilities.find((capability) =>
        capability.capabilityId === "execution.openhands.cloud"
      ),
    ).toBeUndefined();
    expect(
      contract.capabilities.find((capability) =>
        capability.capabilityId === "structuredCritique.hosted"
      ),
    ).toBeUndefined();
    expect(contract.legacy.structuredCritique).toBe(false);
  });

  it("does not emit structuredCritique.hosted capability even when Descartes is configured", () => {
    const contract = buildRuntimeCapabilityContract({
      strictLocalOnly: false,
      llmProvider: "local",
      localModel: "gemma4",
      ollama: { running: true, models: ["gemma4:e4b"] },
      agent: { type: "none", status: "disconnected" },
      openhands: { status: "disconnected" },
      openaiKeyConfigured: false,
      structuredCritiqueConfigured: true,
      structuredCritiqueReady: false,
      structuredCritiqueProbe: {
        configured: true,
        ready: false,
        status: "auth_failed",
        detail: "Cloud Descartes rejected the configured credentials.",
        endpoint: "https://descartes.example/v1/ready",
        observedAt: "2026-04-17T00:00:00.000Z",
      },
    });

    // structuredCritique.hosted was removed from the capability matrix
    expect(
      contract.capabilities.find((capability) =>
        capability.capabilityId === "structuredCritique.hosted"
      ),
    ).toBeUndefined();
    expect(contract.legacy.structuredCritique).toBe(false);
  });

  it("reports strict-local provider misconfiguration when the saved provider is not local", () => {
    const contract = buildRuntimeCapabilityContract({
      strictLocalOnly: true,
      llmProvider: "openai",
      localModel: "gemma4",
      ollama: { running: true, models: ["gemma4:e4b"] },
      agent: { type: "openclaw", status: "connected" },
      openhands: {
        status: "connected",
        localModelConfigured: true,
        localModelVerified: true,
        gbrainWritebackVerified: true,
      },
      openaiKeyConfigured: true,
      structuredCritiqueConfigured: false,
    });

    expect(
      contract.capabilities.find((capability) =>
        capability.capabilityId === "setup.local"
      ),
    ).toMatchObject({
      status: "misconfigured",
      nextAction: "Set LLM_PROVIDER=local for the default no-key setup.",
    });
    expect(contract.summary.state).toBe("blocked");
  });

  it("does not treat NanoClaw as a ready agent chat backend after capability simplification", () => {
    const contract = buildRuntimeCapabilityContract({
      strictLocalOnly: false,
      llmProvider: "local",
      localModel: "gemma4",
      ollama: { running: true, models: ["gemma4:e4b"] },
      agent: { type: "nanoclaw", status: "connected" },
      openhands: { status: "disconnected" },
      openaiKeyConfigured: false,
      structuredCritiqueConfigured: false,
    });

    expect(
      contract.capabilities.find((capability) =>
        capability.capabilityId === "chat.openclaw"
      ),
    ).toMatchObject({
      label: "OpenClaw chat",
      status: "unavailable",
      provider: "nanoclaw",
    });
    // multiChannel is false because chat.openclaw is not ready
    expect(contract.legacy.multiChannel).toBe(false);
  });

  it("does not treat an installed chat model as OpenHands execution readiness without smoke evidence", () => {
    const contract = buildRuntimeCapabilityContract({
      strictLocalOnly: false,
      llmProvider: "local",
      localModel: "gemma4",
      ollama: { running: true, models: ["gemma4:e4b"] },
      agent: { type: "openclaw", status: "connected" },
      openhands: {
        status: "connected",
        localModelConfigured: true,
        localModelVerified: false,
        gbrainWritebackVerified: false,
      },
      openaiKeyConfigured: false,
      structuredCritiqueConfigured: false,
      gbrain: {
        read: true,
        write: true,
        capture: true,
        maintenance: true,
        uploadFiles: true,
        localFolder: true,
      },
    });

    expect(
      contract.capabilities.find((capability) =>
        capability.capabilityId === "chat.local"
      ),
    ).toMatchObject({ status: "ready" });
    expect(
      contract.capabilities.find((capability) =>
        capability.capabilityId === "execution.openhands.local"
      ),
    ).toMatchObject({
      status: "misconfigured",
      nextAction:
        "Run `npm run smoke:local -- --verify-openhands-local --verify-gbrain-writeback`.",
    });
    expect(contract.legacy.codeExecution).toBe(false);
  });

  it("falls back to the default local model when the saved model is blank", () => {
    const contract = buildRuntimeCapabilityContract({
      strictLocalOnly: false,
      llmProvider: "local",
      localModel: "   ",
      env: {},
      ollama: { running: true, models: ["gemma4:e4b"] },
      agent: { type: "openclaw", status: "connected" },
      openhands: { status: "disconnected" },
      openaiKeyConfigured: false,
      structuredCritiqueConfigured: false,
    });

    expect(contract.configuredLocalModel).toBe("gemma4:e4b");
    expect(
      contract.capabilities.find((capability) =>
        capability.capabilityId === "chat.local"
      ),
    ).toMatchObject({
      status: "ready",
      model: "gemma4:e4b",
    });
  });

  it("blocks local OpenHands execution when the configured context is too small", () => {
    const contract = buildRuntimeCapabilityContract({
      strictLocalOnly: false,
      llmProvider: "local",
      localModel: "gemma4:e4b",
      ollama: { running: true, models: ["gemma4:e4b"] },
      agent: { type: "openclaw", status: "connected" },
      openhands: {
        status: "connected",
        localModelConfigured: true,
        localModelVerified: true,
        gbrainWritebackVerified: true,
        contextLength: 4096,
        minimumContext: 22000,
      },
      openaiKeyConfigured: false,
      structuredCritiqueConfigured: false,
      gbrain: {
        read: true,
        write: true,
        capture: true,
        maintenance: true,
        uploadFiles: true,
        localFolder: true,
      },
    });

    expect(
      contract.capabilities.find((capability) =>
        capability.capabilityId === "execution.openhands.local"
      ),
    ).toMatchObject({
      status: "misconfigured",
      nextAction:
        "Set OLLAMA_CONTEXT_LENGTH to at least 22000 for local OpenHands execution.",
    });
    expect(contract.legacy.codeExecution).toBe(false);
  });

  it("translates missing local model into a blocked local chat capability", () => {
    const contract = buildRuntimeCapabilityContract({
      strictLocalOnly: true,
      llmProvider: "local",
      localModel: "gemma4",
      ollama: { running: true, models: ["qwen3:14b"] },
      agent: { type: "none", status: "disconnected" },
      openhands: { status: "disconnected" },
      openaiKeyConfigured: true,
      structuredCritiqueConfigured: true,
    });

    expect(
      contract.capabilities.find((capability) =>
        capability.capabilityId === "chat.local"
      ),
    ).toMatchObject({
      status: "blocked",
      nextAction: "Pull gemma4.",
    });
    expect(contract.summary.state).toBe("blocked");
    expect(contract.legacy.chat).toBe(false);
  });
});
