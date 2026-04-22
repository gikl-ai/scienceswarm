import type { SearchDetail, SearchInput, SearchProfile } from "./types";

export interface SearchProfileSettings {
  id: SearchProfile;
  cacheTtlMs: number;
  defaultLimit: number;
  storeTimeoutMs: number;
  searchTimeoutMs: number;
  allowDegradedResults: boolean;
}

const SEARCH_PROFILE_SETTINGS: Record<SearchProfile, SearchProfileSettings> = {
  interactive: {
    id: "interactive",
    cacheTtlMs: 30_000,
    defaultLimit: 10,
    storeTimeoutMs: 500,
    searchTimeoutMs: 2_000,
    allowDegradedResults: true,
  },
  synthesis: {
    id: "synthesis",
    cacheTtlMs: 5_000,
    defaultLimit: 25,
    storeTimeoutMs: 5_000,
    searchTimeoutMs: 8_000,
    allowDegradedResults: false,
  },
};

export function resolveSearchProfile(input: {
  profile?: SearchProfile;
  detail?: SearchDetail;
}): SearchProfile {
  if (input.profile) {
    return input.profile;
  }
  return input.detail === "high" ? "synthesis" : "interactive";
}

export function getSearchProfileSettings(input: {
  profile?: SearchProfile;
  detail?: SearchDetail;
}): SearchProfileSettings {
  return SEARCH_PROFILE_SETTINGS[resolveSearchProfile(input)];
}

export function shouldAllowDegradedSearchResults(
  input: Pick<SearchInput, "allowDegradedResults" | "detail" | "profile">,
): boolean {
  if (input.allowDegradedResults !== undefined) {
    return input.allowDegradedResults;
  }
  return getSearchProfileSettings(input).allowDegradedResults;
}
