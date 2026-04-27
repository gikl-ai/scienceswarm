import path from "node:path";

import type { RuntimeHostId } from "./contracts";
import { RuntimeHostError } from "./errors";

export type RuntimePathNamespace =
  | "project-relative"
  | "local-absolute"
  | "host-native";

export interface RuntimePathMapping {
  projectId: string;
  hostId: RuntimeHostId | string;
  projectRelativePath: string;
  localAbsolutePath: string;
  hostNativePath: string;
}

export interface RuntimePathMapperOptions {
  projectId: string;
  hostId: RuntimeHostId | string;
  projectRoot: string;
  hostWorkspaceRoot?: string;
}

export interface RuntimePathMapper {
  readonly projectId: string;
  readonly hostId: RuntimeHostId | string;
  readonly projectRoot: string;
  readonly hostWorkspaceRoot: string;
  fromProjectRelative(projectRelativePath: string): RuntimePathMapping;
  fromLocalAbsolute(localAbsolutePath: string): RuntimePathMapping;
  fromHostNative(hostNativePath: string): RuntimePathMapping;
}

function normalizeProjectRelativePath(value: string): string {
  const normalized = path.posix
    .normalize(value.replaceAll("\\", "/"))
    .replace(/^\/+/, "");
  if (
    normalized.length === 0
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("/../")
  ) {
    throw new RuntimeHostError({
      code: "RUNTIME_INVALID_REQUEST",
      status: 400,
      message: "Path escapes the study workspace.",
      userMessage: "Artifact path must stay inside the study workspace.",
      recoverable: true,
      context: { path: value },
    });
  }
  return normalized;
}

function normalizeHostPath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function ensureWithinRoot(input: {
  root: string;
  candidate: string;
  namespace: RuntimePathNamespace;
}): string {
  const root = path.resolve(input.root);
  const candidate = path.resolve(input.candidate);
  const relative = path.relative(root, candidate);
  if (
    relative === ""
    || (
      !relative.startsWith("..")
      && !path.isAbsolute(relative)
    )
  ) {
    return relative.split(path.sep).join("/");
  }

  const userMessage = input.namespace === "local-absolute"
    ? "Local artifact path must stay inside an allowed project or runtime root."
    : "Artifact path must stay inside the study workspace.";
  throw new RuntimeHostError({
    code: "RUNTIME_INVALID_REQUEST",
    status: 400,
    message: input.namespace === "local-absolute"
      ? "Path is outside the local workspace root."
      : "Path escapes the study workspace.",
    userMessage,
    recoverable: true,
    context: {
      root,
      candidate,
      namespace: input.namespace,
    },
  });
}

function ensureHostPathWithinRoot(input: {
  root: string;
  candidate: string;
}): string {
  const root = normalizeHostPath(input.root);
  const candidate = normalizeHostPath(input.candidate);
  const relative = path.posix.relative(root, candidate);
  if (
    relative === ""
    || (
      !relative.startsWith("..")
      && !path.posix.isAbsolute(relative)
    )
  ) {
    return relative;
  }

  throw new RuntimeHostError({
    code: "RUNTIME_INVALID_REQUEST",
    status: 400,
    message: "Path is outside the host workspace root.",
    userMessage: "Host artifact path must stay inside the runtime workspace.",
    recoverable: true,
    context: {
      root,
      candidate,
      namespace: "host-native",
    },
  });
}

function hostNativePathFor(input: {
  hostId: RuntimeHostId | string;
  hostWorkspaceRoot: string;
  localAbsolutePath: string;
  projectRelativePath: string;
}): string {
  if (input.hostId !== "openhands") {
    return input.localAbsolutePath;
  }
  return path.posix.join(
    normalizeHostPath(input.hostWorkspaceRoot),
    input.projectRelativePath,
  );
}

export function createRuntimePathMapper(
  options: RuntimePathMapperOptions,
): RuntimePathMapper {
  const projectRoot = path.resolve(options.projectRoot);
  const hostWorkspaceRoot = options.hostWorkspaceRoot
    ?? (options.hostId === "openhands" ? "/workspace" : projectRoot);

  return {
    projectId: options.projectId,
    hostId: options.hostId,
    projectRoot,
    hostWorkspaceRoot,

    fromProjectRelative(projectRelativePath: string): RuntimePathMapping {
      const normalized = normalizeProjectRelativePath(projectRelativePath);
      const localAbsolutePath = path.resolve(projectRoot, normalized);
      ensureWithinRoot({
        root: projectRoot,
        candidate: localAbsolutePath,
        namespace: "project-relative",
      });

      return {
        projectId: options.projectId,
        hostId: options.hostId,
        projectRelativePath: normalized,
        localAbsolutePath,
        hostNativePath: hostNativePathFor({
          hostId: options.hostId,
          hostWorkspaceRoot,
          localAbsolutePath,
          projectRelativePath: normalized,
        }),
      };
    },

    fromLocalAbsolute(localAbsolutePath: string): RuntimePathMapping {
      if (!path.isAbsolute(localAbsolutePath)) {
        throw new RuntimeHostError({
          code: "RUNTIME_INVALID_REQUEST",
          status: 400,
          message: "Expected a local absolute path.",
          userMessage: "Artifact path must be a local absolute path.",
          recoverable: true,
          context: {
            path: localAbsolutePath,
            namespace: "local-absolute",
          },
        });
      }
      const projectRelativePath = ensureWithinRoot({
        root: projectRoot,
        candidate: localAbsolutePath,
        namespace: "local-absolute",
      });
      return this.fromProjectRelative(projectRelativePath);
    },

    fromHostNative(hostNativePath: string): RuntimePathMapping {
      if (options.hostId !== "openhands") {
        return this.fromLocalAbsolute(hostNativePath);
      }
      const projectRelativePath = ensureHostPathWithinRoot({
        root: hostWorkspaceRoot,
        candidate: hostNativePath,
      });
      return this.fromProjectRelative(projectRelativePath);
    },
  };
}

export function isLocalPathWithinRoot(input: {
  root: string;
  candidate: string;
}): boolean {
  try {
    ensureWithinRoot({
      root: input.root,
      candidate: input.candidate,
      namespace: "local-absolute",
    });
    return true;
  } catch {
    return false;
  }
}

export function normalizeRuntimeProjectRelativePath(value: string): string {
  return normalizeProjectRelativePath(value);
}
