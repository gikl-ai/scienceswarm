import {
  LegacyStudyAliasSchema,
  LegacyToStudyResolveResultSchema,
  StudyIdSchema,
  StudyKnowledgeSchema,
  StudySlugSchema,
  type LegacyProjectParseResult,
  type LegacyStudyAlias,
  type LegacyToStudyResolveResult,
  type StudyId,
  type StudyKnowledge,
  type StudySlug,
} from "./contracts";
import {
  getLaunchBundleRoot,
  getRunStateRoot,
  getStudyAgentWorkspaceRoot,
  getStudyStateRoot,
  getThreadStateRoot,
} from "./paths";

export interface StudyLookupStore {
  getStudyKnowledgeById(studyId: StudyId): Promise<StudyKnowledge | null>;
  getStudyKnowledgeBySlug(studySlug: StudySlug): Promise<StudyKnowledge | null>;
  getStudyAliasByLegacyProjectSlug(legacyProjectSlug: StudySlug): Promise<LegacyStudyAlias | null>;
}

export interface ResolveStudyContextInput {
  studyId?: string | null;
  studySlug?: string | null;
  slug?: string | null;
  projectId?: string | null;
  projectSlug?: string | null;
}

export interface StudyContext {
  studyId: StudyId;
  studySlug: StudySlug;
  title: string;
  legacyProjectSlug?: StudySlug;
  knowledge: StudyKnowledge;
}

export interface ResolvedResearchContext extends StudyContext {
  paths: {
    studyStateRoot: string;
    agentWorkspaceRoot: string;
    threadStateRoot(threadId: string): string;
    runStateRoot(runId: string): string;
    launchBundleRoot(runId: string, host: string): string;
  };
  resolution: Extract<LegacyToStudyResolveResult, { status: "resolved" }>;
}

export function parseLegacyProjectSlug(input: string | null | undefined): LegacyProjectParseResult {
  if (!input?.trim()) {
    return { ok: false, reason: "missing" };
  }
  const parsed = StudySlugSchema.safeParse(input.trim());
  if (!parsed.success) {
    return { ok: false, reason: "invalid", input };
  }
  return { ok: true, legacyProjectSlug: parsed.data };
}

function buildResolvedResult(input: {
  source: Extract<LegacyToStudyResolveResult, { status: "resolved" }>["source"];
  knowledge: StudyKnowledge;
  legacyProjectSlug?: StudySlug;
}): Extract<LegacyToStudyResolveResult, { status: "resolved" }> {
  const parsed = LegacyToStudyResolveResultSchema.parse({
    status: "resolved",
    source: input.source,
    studyId: input.knowledge.id,
    studySlug: input.knowledge.slug,
    legacyProjectSlug: input.legacyProjectSlug,
  });
  if (parsed.status !== "resolved") {
    throw new Error("Resolved Study result failed validation");
  }
  return parsed;
}

function notFound(
  source: Extract<LegacyToStudyResolveResult, { status: "not-found" }>["source"],
  lookup: string,
): Extract<LegacyToStudyResolveResult, { status: "not-found" }> {
  return { status: "not-found", source, lookup };
}

function invalid(
  source: Extract<LegacyToStudyResolveResult, { status: "invalid" }>["source"],
  reason: string,
): Extract<LegacyToStudyResolveResult, { status: "invalid" }> {
  return { status: "invalid", source, reason };
}

async function resolveStudyKnowledge(
  input: ResolveStudyContextInput,
  store: StudyLookupStore,
): Promise<{ result: LegacyToStudyResolveResult; knowledge: StudyKnowledge | null }> {
  if (input.studyId?.trim()) {
    const parsed = StudyIdSchema.safeParse(input.studyId.trim());
    if (!parsed.success) return { result: invalid("study-id", "Invalid Study ID"), knowledge: null };
    const knowledge = await store.getStudyKnowledgeById(parsed.data);
    if (!knowledge) return { result: notFound("study-id", parsed.data), knowledge: null };
    const canonical = StudyKnowledgeSchema.parse(knowledge);
    return { result: buildResolvedResult({ source: "study-id", knowledge: canonical }), knowledge: canonical };
  }

  const directSlug = input.studySlug?.trim() || input.slug?.trim();
  if (directSlug) {
    const parsed = StudySlugSchema.safeParse(directSlug);
    if (!parsed.success) return { result: invalid("study-slug", "Invalid Study slug"), knowledge: null };
    const knowledge = await store.getStudyKnowledgeBySlug(parsed.data);
    if (!knowledge) return { result: notFound("study-slug", parsed.data), knowledge: null };
    const canonical = StudyKnowledgeSchema.parse(knowledge);
    return { result: buildResolvedResult({ source: "study-slug", knowledge: canonical }), knowledge: canonical };
  }

  const projectSlug = parseLegacyProjectSlug(input.projectSlug ?? input.projectId);
  if (!projectSlug.ok) {
    return {
      result: invalid("legacy-project", projectSlug.reason === "missing" ? "Missing Study or project identifier" : "Invalid legacy project slug"),
      knowledge: null,
    };
  }

  const alias = await store.getStudyAliasByLegacyProjectSlug(projectSlug.legacyProjectSlug);
  if (alias) {
    const canonicalAlias = LegacyStudyAliasSchema.parse(alias);
    const knowledge = await store.getStudyKnowledgeById(canonicalAlias.studyId);
    if (!knowledge) {
      return { result: notFound("legacy-project", projectSlug.legacyProjectSlug), knowledge: null };
    }
    const canonical = StudyKnowledgeSchema.parse(knowledge);
    return {
      result: buildResolvedResult({
        source: "legacy-alias",
        knowledge: canonical,
        legacyProjectSlug: canonicalAlias.legacyProjectSlug,
      }),
      knowledge: canonical,
    };
  }

  const fallback = await store.getStudyKnowledgeBySlug(projectSlug.legacyProjectSlug);
  if (!fallback) {
    return { result: notFound("legacy-project", projectSlug.legacyProjectSlug), knowledge: null };
  }
  const canonical = StudyKnowledgeSchema.parse(fallback);
  return {
    result: buildResolvedResult({
      source: "legacy-slug-fallback",
      knowledge: canonical,
      legacyProjectSlug: projectSlug.legacyProjectSlug,
    }),
    knowledge: canonical,
  };
}

export async function resolveLegacyProjectToStudy(
  input: ResolveStudyContextInput,
  store: StudyLookupStore,
): Promise<LegacyToStudyResolveResult> {
  return (await resolveStudyKnowledge(input, store)).result;
}

export async function resolveStudyContext(
  input: ResolveStudyContextInput,
  store: StudyLookupStore,
): Promise<ResolvedResearchContext | null> {
  const { result, knowledge } = await resolveStudyKnowledge(input, store);
  if (result.status !== "resolved" || !knowledge) {
    return null;
  }

  return {
    studyId: result.studyId,
    studySlug: result.studySlug,
    title: knowledge.title,
    legacyProjectSlug: result.legacyProjectSlug,
    knowledge,
    resolution: result,
    paths: {
      studyStateRoot: getStudyStateRoot(result.studyId),
      agentWorkspaceRoot: getStudyAgentWorkspaceRoot(result.studyId),
      threadStateRoot: getThreadStateRoot,
      runStateRoot: getRunStateRoot,
      launchBundleRoot: getLaunchBundleRoot,
    },
  };
}
