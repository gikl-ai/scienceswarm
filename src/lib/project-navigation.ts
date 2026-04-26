import {
  buildGbrainHrefForStudySlug,
  buildPaperLibraryHrefForStudySlug,
  buildRoutinesHrefForStudySlug,
  buildStudyWorkspaceHrefForSlug,
  clearLastStudySlug,
  persistLastStudySlug,
  readLastStudySlug,
  safeStudySlugOrNull,
  subscribeToLastStudySlug,
} from "@/lib/study-navigation";

export const safeProjectSlugOrNull = safeStudySlugOrNull;
export const readLastProjectSlug = readLastStudySlug;
export const subscribeToLastProjectSlug = subscribeToLastStudySlug;
export const persistLastProjectSlug = persistLastStudySlug;
export const clearLastProjectSlug = clearLastStudySlug;
export const buildWorkspaceHrefForSlug = buildStudyWorkspaceHrefForSlug;
export const buildGbrainHrefForSlug = buildGbrainHrefForStudySlug;
export const buildRoutinesHrefForSlug = buildRoutinesHrefForStudySlug;
export const buildPaperLibraryHrefForSlug = buildPaperLibraryHrefForStudySlug;
