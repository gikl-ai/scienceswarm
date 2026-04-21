export type FilePreviewLocation = "upper-pane" | "chat-pane";

export const DEFAULT_FILE_PREVIEW_LOCATION: FilePreviewLocation = "upper-pane";
export const FILE_PREVIEW_LOCATION_STORAGE_KEY = "scienceswarm.settings.filePreviewLocation";
export const FILE_PREVIEW_LOCATION_CHANGE_EVENT = "scienceswarm:file-preview-location-change";

let volatileFilePreviewLocation: FilePreviewLocation | null = null;

export function parseFilePreviewLocation(value: unknown): FilePreviewLocation {
  return value === "chat-pane" ? "chat-pane" : DEFAULT_FILE_PREVIEW_LOCATION;
}

export function readStoredFilePreviewLocation(): FilePreviewLocation {
  if (typeof window === "undefined") {
    return DEFAULT_FILE_PREVIEW_LOCATION;
  }

  if (volatileFilePreviewLocation !== null) {
    return volatileFilePreviewLocation;
  }

  try {
    return parseFilePreviewLocation(window.localStorage.getItem(FILE_PREVIEW_LOCATION_STORAGE_KEY));
  } catch {
    return DEFAULT_FILE_PREVIEW_LOCATION;
  }
}

export function storeFilePreviewLocation(location: FilePreviewLocation): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(FILE_PREVIEW_LOCATION_STORAGE_KEY, location);
    volatileFilePreviewLocation = null;
  } catch {
    volatileFilePreviewLocation = location;
  }

  window.dispatchEvent(
    new CustomEvent(FILE_PREVIEW_LOCATION_CHANGE_EVENT, { detail: location }),
  );
}
