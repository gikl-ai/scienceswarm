import { randomUUID } from "node:crypto";

import { readSavedLlmRuntimeEnv, type SavedLlmRuntimeEnv } from "@/lib/runtime-saved-env";

import type {
  ArtifactImportRequest,
  ResearchRuntimeHost,
  RuntimeCancelResult,
  RuntimeEvent,
  RuntimeHostAuthStatus,
  RuntimeHostHealth,
  RuntimeHostProfile,
  RuntimeHostPrivacyProof,
  RuntimePrivacyClass,
  RuntimeSessionRecord,
  RuntimeTurnRequest,
  RuntimeTurnResult,
} from "../contracts";
import { RuntimeHostCapabilityUnsupported, RuntimeHostError } from "../errors";
import {
  assertHostSupportsTurnMode,
  assertTurnPreviewAllowsPromptConstruction,
} from "../policy";
import { requireRuntimeHostProfile } from "../registry";

export type ApiKeyRuntimeProvider =
  | "anthropic"
  | "openai"
  | "google-ai"
  | "vertex-ai";

export interface ApiKeyRuntimeClient {
  sendTurn(request: RuntimeTurnRequest): Promise<{ message: string }>;
}

export interface ApiKeyRuntimeHostAdapterOptions {
  provider: ApiKeyRuntimeProvider;
  profile?: RuntimeHostProfile;
  env?: SavedLlmRuntimeEnv;
  cwd?: string;
  model?: string;
  client?: ApiKeyRuntimeClient;
  fetch?: typeof fetch;
  sessionIdGenerator?: () => string;
}

export class RuntimeApiKeyMissingError extends RuntimeHostError {
  constructor(input: { provider: ApiKeyRuntimeProvider }) {
    super({
      code: "RUNTIME_HOST_AUTH_REQUIRED",
      status: 401,
      message: `Missing ${input.provider} API key runtime configuration.`,
      userMessage: "Runtime host requires an API key in .env.",
      recoverable: true,
      context: {
        provider: input.provider,
        transportError: "API_KEY_MISSING",
      },
    });
    this.name = "RuntimeApiKeyMissingError";
  }
}

export class ApiKeyRuntimeHostAdapter implements ResearchRuntimeHost {
  private readonly provider: ApiKeyRuntimeProvider;
  private readonly runtimeProfile: RuntimeHostProfile;
  private readonly env: SavedLlmRuntimeEnv;
  private readonly model: string;
  private readonly client?: ApiKeyRuntimeClient;
  private readonly fetchImpl: typeof fetch;
  private readonly sessionIdGenerator: () => string;

  constructor(options: ApiKeyRuntimeHostAdapterOptions) {
    this.provider = options.provider;
    this.env = options.env ?? readSavedLlmRuntimeEnv(process.env, options.cwd);
    this.runtimeProfile = options.profile ?? createApiKeyRuntimeHostProfile(options.provider);
    this.model = options.model ?? defaultModelForProvider(options.provider);
    this.client = options.client;
    this.fetchImpl = options.fetch ?? fetch;
    this.sessionIdGenerator = options.sessionIdGenerator ?? (() => randomUUID());
  }

  profile(): RuntimeHostProfile {
    return this.runtimeProfile;
  }

