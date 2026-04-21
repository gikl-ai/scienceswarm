import { Capacitor } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Haptics, ImpactStyle } from "@capacitor/haptics";

/**
 * Check if the app is running inside a native Capacitor shell (iOS/Android).
 */
export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Pick a file from the device.
 * Opens a native file picker dialog via a hidden <input type="file"> element
 * and returns the selected File, or null if the user cancels.
 */
export function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const input = document.createElement("input");
    input.type = "file";
    input.className = "hidden";

    input.addEventListener("change", () => {
      resolved = true;
      const file = input.files?.[0] ?? null;
      input.remove();
      resolve(file);
    });

    // Handle cancel — the input won't fire "change" but the window regains focus
    const onFocus = () => {
      window.removeEventListener("focus", onFocus);
      // Small delay to let "change" fire first if a file was selected
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        input.remove();
        resolve(null);
      }, 300);
    };
    window.addEventListener("focus", onFocus);

    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Take a photo using the device camera.
 * Returns a base64-encoded string on native, or null on web.
 */
export async function takePhoto(): Promise<string | null> {
  if (!isNative()) return null;

  try {
    const image = await Camera.getPhoto({
      quality: 90,
      allowEditing: false,
      resultType: CameraResultType.Base64,
      source: CameraSource.Camera,
    });

    return image.base64String ?? null;
  } catch {
    return null;
  }
}

/**
 * Trigger a short haptic feedback tap on native devices. No-op on web.
 */
export function hapticFeedback(): void {
  if (!isNative()) return;

  void Haptics.impact({ style: ImpactStyle.Medium });
}
