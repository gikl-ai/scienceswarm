import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  evaluateStrictLocalDestination,
  type RuntimeDataClass,
  type RuntimeDestination,
} from "@/lib/runtime/strict-local-policy";
import type {
  RuntimeCapability,
  RuntimeCapabilityContract,
  RuntimeCapabilityStatus,
} from "@/lib/runtime";
import { getFrontendUrl } from "@/lib/config/ports";
import {
  buildOpenHandsLocalEvidenceSnapshot,
  readOpenHandsLocalEvidence,
  resolveOpenHandsLocalRuntimeConfig,
  writeOpenHandsLocalEvidence,
  type OpenHandsLocalSmokeEvidence,
} from "@/lib/runtime";

interface SmokeOptions {
  baseUrl: string;
  requireReady: boolean;
  json: boolean;
  verifyOpenHandsLocal: boolean;
  verifyGbrainWriteback: boolean;
  writebackProject: string;
}

interface SmokeResult {
  ok: boolean;
  baseUrl: string;
  summary: RuntimeCapabilityContract["summary"] | null;
  strictPolicyChecks: Array<{
    destination: RuntimeDestination;
    dataClass: RuntimeDataClass;
    blocked: boolean;
    reason: string;
  }>;
  capabilities: Array<{
    capabilityId: RuntimeCapability["capabilityId"];
    status: RuntimeCapabilityStatus;
    requiredForLocalGuarantee: boolean;
    nextAction?: string;
  }>;
  errors: string[];
  warnings: string[];
  openhandsProof?: {
    requested: boolean;
    localModelVerified: boolean;
    gbrainWritebackVerified: boolean;
    evidencePath?: string;
    errors: string[];
  };
}

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const STRICT_POLICY_CASES: Array<{
  destination: RuntimeDestination;
  dataClass: RuntimeDataClass;
  feature: string;
}> = [
  {
    destination: "openai",
    dataClass: "model-prompt",
    feature: "hosted model prompt",
  },
  {
    destination: "hosted-critique",
    dataClass: "critique-payload",
    feature: "hosted critique payload",
  },
  {
    destination: "hosted-embeddings",
    dataClass: "embedding-input",
    feature: "hosted embedding input",
  },
  {
    destination: "hosted-search",
    dataClass: "web-search-query",
    feature: "hosted web search query",
  },
  {
    destination: "openhands-cloud",
    dataClass: "hosted-execution-payload",
    feature: "hosted OpenHands execution payload",
  },
  {
    destination: "openai",
    dataClass: "query-expansion",
    feature: "hosted query expansion",
  },
  {
    destination: "openai",
    dataClass: "import-enrichment-content",
    feature: "hosted import enrichment content",
  },
];

