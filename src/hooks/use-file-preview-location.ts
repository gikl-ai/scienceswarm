"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  FILE_PREVIEW_LOCATION_CHANGE_EVENT,
  FILE_PREVIEW_LOCATION_STORAGE_KEY,
  DEFAULT_FILE_PREVIEW_LOCATION,
  readStoredFilePreviewLocation,
  storeFilePreviewLocation,
  type FilePreviewLocation,
} from "@/lib/file-preview-preferences";

function subscribeToFilePreviewLocation(onChange: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handlePreferenceChange = () => {
    onChange();
  };

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== FILE_PREVIEW_LOCATION_STORAGE_KEY) return;
    onChange();
  };

  window.addEventListener(FILE_PREVIEW_LOCATION_CHANGE_EVENT, handlePreferenceChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(FILE_PREVIEW_LOCATION_CHANGE_EVENT, handlePreferenceChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function getFilePreviewLocationServerSnapshot(): FilePreviewLocation {
  return DEFAULT_FILE_PREVIEW_LOCATION;
}

export function useFilePreviewLocation() {
  const location = useSyncExternalStore(
    subscribeToFilePreviewLocation,
    readStoredFilePreviewLocation,
    getFilePreviewLocationServerSnapshot,
  );

  const setLocation = useCallback((next: FilePreviewLocation) => {
    storeFilePreviewLocation(next);
  }, []);

  return [location, setLocation] as const;
}
