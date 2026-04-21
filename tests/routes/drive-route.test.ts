import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAuthUrlMock,
  handleCallbackMock,
  isConnectedMock,
  disconnectMock,
  listFilesMock,
  listFoldersMock,
  searchFilesMock,
  downloadFileMock,
  isLocalRequestMock,
  GoogleDriveOAuthStateErrorMock,
} = vi.hoisted(() => ({
  getAuthUrlMock: vi.fn(),
  handleCallbackMock: vi.fn(),
  isConnectedMock: vi.fn(),
  disconnectMock: vi.fn(),
  listFilesMock: vi.fn(),
  listFoldersMock: vi.fn(),
  searchFilesMock: vi.fn(),
  downloadFileMock: vi.fn(),
  isLocalRequestMock: vi.fn(),
  GoogleDriveOAuthStateErrorMock: class GoogleDriveOAuthStateError extends Error {},
}));

vi.mock("@/lib/google-drive", () => ({
  getAuthUrl: getAuthUrlMock,
  handleCallback: handleCallbackMock,
  GoogleDriveOAuthStateError: GoogleDriveOAuthStateErrorMock,
  isConnected: isConnectedMock,
  disconnect: disconnectMock,
  listFiles: listFilesMock,
  listFolders: listFoldersMock,
  searchFiles: searchFilesMock,
  downloadFile: downloadFileMock,
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: isLocalRequestMock,
}));

import { GET } from "@/app/api/drive/route";

describe("GET /api/drive", () => {
  beforeEach(() => {
    getAuthUrlMock.mockReset();
    handleCallbackMock.mockReset();
    isConnectedMock.mockReset();
    disconnectMock.mockReset();
    listFilesMock.mockReset();
    listFoldersMock.mockReset();
    searchFilesMock.mockReset();
    downloadFileMock.mockReset();
    isLocalRequestMock.mockReset();

    getAuthUrlMock.mockReturnValue({
      state: "oauth-state",
      url: "https://accounts.google.com/o/oauth2/auth?state=oauth-state",
    });
    handleCallbackMock.mockResolvedValue({ success: true });
    isConnectedMock.mockReturnValue(false);
    isLocalRequestMock.mockResolvedValue(true);
  });

  it("guards non-callback GET actions behind local requests", async () => {
    isLocalRequestMock.mockResolvedValue(false);

    const response = await GET(
      new Request("http://localhost:3001/api/drive?action=auth-url"),
    );

    expect(response.status).toBe(403);
    expect(getAuthUrlMock).not.toHaveBeenCalled();
  });

  it("allows OAuth callbacks without the local-request guard", async () => {
    isLocalRequestMock.mockResolvedValue(false);

    const response = await GET(
      new Request(
        "http://localhost:3001/api/drive?action=callback&code=test-code&state=oauth-state",
      ),
    );

    expect(handleCallbackMock).toHaveBeenCalledWith("test-code", "oauth-state");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/dashboard/project?drive=connected",
    );
  });

  it("rejects callbacks that omit the OAuth state", async () => {
    const response = await GET(
      new Request("http://localhost:3001/api/drive?action=callback&code=test-code"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Missing state parameter",
    });
    expect(handleCallbackMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the callback state is invalid", async () => {
    handleCallbackMock.mockRejectedValueOnce(
      new GoogleDriveOAuthStateErrorMock("Invalid or expired OAuth state"),
    );

    const response = await GET(
      new Request(
        "http://localhost:3001/api/drive?action=callback&code=test-code&state=oauth-state",
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid or expired OAuth state",
    });
  });
});
