// @vitest-environment jsdom

import { waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVoiceChat } from "@/hooks/use-voice-chat";

function VoiceSupportProbe() {
  const { isSupported } = useVoiceChat();
  return <div>{isSupported ? "supported" : "unsupported"}</div>;
}

describe("useVoiceChat hydration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(window.navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });
  });

  it("hydrates without a mismatch when browser voice support is detected after mount", async () => {
    Object.defineProperty(window.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(),
      },
    });

    vi.stubGlobal(
      "MediaRecorder",
      class FakeMediaRecorder {} as unknown as typeof MediaRecorder,
    );

    const serverMarkup = renderToString(<VoiceSupportProbe />);
    expect(serverMarkup).toContain("unsupported");

    const container = document.createElement("div");
    container.innerHTML = serverMarkup;
    document.body.appendChild(container);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = hydrateRoot(container, <VoiceSupportProbe />);

    await waitFor(() => {
      expect(container.textContent).toContain("supported");
    });

    expect(
      consoleError.mock.calls.some(([message]) => String(message).includes("Hydration failed")),
    ).toBe(false);

    root.unmount();
    container.remove();
  });
});
