import {
  assertPreviewAllowed,
  assertRuntimeApiLocalRequest,
  computeRuntimeApiPreview,
  dataIncludedFromBodyWithRuntimeContext,
  getRuntimeApiServices,
  optionalSafeProjectId,
  parseJsonObject,
  projectPolicyFromBody,
  requireStringArrayField,
  requireStringField,
  runtimeErrorResponse,
  runtimeInvalidRequest,
  turnModeFromBody,
} from "../_shared";

export async function POST(request: Request): Promise<Response> {
  try {
    await assertRuntimeApiLocalRequest(request);
    const body = await parseJsonObject(request);
    const services = getRuntimeApiServices();
    const mode = turnModeFromBody(body, "chat");
    const projectId = optionalSafeProjectId(body.projectId);
    const selectedHostIds = mode === "compare"
      ? requireStringArrayField(body, "selectedHostIds")
      : undefined;
    const hostId = mode === "compare"
      ? selectedHostIds?.[0]
      : requireStringField(body, "hostId");
    if (!hostId) {
      throw runtimeInvalidRequest("Compare preview requires at least one selected host.");
    }
    const preview = computeRuntimeApiPreview({
      services,
      hostId,
      projectPolicy: projectPolicyFromBody(body),
      mode,
      dataIncluded: dataIncludedFromBodyWithRuntimeContext({
        body,
        projectId,
        hostId,
        selectedHostIds,
      }),
      selectedHostIds,
    });

    // Approval is a UI/user decision. The preview endpoint returns
    // requiresUserApproval for allowed egress, but still fails closed for
    // policy blocks before any prompt construction can happen.
    assertPreviewAllowed(preview, "approved");

    return Response.json({
      projectId,
      preview,
      selectedHostIds,
    });
  } catch (error) {
    return runtimeErrorResponse(error);
  }
}
