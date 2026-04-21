import {
  createGbrainFileStore,
  type GbrainFileStore,
} from "@/brain/gbrain-file-store";

type GlobalState = typeof globalThis & {
  __scienceswarmWorkspaceRouteFileStoreOverride?: GbrainFileStore | null;
};

function globalState(): GlobalState {
  return globalThis as GlobalState;
}

export function __setWorkspaceFileStoreOverride(
  fileStore: GbrainFileStore | null,
): void {
  globalState().__scienceswarmWorkspaceRouteFileStoreOverride = fileStore;
}

export function getWorkspaceRouteFileStore(): GbrainFileStore {
  return globalState().__scienceswarmWorkspaceRouteFileStoreOverride
    ?? createGbrainFileStore();
}
