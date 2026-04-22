import type {
  RuntimeHostCapability,
  RuntimeHostId,
  RuntimeProjectPolicy,
  RuntimeTurnMode,
} from "./contracts";

export type RuntimeHostErrorCode =
  | "RUNTIME_HOST_UNKNOWN"
  | "RUNTIME_HOST_UNAVAILABLE"
  | "RUNTIME_HOST_AUTH_REQUIRED"
  | "RUNTIME_HOST_CAPABILITY_UNSUPPORTED"
  | "RUNTIME_PRIVACY_BLOCKED"
  | "RUNTIME_PREVIEW_APPROVAL_REQUIRED"
  | "RUNTIME_INVALID_REQUEST"
  | "RUNTIME_TRANSPORT_ERROR";

export interface RuntimeHostErrorContext {
  hostId?: RuntimeHostId | string;
  capability?: RuntimeHostCapability;
  mode?: RuntimeTurnMode;
  projectPolicy?: RuntimeProjectPolicy;
  [key: string]: unknown;
}

export class RuntimeHostError extends Error {
  readonly code: RuntimeHostErrorCode;
  readonly status: number;
  readonly userMessage: string;
  readonly recoverable: boolean;
  readonly context: RuntimeHostErrorContext;

  constructor(input: {
    code: RuntimeHostErrorCode;
    message: string;
    status: number;
    userMessage?: string;
    recoverable?: boolean;
    context?: RuntimeHostErrorContext;
  }) {
    super(input.message);
    this.name = "RuntimeHostError";
    this.code = input.code;
    this.status = input.status;
    this.userMessage = input.userMessage ?? input.message;
    this.recoverable = input.recoverable ?? false;
    this.context = input.context ?? {};
  }
}

export class RuntimeHostCapabilityUnsupported extends RuntimeHostError {
  constructor(input: {
    hostId: RuntimeHostId | string;
    capability: RuntimeHostCapability;
    mode?: RuntimeTurnMode;
  }) {
    super({
      code: "RUNTIME_HOST_CAPABILITY_UNSUPPORTED",
      status: 409,
      message: `Runtime host ${input.hostId} does not support ${input.capability}.`,
      userMessage: "This runtime does not support the requested action.",
      recoverable: true,
      context: input,
    });
    this.name = "RuntimeHostCapabilityUnsupported";
  }
}

export class RuntimePrivacyBlocked extends RuntimeHostError {
  constructor(input: {
    hostId: RuntimeHostId | string;
    projectPolicy: RuntimeProjectPolicy;
    mode: RuntimeTurnMode;
    reason: string;
  }) {
    super({
      code: "RUNTIME_PRIVACY_BLOCKED",
      status: 403,
      message: input.reason,
      userMessage: input.reason,
      recoverable: true,
      context: input,
    });
    this.name = "RuntimePrivacyBlocked";
  }
}

export class RuntimePreviewApprovalRequired extends RuntimeHostError {
  constructor(input: {
    hostId: RuntimeHostId | string;
    projectPolicy: RuntimeProjectPolicy;
    mode: RuntimeTurnMode;
  }) {
    super({
      code: "RUNTIME_PREVIEW_APPROVAL_REQUIRED",
      status: 428,
      message: `Runtime host ${input.hostId} requires preview approval before ${input.mode}.`,
      userMessage: "Approve the runtime preview before sending project content.",
      recoverable: true,
      context: input,
    });
    this.name = "RuntimePreviewApprovalRequired";
  }
}

export interface RuntimeApiError {
  status: number;
  body: {
    error: string;
    code: RuntimeHostErrorCode;
    recoverable: boolean;
  };
}

export function isRuntimeHostError(error: unknown): error is RuntimeHostError {
  return error instanceof RuntimeHostError;
}

export function mapRuntimeHostErrorToApiError(error: unknown): RuntimeApiError {
  if (isRuntimeHostError(error)) {
    return {
      status: error.status,
      body: {
        error: error.userMessage,
        code: error.code,
        recoverable: error.recoverable,
      },
    };
  }

  return {
    status: 500,
    body: {
      error: "Runtime host request failed.",
      code: "RUNTIME_TRANSPORT_ERROR",
      recoverable: false,
    },
  };
}

