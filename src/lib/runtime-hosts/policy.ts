import type {
  RuntimeDataIncluded,
  RuntimeHostCapability,
  RuntimeHostId,
  RuntimeHostPrivacyProof,
  RuntimeHostProfile,
  RuntimePrivacyClass,
  RuntimeProjectPolicy,
  RuntimeTurnMode,
  TurnPreview,
} from "./contracts";
import {
  RuntimeHostCapabilityUnsupported,
  RuntimePreviewApprovalRequired,
  RuntimePrivacyBlocked,
} from "./errors";

interface HostPolicyDecision {
  host: RuntimeHostProfile;
  privacyClass: RuntimePrivacyClass;
  adapterProof: RuntimeHostPrivacyProof["adapterProof"];
  blockedReason: string | null;
}

export interface ComputeTurnPreviewRequest {
  projectPolicy: RuntimeProjectPolicy;
  host: RuntimeHostProfile;
  mode: RuntimeTurnMode;
  dataIncluded?: RuntimeDataIncluded[];
  selectedHosts?: RuntimeHostProfile[];
  adapterProof?: RuntimeHostPrivacyProof;
  hostProofs?: Partial<Record<RuntimeHostId, RuntimeHostPrivacyProof>>;
}

const PRIVACY_RANK: Record<RuntimePrivacyClass, number> = {
  "local-only": 0,
  "local-network": 1,
  hosted: 2,
  "external-network": 3,
};

const PROJECT_POLICY_RANK: Record<RuntimeProjectPolicy, number> = {
  "local-only": 0,
  "cloud-ok": 1,
  "execution-ok": 2,
};

const MODE_CAPABILITY: Record<RuntimeTurnMode, RuntimeHostCapability> = {
  chat: "chat",
  task: "task",
  compare: "chat",
  "mcp-tool": "mcp-tools",
  "artifact-import": "artifact-import",
};

function isLocalPrivacy(privacyClass: RuntimePrivacyClass): boolean {
  return privacyClass === "local-only" || privacyClass === "local-network";
}

function maxPrivacyClass(
  values: readonly RuntimePrivacyClass[],
): RuntimePrivacyClass {
  return values.reduce<RuntimePrivacyClass>((current, value) =>
    PRIVACY_RANK[value] > PRIVACY_RANK[current] ? value : current
  , "local-only");
}

function totalDataBytes(dataIncluded: readonly RuntimeDataIncluded[]): number {
  return dataIncluded.reduce((total, item) => total + (item.bytes ?? 0), 0);
}

function billingClass(profile: RuntimeHostProfile): TurnPreview["accountDisclosure"]["billingClass"] {
  if (profile.authMode === "api-key") return "api-key";
  if (profile.authMode === "subscription-native") return "subscription-native";
  return "local-compute";
}

function accountSource(profile: RuntimeHostProfile): TurnPreview["accountDisclosure"]["accountSource"] {
  if (profile.authMode === "api-key") return ".env";
  if (profile.authMode === "subscription-native") return "host-cli-login";
  if (profile.authProvider === "openhands") return "openhands";
  return "local-service";
}

function capabilityBlockReason(
  host: RuntimeHostProfile,
  mode: RuntimeTurnMode,
): string | null {
  const capability = MODE_CAPABILITY[mode];
  if (host.capabilities.includes(capability)) return null;
  return `${host.label} does not support ${mode} mode.`;
}

function destinationRiskCopy(privacyClass: RuntimePrivacyClass): string {
  if (privacyClass === "hosted") return "a third party";
  if (privacyClass === "external-network") return "an external network";
  return "a non-local destination";
}

function effectivePrivacyForHost(
  host: RuntimeHostProfile,
  proof?: RuntimeHostPrivacyProof,
): Pick<HostPolicyDecision, "privacyClass" | "adapterProof"> {
  if (!proof) {
    return {
      privacyClass: host.privacyClass,
      adapterProof: host.privacyClass === "hosted" || host.privacyClass === "external-network"
        ? "declared-hosted"
        : "declared-local",
    };
  }

  if (proof.adapterProof === "declared-local" && isLocalPrivacy(proof.privacyClass)) {
    return {
      privacyClass: proof.privacyClass,
      adapterProof: proof.adapterProof,
    };
  }

  if (proof.adapterProof === "declared-hosted") {
    return {
      privacyClass: maxPrivacyClass([host.privacyClass, proof.privacyClass]),
      adapterProof: proof.adapterProof,
    };
  }

  return {
    privacyClass: host.privacyClass,
    adapterProof: "unknown",
  };
}

function effectiveRequiredProjectPolicy(
  host: RuntimeHostProfile,
  privacyClass: RuntimePrivacyClass,
): RuntimeProjectPolicy {
  if (isLocalPrivacy(privacyClass) && host.requiresProjectPrivacy === "cloud-ok") {
    return "local-only";
  }
  return host.requiresProjectPrivacy;
}

