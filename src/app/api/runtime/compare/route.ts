import { RuntimeHostError } from "@/lib/runtime-hosts/errors";

import {
  approvalStateFromBody,
  assertPreviewAllowed,
  assertRuntimeApiLocalRequest,
  buildRuntimeTurnRequest,
  computeRuntimeApiPreview,
  dataIncludedFromBodyWithRuntimeContext,
  getRuntimeApiServices,
  optionalStringArrayField,
  optionalStringField,
  parseJsonObject,
  projectPolicyFromBody,
  requireSafeProjectId,
  requireStringArrayField,
  requireStringField,
  runtimeAdapterForApi,
  runtimeErrorResponse,
} from "../_shared";

type CompareChildResult = {
  sessionId: string;
  hostId: string;
  status: "completed" | "failed";
  message: string | null;
  error: string | null;
};

async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index]);
      }
    }),
  );

  return results;
}

export async function POST(request: Request): Promise<Response> {
  try {
    await assertRuntimeApiLocalRequest(request);
    const body = await parseJsonObject(request);
    const services = getRuntimeApiServices();
    const projectId = requireSafeProjectId(body.projectId);
    const projectPolicy = projectPolicyFromBody(body);
    const prompt = requireStringField(body, "prompt");
    const approvalState = approvalStateFromBody(body);
    const selectedHostIds = requireStringArrayField(body, "selectedHostIds");
    const synthesisHostId = optionalStringField(body, "synthesisHostId") ?? "openclaw";
    const conversationId = optionalStringField(body, "conversationId") ?? null;
    const inputFileRefs = optionalStringArrayField(body, "inputFileRefs") ?? [];
    const compareDataIncluded = dataIncludedFromBodyWithRuntimeContext({
      services,
      body,
      projectId,
      hostId: selectedHostIds[0],
      selectedHostIds,
    });

    const comparePreview = computeRuntimeApiPreview({
      services,
      hostId: selectedHostIds[0],
      projectPolicy,
      mode: "compare",
      dataIncluded: compareDataIncluded,
      selectedHostIds,
    });
    assertPreviewAllowed(comparePreview, approvalState);

    const childPreviews = selectedHostIds.map((hostId) => {
      const childDataIncluded = dataIncludedFromBodyWithRuntimeContext({
        services,
        body,
        projectId,
        hostId,
      });
      const preview = computeRuntimeApiPreview({
        services,
        hostId,
        projectPolicy,
        mode: "chat",
        dataIncluded: childDataIncluded,
      });
      assertPreviewAllowed(preview, approvalState);
      return preview;
    });

    const parent = services.sessionStore.createSession({
      hostId: synthesisHostId,
      projectId,
      conversationId,
      mode: "compare",
      status: "running",
      preview: comparePreview,
    });
    services.eventStore.appendEvent({
      id: `${parent.id}:compare-started`,
      sessionId: parent.id,
      hostId: synthesisHostId,
      type: "status",
      payload: {
        status: "running",
        selectedHostIds,
      },
    });

    const childSessions = selectedHostIds.map((hostId, index) =>
      services.sessionStore.createSession({
        hostId,
        projectId,
        conversationId,
        mode: "chat",
        status: "queued",
        preview: childPreviews[index],
      })
    );
    const childPreviewBySessionId = new Map(
      childSessions.map((child, index) => [child.id, childPreviews[index]]),
    );

    const maxChildren = services.concurrencyManager.snapshot().policy.compare.maxChildren;
    const childResults = await runBounded(
      childSessions,
      maxChildren,
      async (child): Promise<CompareChildResult> => {
        const slot = services.concurrencyManager.requestSlot({
          lane: "compare-child",
          sessionId: child.id,
          queue: false,
          metadata: {
            parentSessionId: parent.id,
            hostId: child.hostId,
          },
        });
        if (slot.state !== "running") {
          throw new RuntimeHostError({
            code: "RUNTIME_INVALID_REQUEST",
            status: 429,
            message: "Runtime compare child concurrency limit reached.",
            userMessage: "Too many runtime compare children are already running.",
            recoverable: true,
            context: {
              parentSessionId: parent.id,
              childSessionId: child.id,
            },
          });
        }

        try {
          services.sessionStore.updateSession(child.id, { status: "running" });
          services.eventStore.appendEvent({
            id: `${child.id}:compare-child-running`,
            sessionId: child.id,
            hostId: child.hostId,
            type: "status",
            payload: {
              status: "running",
              parentSessionId: parent.id,
            },
          });

          const adapter = runtimeAdapterForApi(child.hostId, services);
          if (!adapter) {
            throw new RuntimeHostError({
              code: "RUNTIME_HOST_UNKNOWN",
              status: 404,
              message: `No runtime adapter registered for ${child.hostId}.`,
              userMessage: "That runtime host is not available.",
              recoverable: true,
              context: { hostId: child.hostId },
            });
          }
          const childPreview = child.preview ?? childPreviewBySessionId.get(child.id);
          if (!childPreview) {
            throw new RuntimeHostError({
              code: "RUNTIME_INVALID_REQUEST",
              status: 500,
              message: `Runtime compare child ${child.id} is missing its preview.`,
              userMessage: "Runtime compare could not prepare one child preview.",
              recoverable: false,
              context: {
                childSessionId: child.id,
                hostId: child.hostId,
              },
            });
          }

          const result = await adapter.sendTurn(
            buildRuntimeTurnRequest({
              hostId: child.hostId,
              runtimeSessionId: child.id,
              projectId,
              conversationId: null,
              mode: "chat",
              prompt,
              promptHash: optionalStringField(body, "promptHash"),
              inputFileRefs,
              approvalState,
              preview: childPreview,
            }),
          );
          services.sessionStore.updateSession(child.id, {
            status: "completed",
            conversationId: result.sessionId,
          });
          services.eventStore.appendEvent({
            id: `${child.id}:compare-child-message`,
            sessionId: child.id,
            hostId: child.hostId,
            type: "message",
            payload: {
              text: result.message,
              parentSessionId: parent.id,
            },
          });
          services.eventStore.appendEvent({
            id: `${child.id}:compare-child-done`,
            sessionId: child.id,
            hostId: child.hostId,
            type: "done",
            payload: {
              status: "completed",
              parentSessionId: parent.id,
            },
          });
          return {
            sessionId: child.id,
            hostId: String(child.hostId),
            status: "completed",
            message: result.message,
            error: null,
          };
        } catch (error) {
          services.sessionStore.trySetSessionStatus({
            sessionId: child.id,
            status: "failed",
            errorCode: error instanceof RuntimeHostError
              ? error.code
              : "RUNTIME_TRANSPORT_ERROR",
          });
          services.eventStore.appendEvent({
            id: `${child.id}:compare-child-error`,
            sessionId: child.id,
            hostId: child.hostId,
            type: "error",
            payload: {
              code: error instanceof RuntimeHostError
                ? error.code
                : "RUNTIME_TRANSPORT_ERROR",
              message: error instanceof Error ? error.message : String(error),
              parentSessionId: parent.id,
            },
          });
          return {
            sessionId: child.id,
            hostId: String(child.hostId),
            status: "failed",
            message: null,
            error: error instanceof Error ? error.message : String(error),
          };
        } finally {
          services.concurrencyManager.releaseSlot(slot.id);
        }
      },
    );

    const successful = childResults.filter((result) => result.status === "completed");
    const synthesisPreview = computeRuntimeApiPreview({
      services,
      hostId: synthesisHostId,
      projectPolicy,
      mode: "chat",
      dataIncluded: successful.map((result) => ({
        kind: "runtime-output",
        label: `Compare output from ${result.hostId}`,
        bytes: result.message ? Buffer.byteLength(result.message, "utf8") : 0,
      })),
    });
    const parentStatus = successful.length > 0 ? "completed" : "failed";
    services.sessionStore.updateSession(parent.id, {
      status: parentStatus,
      preview: synthesisPreview,
      errorCode: parentStatus === "failed" ? "RUNTIME_TRANSPORT_ERROR" : null,
    });
    services.eventStore.appendEvent({
      id: `${parent.id}:compare-${parentStatus}`,
      sessionId: parent.id,
      hostId: synthesisHostId,
      type: parentStatus === "completed" ? "done" : "error",
      payload: {
        status: parentStatus,
        partialFailure: childResults.some((result) => result.status === "failed"),
        childResults,
      },
    });

    return Response.json({
      parentSession: services.sessionStore.getSession(parent.id),
      childSessions: childSessions.map((child) =>
        services.sessionStore.getSession(child.id)
      ),
      comparePreview,
      childResults,
      synthesisPreview,
      partialFailure: childResults.some((result) => result.status === "failed"),
    });
  } catch (error) {
    return runtimeErrorResponse(error);
  }
}
