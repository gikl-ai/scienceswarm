import {
  createGbrainFileStore,
  type GbrainFileStore,
} from "@/brain/gbrain-file-store";

type GlobalState = typeof globalThis & {
  __scienceswarmBrainFileRouteFileStoreOverride?: GbrainFileStore | null;
};

function globalState(): GlobalState {
  return globalThis as GlobalState;
}

export function __setBrainFileRouteFileStoreOverride(
  fileStore: GbrainFileStore | null,
): void {
  globalState().__scienceswarmBrainFileRouteFileStoreOverride = fileStore;
}

export function getBrainFileRouteFileStore(): GbrainFileStore {
  return globalState().__scienceswarmBrainFileRouteFileStoreOverride
    ?? createGbrainFileStore();
}
