import {
  createIngestService,
  type IngestService,
} from "@/brain/ingest/service";

type GlobalState = typeof globalThis & {
  __scienceswarmWorkspaceUploadRouteIngestServiceOverride?: IngestService | null;
};

function globalState(): GlobalState {
  return globalThis as GlobalState;
}

export function __setIngestServiceOverride(
  service: IngestService | null,
): void {
  globalState().__scienceswarmWorkspaceUploadRouteIngestServiceOverride = service;
}

export function getWorkspaceUploadRouteIngestService(): IngestService {
  return globalState().__scienceswarmWorkspaceUploadRouteIngestServiceOverride
    ?? createIngestService();
}