function parseArgs(argv: string[]): SmokeOptions {
  let baseUrl = process.env.SCIENCESWARM_SMOKE_URL || getFrontendUrl();
  let requireReady = false;
  let json = false;
  let verifyOpenHandsLocal = false;
  let verifyGbrainWriteback = false;
  let writebackProject = "local-smoke";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-ready") {
      requireReady = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--verify-openhands-local") {
      verifyOpenHandsLocal = true;
      continue;
    }
    if (arg === "--verify-gbrain-writeback") {
      verifyGbrainWriteback = true;
      continue;
    }
    if (arg === "--writeback-project") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--writeback-project requires a value");
      }
      writebackProject = next;
      index += 1;
      continue;
    }
    if (arg === "--url") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--url requires a value");
      }
      baseUrl = next;
      index += 1;
      continue;
    }
    if (arg.startsWith("--url=")) {
      baseUrl = arg.slice("--url=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    requireReady,
    json,
    verifyOpenHandsLocal,
    verifyGbrainWriteback,
    writebackProject,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRuntimeContract(value: unknown): value is RuntimeCapabilityContract {
  if (!isObject(value)) return false;
  const legacy = value.legacy;
  const summary = value.summary;
  return (
    typeof value.generatedAt === "string"
    && typeof value.strictLocalOnly === "boolean"
    && typeof value.llmProvider === "string"
    && typeof value.configuredLocalModel === "string"
    && Array.isArray(value.capabilities)
    && value.capabilities.every((capability) =>
      isObject(capability)
      && typeof capability.capabilityId === "string"
      && typeof capability.status === "string"
      && typeof capability.requiredForLocalGuarantee === "boolean"
      && Array.isArray(capability.evidence)
    )
    && isObject(summary)
    && typeof summary.state === "string"
    && typeof summary.title === "string"
    && typeof summary.detail === "string"
    && isObject(legacy)
    && typeof legacy.chat === "boolean"
    && typeof legacy.codeExecution === "boolean"
    && typeof legacy.github === "boolean"
    && typeof legacy.multiChannel === "boolean"
    && typeof legacy.structuredCritique === "boolean"
  );
}

async function fetchRuntimeContract(
  baseUrl: string,
): Promise<RuntimeCapabilityContract> {
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`/api/health returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  if (!isObject(payload) || !isRuntimeContract(payload.runtimeContract)) {
    throw new Error("/api/health did not return a runtimeContract");
  }
  return payload.runtimeContract;
}

function runStrictPolicyChecks(): SmokeResult["strictPolicyChecks"] {
  const strictEnv = {
    ...process.env,
    SCIENCESWARM_STRICT_LOCAL_ONLY: "1",
  };
  return STRICT_POLICY_CASES.map((check) => {
    const decision = evaluateStrictLocalDestination(
      {
        ...check,
        privacy: "hosted",
      },
      strictEnv,
    );
    return {
      destination: check.destination,
      dataClass: check.dataClass,
      blocked: !decision.allowed,
      reason: decision.reason,
    };
  });
}

function summarizeCapabilities(
  contract: RuntimeCapabilityContract,
): SmokeResult["capabilities"] {
  return contract.capabilities.map((capability) => ({
    capabilityId: capability.capabilityId,
    status: capability.status,
    requiredForLocalGuarantee: capability.requiredForLocalGuarantee,
    nextAction: capability.nextAction,
  }));
}

function runDockerCurl(args: string[]): { ok: boolean; detail: string } {
  const image =
    process.env.SCIENCESWARM_OPENHANDS_PREFLIGHT_IMAGE
    || "curlimages/curl:8.13.0";
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--add-host=host.docker.internal:host-gateway",
      image,
      "-fsS",
      "-m",
      "20",
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status === 0) {
    return { ok: true, detail: result.stdout.trim() };
  }
  return {
    ok: false,
    detail:
      (result.stderr || result.stdout || result.error?.message || "docker curl failed")
        .trim(),
  };
}

async function runGbrainWritebackProof(project: string): Promise<{
  ok: boolean;
  detail: string;
}> {
  const uploadedBy = process.env.SCIENCESWARM_USER_HANDLE?.trim();
  if (!uploadedBy) {
    return {
      ok: false,
      detail:
        "SCIENCESWARM_USER_HANDLE must be set before running the gbrain writeback smoke.",
    };
  }
  const { writeBackOpenHandsFiles } = await import(
    "@/lib/openhands/gbrain-writeback"
  );
  const contents = new TextEncoder().encode(
    `ScienceSwarm OpenHands local writeback smoke ${new Date().toISOString()}\n`,
  );
  const result = await writeBackOpenHandsFiles({
    checkoutId: `smoke-${Date.now()}`,
    project,
    uploadedBy,
    files: [
      {
        relativePath: "runtime/openhands-local-smoke.txt",
        mime: "text/plain",
        sizeBytes: contents.byteLength,
        stream: new Blob([contents]).stream(),
      },
    ],
  });
  if (result.errors.length > 0 || result.created.length === 0) {
    return {
      ok: false,
      detail:
        result.errors.map((error) => error.message).join("; ")
        || "writeback smoke did not create a gbrain artifact",
    };
  }
  return { ok: true, detail: `created ${result.created[0]?.slug ?? "artifact"}` };
}

async function runOpenHandsProofs(
  contract: RuntimeCapabilityContract,
  options: SmokeOptions,
): Promise<SmokeResult["openhandsProof"]> {
  if (!options.verifyOpenHandsLocal && !options.verifyGbrainWriteback) {
    return undefined;
  }

  const runtime = resolveOpenHandsLocalRuntimeConfig(process.env);
  const errors: string[] = [];
  const existing = await readOpenHandsLocalEvidence();
  const existingSnapshot = buildOpenHandsLocalEvidenceSnapshot({
    evidence: existing,
  });
  let localModelVerified = existingSnapshot.localModelVerified;
  let gbrainWritebackVerified = existingSnapshot.gbrainWritebackVerified;

  if (options.verifyOpenHandsLocal) {
    const models = runDockerCurl([
      "-H",
      `Authorization: Bearer ${runtime.apiKey}`,
      `${runtime.baseUrl}/models`,
    ]);
    if (!models.ok) {
      errors.push(`Docker-to-Ollama /v1/models failed: ${models.detail}`);
    }

    const chat = runDockerCurl([
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json",
      "-H",
      `Authorization: Bearer ${runtime.apiKey}`,
      "-d",
      JSON.stringify({
        model: contract.configuredLocalModel,
        messages: [
          {
            role: "user",
            content: "Reply with the single word ok.",
          },
        ],
        stream: false,
        max_tokens: 4,
      }),
      `${runtime.baseUrl}/chat/completions`,
    ]);
    if (!chat.ok) {
      errors.push(`Docker-to-Ollama chat completion failed: ${chat.detail}`);
    }
    localModelVerified = models.ok && chat.ok;
  }

  if (options.verifyGbrainWriteback) {
    const writeback = await runGbrainWritebackProof(options.writebackProject);
    if (!writeback.ok) {
      errors.push(`gbrain writeback smoke failed: ${writeback.detail}`);
    }
    gbrainWritebackVerified = writeback.ok;
  }

  let evidencePath: string | undefined;
  if (localModelVerified || gbrainWritebackVerified) {
    const evidence: OpenHandsLocalSmokeEvidence = {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      localModel: contract.configuredLocalModel,
      openHandsModel: runtime.model,
      endpoint: runtime.baseUrl,
      contextLength: runtime.contextLength,
      minimumContext: runtime.minimumContext,
      localModelVerified,
      gbrainWritebackVerified,
      proof: {
        dockerToOllamaModels: localModelVerified,
        dockerToOllamaChat: localModelVerified,
        gbrainWriteback: gbrainWritebackVerified,
      },
    };
    evidencePath = await writeOpenHandsLocalEvidence(evidence);
  }

  return {
    requested: true,
    localModelVerified,
    gbrainWritebackVerified,
    evidencePath,
    errors,
  };
}

function buildResult(
  baseUrl: string,
  contract: RuntimeCapabilityContract,
  requireReady: boolean,
  openhandsProof?: SmokeResult["openhandsProof"],
): SmokeResult {
  const strictPolicyChecks = runStrictPolicyChecks();
  const capabilities = summarizeCapabilities(contract);
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const check of strictPolicyChecks) {
    if (!check.blocked) {
      errors.push(
        `Strict-local policy allowed ${check.dataClass} to ${check.destination}.`,
      );
    }
  }

  const required = contract.capabilities.filter(
    (capability) => capability.requiredForLocalGuarantee,
  );
  const blockedRequired = required.filter((capability) =>
    capability.status === "blocked" || capability.status === "misconfigured"
  );
  for (const capability of blockedRequired) {
    errors.push(
      `${capability.capabilityId} is ${capability.status}: ${capability.nextAction || "no next action"}`,
    );
  }

  const unavailableRequired = required.filter((capability) =>
    capability.status === "unavailable"
  );
  for (const capability of unavailableRequired) {
    const message =
      `${capability.capabilityId} is unavailable: ${capability.nextAction || "no next action"}`;
    if (requireReady) {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  }

  if (openhandsProof) {
    errors.push(...openhandsProof.errors);
  }

  return {
    ok: errors.length === 0,
    baseUrl,
    summary: contract.summary,
    strictPolicyChecks,
    capabilities,
    errors,
    warnings,
    openhandsProof,
  };
}

function printResult(result: SmokeResult): void {
  console.log("ScienceSwarm local smoke");
  console.log(`Endpoint: ${result.baseUrl}`);
  if (result.summary) {
    console.log(`Summary: ${result.summary.state} - ${result.summary.title}`);
    console.log(result.summary.detail);
  }

  console.log("\nStrict-local hosted-call policy");
  for (const check of result.strictPolicyChecks) {
    console.log(
      `- ${check.blocked ? "blocked" : "allowed"} ${check.dataClass} -> ${check.destination}`,
    );
  }

  console.log("\nRuntime capabilities");
  for (const capability of result.capabilities) {
    const required = capability.requiredForLocalGuarantee ? "required" : "optional";
    console.log(`- ${capability.capabilityId}: ${capability.status} (${required})`);
    if (capability.nextAction && capability.status !== "ready") {
      console.log(`  next: ${capability.nextAction}`);
    }
  }

  if (result.openhandsProof?.requested) {
    console.log("\nOpenHands local proof");
    console.log(
      `- local model: ${
        result.openhandsProof.localModelVerified ? "verified" : "not verified"
      }`,
    );
    console.log(
      `- gbrain writeback: ${
        result.openhandsProof.gbrainWritebackVerified
          ? "verified"
          : "not verified"
      }`,
    );
    if (result.openhandsProof.evidencePath) {
      console.log(`- evidence: ${result.openhandsProof.evidencePath}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log("\nWarnings");
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
  }

  if (result.errors.length > 0) {
    console.error("\nErrors");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
  }
}

async function main(): Promise<void> {
  loadEnvFile(resolve(process.cwd(), ".env"));

  let options: SmokeOptions = {
    baseUrl: (process.env.SCIENCESWARM_SMOKE_URL || getFrontendUrl()).replace(/\/+$/, ""),
    requireReady: false,
    json: false,
    verifyOpenHandsLocal: false,
    verifyGbrainWriteback: false,
    writebackProject: "local-smoke",
  };
  try {
    options = parseArgs(process.argv.slice(2));
    let contract = await fetchRuntimeContract(options.baseUrl);
    const openhandsProof = await runOpenHandsProofs(contract, options);
    if (openhandsProof?.evidencePath) {
      await new Promise((resolve) => setTimeout(resolve, 2100));
      contract = await fetchRuntimeContract(options.baseUrl);
    }
    const result = buildResult(
      options.baseUrl,
      contract,
      options.requireReady,
      openhandsProof,
    );
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printResult(result);
    }
    // The gbrain writeback smoke can leave PGLite/node handles open after the
    // proof is complete. This command is a one-shot CLI, so terminate after the
    // final report instead of hanging in a ready-but-never-exiting state.
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    const result: SmokeResult = {
      ok: false,
      baseUrl: options.baseUrl,
      summary: null,
      strictPolicyChecks: runStrictPolicyChecks(),
      capabilities: [],
      errors: [error instanceof Error ? error.message : "Local smoke failed"],
      warnings: [],
    };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printResult(result);
    }
    process.exit(1);
  }
}

void main();