function hostPolicyDecision(input: {
  projectPolicy: RuntimeProjectPolicy;
  host: RuntimeHostProfile;
  mode: RuntimeTurnMode;
  proof?: RuntimeHostPrivacyProof;
}): HostPolicyDecision {
  const capabilityReason = capabilityBlockReason(input.host, input.mode);
  const { privacyClass, adapterProof } = effectivePrivacyForHost(
    input.host,
    input.proof,
  );

  if (capabilityReason) {
    return {
      host: input.host,
      privacyClass,
      adapterProof,
      blockedReason: capabilityReason,
    };
  }

  if (input.projectPolicy === "local-only" && !isLocalPrivacy(privacyClass)) {
    return {
      host: input.host,
      privacyClass,
      adapterProof,
      blockedReason: `Local-only policy blocks ${input.host.label} because it would send data to ${destinationRiskCopy(privacyClass)}.`,
    };
  }

  const requiredProjectPolicy = effectiveRequiredProjectPolicy(
    input.host,
    privacyClass,
  );

  if (PROJECT_POLICY_RANK[input.projectPolicy] < PROJECT_POLICY_RANK[requiredProjectPolicy]) {
    return {
      host: input.host,
      privacyClass,
      adapterProof,
      blockedReason: `This project policy blocks ${input.mode} mode for ${input.host.label}; switch to ${requiredProjectPolicy} first.`,
    };
  }

  if (input.mode === "task" && !isLocalPrivacy(privacyClass) && input.projectPolicy !== "execution-ok") {
    return {
      host: input.host,
      privacyClass,
      adapterProof,
      blockedReason: `Task mode with ${input.host.label} would send data to ${destinationRiskCopy(privacyClass)}; switch to execution-ok first.`,
    };
  }

  return {
    host: input.host,
    privacyClass,
    adapterProof,
    blockedReason: null,
  };
}

function compareBlockReason(
  projectPolicy: RuntimeProjectPolicy,
  decisions: readonly HostPolicyDecision[],
): string | null {
  const blocked = decisions.find((decision) => decision.blockedReason);
  if (!blocked) return null;

  if (projectPolicy === "local-only" && !isLocalPrivacy(blocked.privacyClass)) {
    return `Compare includes ${blocked.host.label}, which would send data to ${destinationRiskCopy(blocked.privacyClass)}. Local-only projects can compare only local destinations.`;
  }

  return blocked.blockedReason;
}

export function computeTurnPreview(
  request: ComputeTurnPreviewRequest,
): TurnPreview {
  const dataIncluded = request.dataIncluded ?? [];
  const hosts = request.mode === "compare"
    ? request.selectedHosts?.length ? request.selectedHosts : [request.host]
    : [request.host];
  const decisions = hosts.map((host) =>
    hostPolicyDecision({
      projectPolicy: request.projectPolicy,
      host,
      mode: request.mode,
      proof: host.id === request.host.id
        ? request.adapterProof ?? request.hostProofs?.[host.id]
        : request.hostProofs?.[host.id],
    })
  );
  const effectivePrivacyClass = maxPrivacyClass(
    decisions.map((decision) => decision.privacyClass),
  );
  const blockReason = request.mode === "compare"
    ? compareBlockReason(request.projectPolicy, decisions)
    : decisions[0]?.blockedReason ?? null;
  const allowed = blockReason === null;
  const hasHostedOrExternalDestination = decisions.some((decision) =>
    !isLocalPrivacy(decision.privacyClass)
  );
  const requiresUserApproval = allowed
    && (
      hasHostedOrExternalDestination
      || request.mode === "task"
      || request.mode === "artifact-import"
    );
  return {
    allowed,
    projectPolicy: request.projectPolicy,
    hostId: request.host.id,
    mode: request.mode,
    effectivePrivacyClass,
    destinations: decisions.map((decision) => ({
      hostId: decision.host.id,
      label: decision.host.label,
      privacyClass: decision.privacyClass,
    })),
    dataIncluded,
    proof: {
      projectGatePassed: allowed,
      operationPrivacyClass: effectivePrivacyClass,
      adapterProof: decisions.some((decision) => decision.adapterProof === "unknown")
        ? "unknown"
        : decisions.some((decision) => decision.adapterProof === "declared-hosted")
          ? "declared-hosted"
          : "declared-local",
    },
    blockReason,
    requiresUserApproval,
    accountDisclosure: {
      authMode: request.host.authMode,
      provider: request.host.authProvider,
      billingClass: billingClass(request.host),
      accountSource: accountSource(request.host),
      estimatedRequestBytes: totalDataBytes(dataIncluded),
      compareFanOutCount: request.mode === "compare" ? hosts.length : undefined,
      costCopyRequired: request.host.authMode === "api-key",
    },
  };
}

export function assertTurnPreviewAllowsPromptConstruction(
  preview: TurnPreview,
  approved = false,
): void {
  if (!preview.allowed) {
    throw new RuntimePrivacyBlocked({
      hostId: preview.hostId,
      projectPolicy: preview.projectPolicy,
      mode: preview.mode,
      reason: preview.blockReason ?? "This request is blocked by the project policy.",
    });
  }

  if (preview.requiresUserApproval && !approved) {
    throw new RuntimePreviewApprovalRequired({
      hostId: preview.hostId,
      projectPolicy: preview.projectPolicy,
      mode: preview.mode,
    });
  }
}

export function assertHostSupportsTurnMode(
  host: RuntimeHostProfile,
  mode: RuntimeTurnMode,
): void {
  const capability = MODE_CAPABILITY[mode];
  if (!host.capabilities.includes(capability)) {
    throw new RuntimeHostCapabilityUnsupported({
      hostId: host.id,
      capability,
      mode,
    });
  }
}