  async health(): Promise<RuntimeHostHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.hasConfiguredCredential()) {
      return {
        status: "unavailable",
        checkedAt,
        detail: "API-key runtime is missing .env credentials.",
        evidence: [{ label: "provider", value: this.provider }],
      };
    }

    return {
      status: "ready",
      checkedAt,
      detail: "API-key runtime credentials are configured in .env.",
      evidence: [{ label: "provider", value: this.provider }],
    };
  }

  async authStatus(): Promise<RuntimeHostAuthStatus> {
    return {
      status: this.hasConfiguredCredential() ? "authenticated" : "missing",
      authMode: "api-key",
      provider: this.runtimeProfile.authProvider,
      accountLabel: this.hasConfiguredCredential()
        ? `${this.provider} API key configured in .env`
        : undefined,
      detail: this.hasConfiguredCredential()
        ? "ScienceSwarm found a configured API-key runtime credential without exposing the value."
        : "Add the provider API key to .env to enable this runtime.",
    };
  }

  async privacyProfile(): Promise<RuntimePrivacyClass | RuntimeHostPrivacyProof> {
    return {
      privacyClass: this.runtimeProfile.privacyClass,
      adapterProof: "declared-hosted",
      reason: "API-key runtime requests are sent to the configured hosted provider.",
      observedAt: new Date().toISOString(),
    };
  }

  async sendTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnResult> {
    this.assertCanSend(request);
    if (!this.hasConfiguredCredential()) {
      throw new RuntimeApiKeyMissingError({ provider: this.provider });
    }

    const result = this.client
      ? await this.client.sendTurn(request)
      : await this.sendViaFetch(request);
    const sessionId = request.conversationId
      ?? `${this.provider}-api-key-${this.sessionIdGenerator()}`;

    return {
      hostId: this.runtimeProfile.id,
      sessionId,
      message: result.message,
      events: [
        {
          id: `${sessionId}:final-message`,
          sessionId,
          hostId: this.runtimeProfile.id,
          type: "message",
          createdAt: new Date().toISOString(),
          payload: {
            text: result.message,
          },
        },
      ],
    };
  }

  async executeTask(request: RuntimeTurnRequest): Promise<RuntimeSessionRecord> {
    throw new RuntimeHostCapabilityUnsupported({
      hostId: this.runtimeProfile.id,
      capability: "task",
      mode: request.mode,
    });
  }

  async cancel(sessionId: string): Promise<RuntimeCancelResult> {
    return {
      sessionId,
      cancelled: false,
      detail: "API-key runtime requests cannot be cancelled after provider submission in this phase.",
    };
  }

  async listSessions(_projectId: string): Promise<RuntimeSessionRecord[]> {
    return [];
  }

  async *streamEvents(_sessionId: string): AsyncIterable<RuntimeEvent> {
    return;
  }

  async artifactImportHints(
    _sessionId: string,
  ): Promise<ArtifactImportRequest[]> {
    return [];
  }

  private assertCanSend(request: RuntimeTurnRequest): void {
    assertHostSupportsTurnMode(this.runtimeProfile, request.mode);
    assertTurnPreviewAllowsPromptConstruction(
      request.preview,
      request.approvalState === "approved",
    );
  }

  private hasConfiguredCredential(): boolean {
    return Boolean(this.credential());
  }

  private credential(): string | null {
    if (this.provider === "anthropic") return this.env.anthropicApiKey;
    if (this.provider === "openai") return this.env.openaiApiKey;
    if (this.provider === "google-ai") {
      return this.env.googleAiApiKey ?? this.env.googleApiKey;
    }
    return this.env.vertexAiApiKey ?? this.env.googleAiApiKey ?? this.env.googleApiKey;
  }

  private async sendViaFetch(
    request: RuntimeTurnRequest,
  ): Promise<{ message: string }> {
    if (this.provider === "anthropic") {
      return await this.sendAnthropic(request);
    }
    if (this.provider === "openai") {
      return await this.sendOpenAi(request);
    }
    if (this.provider === "google-ai") {
      return await this.sendGoogleAi(request);
    }
    return await this.sendVertexAi(request);
  }

  private async sendAnthropic(
    request: RuntimeTurnRequest,
  ): Promise<{ message: string }> {
    const response = await this.fetchJson("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.requireCredential(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        messages: [{ role: "user", content: request.prompt }],
      }),
    });

    return { message: extractProviderText(response) };
  }

  private async sendOpenAi(
    request: RuntimeTurnRequest,
  ): Promise<{ message: string }> {
    const response = await this.fetchJson("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.requireCredential()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: request.prompt,
      }),
    });

    return { message: extractProviderText(response) };
  }

  private async sendGoogleAi(
    request: RuntimeTurnRequest,
  ): Promise<{ message: string }> {
    const key = encodeURIComponent(this.requireCredential());
    const response = await this.fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: request.prompt }] }],
        }),
      },
    );

    return { message: extractProviderText(response) };
  }

  private async sendVertexAi(
    request: RuntimeTurnRequest,
  ): Promise<{ message: string }> {
    const project = this.env.vertexAiProject;
    const location = this.env.vertexAiLocation ?? "us-central1";
    if (!project) {
      throw new RuntimeHostError({
        code: "RUNTIME_HOST_AUTH_REQUIRED",
        status: 401,
        message: "Vertex AI runtime requires VERTEX_AI_PROJECT in .env.",
        userMessage: "Runtime host requires Vertex AI project configuration.",
        recoverable: true,
        context: {
          provider: this.provider,
          transportError: "API_KEY_MISSING",
        },
      });
    }

    const key = encodeURIComponent(this.requireCredential());
    const response = await this.fetchJson(
      `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${this.model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        }),
      },
    );

    return { message: extractProviderText(response) };
  }

  private requireCredential(): string {
    const value = this.credential();
    if (!value) throw new RuntimeApiKeyMissingError({ provider: this.provider });
    return value;
  }

  private async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(url, init);
    const body = await response.json() as unknown;
    if (!response.ok) {
      throw new RuntimeHostError({
        code: response.status === 401 || response.status === 403
          ? "RUNTIME_HOST_AUTH_REQUIRED"
          : "RUNTIME_TRANSPORT_ERROR",
        status: response.status,
        message: "API-key runtime provider request failed.",
        userMessage: response.status === 401 || response.status === 403
          ? "Runtime host rejected the configured API key."
          : "Runtime host provider request failed.",
        recoverable: true,
        context: {
          provider: this.provider,
          response: body,
        },
      });
    }
    return body;
  }
}

export function createApiKeyRuntimeHostAdapter(
  options: ApiKeyRuntimeHostAdapterOptions,
): ApiKeyRuntimeHostAdapter {
  return new ApiKeyRuntimeHostAdapter(options);
}

export function createApiKeyRuntimeHostProfile(
  provider: ApiKeyRuntimeProvider,
): RuntimeHostProfile {
  const base = requireRuntimeHostProfile(baseHostIdForProvider(provider));
  return {
    ...base,
    label: `${providerLabel(provider)} API Key`,
    authMode: "api-key",
    authProvider: provider,
    privacyClass: "hosted",
    transport: {
      kind: "http-api",
      protocol: "http",
      endpoint: endpointForProvider(provider),
    },
    controlSurface: {
      owner: "remote-provider",
      sessionIdSource: "scienceSwarm",
      supportsCancel: false,
      supportsResume: false,
      supportsNativeSessionList: false,
    },
    capabilities: base.capabilities.filter((capability) =>
      capability === "chat"
      || capability === "stream"
      || capability === "mcp-tools"
    ),
    requiresProjectPrivacy: "cloud-ok",
    storesTokensInScienceSwarm: "api-key-only",
    lifecycle: {
      status: "requires-auth",
      canStream: false,
      canCancel: false,
      canResumeNativeSession: false,
      canListNativeSessions: false,
      cancelSemantics: "none",
      resumeSemantics: "none",
    },
  };
}

function baseHostIdForProvider(
  provider: ApiKeyRuntimeProvider,
): RuntimeHostProfile["id"] {
  if (provider === "anthropic") return "claude-code";
  if (provider === "openai") return "codex";
  return "gemini-cli";
}

function providerLabel(provider: ApiKeyRuntimeProvider): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "openai") return "OpenAI";
  if (provider === "google-ai") return "Google AI";
  return "Vertex AI";
}

function endpointForProvider(provider: ApiKeyRuntimeProvider): string {
  if (provider === "anthropic") return "https://api.anthropic.com";
  if (provider === "openai") return "https://api.openai.com";
  if (provider === "google-ai") return "https://generativelanguage.googleapis.com";
  return "https://aiplatform.googleapis.com";
}

function defaultModelForProvider(provider: ApiKeyRuntimeProvider): string {
  if (provider === "anthropic") return "claude-sonnet-4-5";
  if (provider === "openai") return "gpt-5.4";
  if (provider === "google-ai") return "gemini-2.5-pro";
  return "gemini-2.5-pro";
}

function extractProviderText(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;
  const content = record.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const partRecord = part as Record<string, unknown>;
        return typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }

  const candidates = record.candidates;
  if (Array.isArray(candidates)) {
    const first = candidates[0] as Record<string, unknown> | undefined;
    const candidateContent = first?.content as Record<string, unknown> | undefined;
    const parts = candidateContent?.parts;
    if (Array.isArray(parts)) {
      return parts
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const partRecord = part as Record<string, unknown>;
          return typeof partRecord.text === "string" ? partRecord.text : "";
        })
        .filter(Boolean)
        .join("\n");
    }
  }

  const output = record.output;
  if (Array.isArray(output)) {
    return output
      .flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const itemRecord = item as Record<string, unknown>;
        return Array.isArray(itemRecord.content) ? itemRecord.content : [];
      })
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const itemRecord = item as Record<string, unknown>;
        return typeof itemRecord.text === "string" ? itemRecord.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}
