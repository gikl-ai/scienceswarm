"use client";

import { useCallback, useMemo } from "react";
import {
  isNative as checkIsNative,
  pickFile as nativePickFile,
  takePhoto as nativeTakePhoto,
  hapticFeedback as nativeHapticFeedback,
} from "@/lib/capacitor";

interface UseNativeReturn {
  isNative: boolean;
  pickFile: () => Promise<File | null>;
  takePhoto: () => Promise<string | null>;
  hapticFeedback: () => void;
}

/**
 * React hook exposing native Capacitor capabilities.
 * On web, pickFile and takePhoto return null so the caller can use browser
 * fallbacks (e.g. <input type="file">).
 */
export function useNative(): UseNativeReturn {
  const native = useMemo(() => checkIsNative(), []);

  const pickFile = useCallback(async (): Promise<File | null> => {
    if (!native) return null;
    return nativePickFile();
  }, [native]);

  const takePhoto = useCallback(async (): Promise<string | null> => {
    if (!native) return null;
    return nativeTakePhoto();
  }, [native]);

  const hapticFeedback = useCallback((): void => {
    if (!native) return;
    nativeHapticFeedback();
  }, [native]);

  return { isNative: native, pickFile, takePhoto, hapticFeedback };
}
