import { interpretMultimodalResultPacket } from "@/brain/multimodal-result-interpreter";
import { isLocalRequest } from "@/lib/local-guard";
import {
  assertSafeProjectSlug,
  InvalidSlugError,
} from "@/lib/state/project-manifests";
import {
  getBrainConfig,
  getLLMClient,
  isErrorResponse,
} from "../_shared";

interface RequestBody {
  study?: unknown;
  project?: unknown;
  prompt?: unknown;
  files?: Array<{
    workspacePath?: unknown;
    displayPath?: unknown;
  }>;
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const study = typeof body.study === "string"
    ? body.study.trim()
    : typeof body.project === "string"
      ? body.project.trim()
      : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!study) {
    return Response.json({ error: "study is required" }, { status: 400 });
  }
  if (!prompt) {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }

  try {
    assertSafeProjectSlug(study);
  } catch (error) {
    if (!(error instanceof InvalidSlugError)) throw error;
    return Response.json({ error: "study must be a safe bare slug" }, { status: 400 });
  }

  const files = Array.isArray(body.files)
    ? body.files.map((entry) => ({
        workspacePath:
          typeof entry?.workspacePath === "string" ? entry.workspacePath : undefined,
        displayPath:
          typeof entry?.displayPath === "string" ? entry.displayPath : undefined,
      }))
    : [];

  try {
    const result = await interpretMultimodalResultPacket({
      llm: getLLMClient(config),
      project: study,
      prompt,
      files,
    });
    return Response.json(result);
  } catch (error) {
    console.error("Multimodal interpretation failed", error);
    return Response.json(
      { error: "Multimodal interpretation failed" },
      { status: 500 },
    );
  }
}
