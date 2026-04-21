import {
  createGbrainFileStore,
  type GbrainFileStore,
} from "@/brain/gbrain-file-store";

type GlobalState = typeof globalThis & {
  __scienceswarmBrainFileUploadRouteFileStoreOverride?: GbrainFileStore | null;
};

function globalState(): GlobalState {
  return globalThis as GlobalState;
}

export function __setBrainFileUploadRouteFileStoreOverride(
  fileStore: GbrainFileStore | null,
): void {
  globalState().__scienceswarmBrainFileUploadRouteFileStoreOverride = fileStore;
}

export function getBrainFileUploadRouteFileStore(): GbrainFileStore {
  return globalState().__scienceswarmBrainFileUploadRouteFileStoreOverride
    ?? createGbrainFileStore();
}
