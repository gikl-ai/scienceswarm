import { isStrictLocalOnlyEnabled } from "@/lib/env-flags";
import type { RuntimePrivacyClass } from "@/lib/runtime/types";

export type RuntimeDataClass =
  | "model-prompt"
  | "critique-payload"
  | "embedding-input"
  | "query-expansion"
  | "web-search-query"
  | "hosted-execution-payload"
  | "import-enrichment-content"
  | "local-gbrain-data"
  | "model-pull"
  | "setup-metadata"
  | "telegram-message"
  | "github-metadata"
  | "arxiv-metadata";

export type RuntimeDestination =
  | "local-ollama"
  | "local-openclaw"
  | "local-openhands"
  | "local-gbrain"
  | "openai"
  | "anthropic"
  | "hosted-critique"
  | "hosted-embeddings"
  | "hosted-search"
  | "openhands-cloud"
  | "ollama-registry"
  | "telegram"
  | "github"
  | "arxiv"
  | "external-url";

export interface StrictLocalPolicyRequest {
  destination: RuntimeDestination;
  dataClass: RuntimeDataClass;
  feature: string;
  privacy?: RuntimePrivacyClass;
  explicitlyRequested?: boolean;
}

export interface StrictLocalPolicyDecision {
  allowed: boolean;
  strictLocalOnly: boolean;
  reason: string;
  privacy: RuntimePrivacyClass;
}

const LOCAL_DESTINATIONS = new Set<RuntimeDestination>([
  "local-ollama",
  "local-openclaw",
  "local-openhands",
  "local-gbrain",
]);

const HOSTED_DESTINATIONS = new Set<RuntimeDestination>([
  "openai",
  "anthropic",
  "hosted-critique",
  "hosted-embeddings",
  "hosted-search",
  "openhands-cloud",
]);

const STRICT_BLOCKED_DATA_CLASSES = new Set<RuntimeDataClass>([
  "model-prompt",
  "critique-payload",
  "embedding-input",
  "query-expansion",
  "web-search-query",
  "hosted-execution-payload",
  "import-enrichment-content",
]);

const LABELED_EXTERNAL_DESTINATIONS = new Set<RuntimeDestination>([
  "ollama-registry",
  "telegram",
  "github",
  "arxiv",
]);

function destinationPrivacy(
  request: StrictLocalPolicyRequest,
): RuntimePrivacyClass {
  if (request.privacy) return request.privacy;
  if (LOCAL_DESTINATIONS.has(request.destination)) return "local-network";
  if (HOSTED_DESTINATIONS.has(request.destination)) return "hosted";
  return "external-network";
}

export class StrictLocalPolicyError extends Error {
  readonly decision: StrictLocalPolicyDecision;
  readonly request: StrictLocalPolicyRequest;

  constructor(
    request: StrictLocalPolicyRequest,
    decision: StrictLocalPolicyDecision,
  ) {
    super(decision.reason);
    this.name = "StrictLocalPolicyError";
    this.request = request;
    this.decision = decision;
  }
}

export function evaluateStrictLocalDestination(
  request: StrictLocalPolicyRequest,
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
): StrictLocalPolicyDecision {
  const strictLocalOnly = isStrictLocalOnlyEnabled(env);
  const privacy = destinationPrivacy(request);

  if (!strictLocalOnly) {
    return {
      allowed: true,
      strictLocalOnly,
      privacy,
      reason: `${request.feature} is allowed because strict local-only mode is disabled.`,
    };
  }

  if (LOCAL_DESTINATIONS.has(request.destination)) {
    return {
      allowed: true,
      strictLocalOnly,
      privacy,
      reason: `${request.feature} stays on the local ScienceSwarm runtime.`,
    };
  }

  if (
    HOSTED_DESTINATIONS.has(request.destination)
    || STRICT_BLOCKED_DATA_CLASSES.has(request.dataClass)
  ) {
    return {
      allowed: false,
      strictLocalOnly,
      privacy,
      reason: `Strict local-only mode blocks ${request.feature} from sending ${request.dataClass} to ${request.destination}.`,
    };
  }

  if (LABELED_EXTERNAL_DESTINATIONS.has(request.destination)) {
    return {
      allowed: true,
      strictLocalOnly,
      privacy,
      reason: `${request.feature} is labeled external-network and is not a hosted model, critique, embedding, search, enrichment, or execution call.`,
    };
  }

  if (request.explicitlyRequested) {
    return {
      allowed: true,
      strictLocalOnly,
      privacy,
      reason: `${request.feature} is an explicitly requested external-network action.`,
    };
  }

  return {
    allowed: false,
    strictLocalOnly,
    privacy,
    reason: `Strict local-only mode requires an explicit label before ${request.feature} can use ${request.destination}.`,
  };
}

export function assertStrictLocalDestinationAllowed(
  request: StrictLocalPolicyRequest,
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
): StrictLocalPolicyDecision {
  const decision = evaluateStrictLocalDestination(request, env);
  if (!decision.allowed) {
    throw new StrictLocalPolicyError(request, decision);
  }
  return decision;
}
