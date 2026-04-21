import { afterEach, describe, expect, it, vi } from "vitest";

const oauthConstructor = vi.fn();
const generateAuthUrl = vi.fn();
const getTokenMock = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: function OAuth2(
        clientId: string,
        clientSecret: string,
        redirectUri: string,
      ) {
        oauthConstructor(clientId, clientSecret, redirectUri);
        return {
          generateAuthUrl,
          getToken: getTokenMock,
          setCredentials: vi.fn(),
        };
      },
    },
    drive: vi.fn(),
  },
}));

async function loadModule() {
  vi.resetModules();
  return import("@/lib/google-drive");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("src/lib/google-drive.ts", () => {
  it("defaults the OAuth callback to the Next.js app port", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
    generateAuthUrl.mockReturnValueOnce("https://accounts.google.com/o/oauth2/auth");

    const { getAuthUrl } = await loadModule();
    const { state, url } = getAuthUrl();

    expect(url).toBe("https://accounts.google.com/o/oauth2/auth");
    expect(state).toEqual(expect.any(String));
    expect(oauthConstructor).toHaveBeenCalledWith(
      "client-id",
      "client-secret",
      "http://localhost:3001/api/drive?action=callback",
    );
    expect(generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        access_type: "offline",
        prompt: "consent",
        scope: expect.any(Array),
        state,
      }),
    );
  });

  it("builds a valid redirect URI when APP_ORIGIN has a trailing slash", async () => {
    // Regression: previously `${origin}/api/drive?action=callback` with an
    // origin ending in `/` produced `http://localhost:3001//api/drive?…`.
    // `new URL(path, base)` normalizes this to a single slash.
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
    vi.stubEnv("APP_ORIGIN", "http://localhost:3001/");
    vi.stubEnv("GOOGLE_REDIRECT_URI", "");
    generateAuthUrl.mockReturnValueOnce("https://accounts.google.com/o/oauth2/auth");

    oauthConstructor.mockClear();
    const { getAuthUrl } = await loadModule();
    const { state } = getAuthUrl();

    expect(oauthConstructor).toHaveBeenCalledTimes(1);
    const redirectUri = String(oauthConstructor.mock.calls[0]?.[2] ?? "");
    expect(redirectUri).toBe("http://localhost:3001/api/drive?action=callback");
    // Belt-and-braces: the pathname must not start with `//`.
    expect(redirectUri).not.toMatch(/localhost:3001\/\//);
    expect(generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({ state }),
    );
  });

  it("rejects callbacks whose OAuth state was not issued by this session", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");

    const { handleCallback } = await loadModule();

    await expect(
      handleCallback("oauth-code", "forged-state"),
    ).rejects.toThrow("Invalid or expired OAuth state");
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it("consumes issued OAuth state values exactly once", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
    generateAuthUrl.mockReturnValue("https://accounts.google.com/o/oauth2/auth");
    getTokenMock.mockResolvedValueOnce({ tokens: { access_token: "token" } });

    const { getAuthUrl, handleCallback } = await loadModule();
    const { state } = getAuthUrl();

    await expect(handleCallback("oauth-code", state)).resolves.toEqual({
      success: true,
    });
    expect(getTokenMock).toHaveBeenCalledWith("oauth-code");

    await expect(handleCallback("oauth-code", state)).rejects.toThrow(
      "Invalid or expired OAuth state",
    );
  });
});
