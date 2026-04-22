import type {
  PaperEntity,
  ResearchLandscapeCandidate,
  ResearchLandscapeInput,
  ResearchLandscapeSource,
  ResearchLandscapeSourceRun,
} from "./contract";
import { DEFAULT_RETRY_COUNT } from "./contract";
import { normalizeResearchLandscapeTitle } from "./resolve";

import { arxivSearch } from "@/lib/skills/db-arxiv";
import { crossrefSearch } from "@/lib/skills/db-crossref";
import { openalexSearch } from "@/lib/skills/db-openalex";
import { pubmedSearch } from "@/lib/skills/db-pubmed";

export type ResearchLandscapeSearchFn = (input: {
  query: string;
  project?: string;
  perSourceLimit: number;
}) => Promise<{ entities: PaperEntity[]; total: number; cursor?: string }>;

const SEARCH_FNS: Record<ResearchLandscapeSource, ResearchLandscapeSearchFn> = {
  async pubmed(input) {
    const result = await pubmedSearch(
      {
        query: input.query,
        page: 1,
        page_size: input.perSourceLimit,
        sort: "relevance",
        project: input.project,
      },
      { persist: false },
    );
    return {
      entities: result.entities.filter(isPaperEntity),
      total: result.total,
      cursor: result.cursor,
    };
  },
  async arxiv(input) {
    const result = await arxivSearch(
      {
        query: input.query,
        page: 1,
        page_size: input.perSourceLimit,
        sort: "relevance",
        project: input.project,
      },
      { persist: false },
    );
    return {
      entities: result.entities.filter(isPaperEntity),
      total: result.total,
      cursor: result.cursor,
    };
  },
  async openalex(input) {
    const result = await openalexSearch(
      {
        query: input.query,
        entity_type: "paper",
        page: 1,
        page_size: input.perSourceLimit,
        project: input.project,
      },
      { persist: false },
    );
    return {
      entities: result.entities.filter(isPaperEntity),
      total: result.total,
      cursor: result.cursor,
    };
  },
  async crossref(input) {
    const result = await crossrefSearch(
      {
        query: input.query,
        page: 1,
        page_size: input.perSourceLimit,
        sort: "relevance",
        project: input.project,
      },
      { persist: false },
    );
    return {
      entities: result.entities.filter(isPaperEntity),
      total: result.total,
      cursor: result.cursor,
    };
  },
};

export async function collectResearchLandscapeCandidates(
  input: Required<Pick<ResearchLandscapeInput, "query" | "perSourceLimit" | "retryCount">>
    & Pick<ResearchLandscapeInput, "project" | "exactTitle" | "startYear" | "endYear">
    & { sources: ResearchLandscapeSource[] },
  options: {
    searches?: Partial<Record<ResearchLandscapeSource, ResearchLandscapeSearchFn>>;
  } = {},
): Promise<{
  candidates: ResearchLandscapeCandidate[];
  sourceRuns: ResearchLandscapeSourceRun[];
}> {
  const exactTitleTarget = input.exactTitle?.trim();
  const searches = { ...SEARCH_FNS, ...(options.searches ?? {}) };
  const runs = await Promise.all(
    input.sources.map(async (source) => {
      const outcome = await collectFromSource(
        source,
        input,
        exactTitleTarget,
        searches[source],
      );
      return outcome;
    }),
  );

  return {
    candidates: runs.flatMap((run) => run.candidates),
    sourceRuns: runs.map((run) => run.sourceRun),
  };
}

async function collectFromSource(
  source: ResearchLandscapeSource,
  input: Required<Pick<ResearchLandscapeInput, "query" | "perSourceLimit" | "retryCount">>
    & Pick<ResearchLandscapeInput, "project" | "startYear" | "endYear">,
  exactTitleTarget: string | undefined,
  searchFn: ResearchLandscapeSearchFn,
): Promise<{
  candidates: ResearchLandscapeCandidate[];
  sourceRun: ResearchLandscapeSourceRun;
}> {
  const retryCount = Math.max(0, input.retryCount ?? DEFAULT_RETRY_COUNT);
  let lastError: unknown;

  for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
    try {
      const result = await searchFn({
        query: input.query,
        project: input.project,
        perSourceLimit: input.perSourceLimit,
      });
      const filtered = result.entities.filter((entity) => yearWithinWindow(
        entity.payload.year,
        input.startYear,
        input.endYear,
      ));
      const candidates = filtered.map((entity, index) => {
        const normalizedTitle = normalizeResearchLandscapeTitle(entity.payload.title);
        return {
          source,
          rank: index + 1,
          entity,
          normalizedTitle,
          exactTitleMatch: Boolean(
            exactTitleTarget
              && normalizedTitle.length > 0
              && normalizedTitle === normalizeResearchLandscapeTitle(exactTitleTarget),
          ),
        } satisfies ResearchLandscapeCandidate;
      });
      return {
        candidates,
        sourceRun: {
          source,
          status: "ok",
          attempts: attempt,
          candidatesFetched: result.entities.length,
          candidatesAfterYearFilter: filtered.length,
          total: result.total,
          cursor: result.cursor,
        },
      };
    } catch (error) {
      lastError = error;
      if (attempt <= retryCount) {
        await sleep(250 * attempt);
      }
    }
  }

  return {
    candidates: [],
    sourceRun: {
      source,
      status: "failed",
      attempts: retryCount + 1,
      candidatesFetched: 0,
      candidatesAfterYearFilter: 0,
      total: 0,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    },
  };
}

function yearWithinWindow(
  year: number | null | undefined,
  startYear: number | undefined,
  endYear: number | undefined,
): boolean {
  if (startYear == null && endYear == null) return true;
  if (year == null) return false;
  if (startYear != null && year < startYear) return false;
  if (endYear != null && year > endYear) return false;
  return true;
}

function isPaperEntity(entity: unknown): entity is PaperEntity {
  return Boolean(entity && typeof entity === "object" && (entity as { type?: string }).type === "paper");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
