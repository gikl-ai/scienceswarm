import { describe, expect, it, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();
const mockIsLocal = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: () => mockIsLocal(),
}));

describe("POST /api/local-folder-picker", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    mockIsLocal.mockResolvedValue(true);
    delete process.env.WSL_INTEROP;
    delete process.env.WSL_DISTRO_NAME;
  });

  it("returns a selected macOS folder path for local requests", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    execFileMock.mockImplementation((_command: string, _args: string[], callback: (...cbArgs: unknown[]) => void) => {
      callback(null, "/Users/tester/Documents/project-alpha/\n", "");
    });

    const { POST } = await import("@/app/api/local-folder-picker/route");
    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      path: "/Users/tester/Documents/project-alpha",
    });
  });

  it("preserves root selections instead of trimming them into an empty path", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    execFileMock.mockImplementation((_command: string, _args: string[], callback: (...cbArgs: unknown[]) => void) => {
      callback(null, "/\n", "");
    });

    const { POST } = await import("@/app/api/local-folder-picker/route");
    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      path: "/",
    });
  });

  it("returns cancelled when the user closes the picker", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    execFileMock.mockImplementation((_command: string, _args: string[], callback: (...cbArgs: unknown[]) => void) => {
      const error = new Error("User canceled");
      callback(error, "", "User canceled");
    });

    const { POST } = await import("@/app/api/local-folder-picker/route");
    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ cancelled: true });
  });

  it("treats Linux exit-code-1 picker dismissals as cancellations", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    execFileMock.mockImplementation((command: string, _args: string[], callback: (...cbArgs: unknown[]) => void) => {
      if (command === "which") {
        callback(null, "/usr/bin/zenity\n", "");
        return;
      }

      const error = Object.assign(new Error("zenity exited"), { code: 1 });
      callback(error, "", "");
    });

    const { POST } = await import("@/app/api/local-folder-picker/route");
    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ cancelled: true });
  });

  it("launches the Windows picker in STA mode", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    execFileMock.mockImplementation((_command: string, _args: string[], callback: (...cbArgs: unknown[]) => void) => {
      callback(null, "C:\\Users\\tester\\project-alpha\\\n", "");
    });

    const { POST } = await import("@/app/api/local-folder-picker/route");
    const response = await POST();

    expect(response.status).toBe(200);
    expect(execFileMock).toHaveBeenCalledWith(
      "powershell",
      expect.arrayContaining(["-NoProfile", "-STA", "-Command"]),
      expect.any(Function),
    );
    await expect(response.json()).resolves.toEqual({
      path: "C:\\Users\\tester\\project-alpha",
    });
  });

  it("bridges the Windows host picker into WSL paths", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    process.env.WSL_INTEROP = "/run/WSL/123_interop";
    execFileMock.mockImplementation((command: string, args: string[], callback: (...cbArgs: unknown[]) => void) => {
      if (command === "which" && args[0] === "powershell.exe") {
        callback(null, "/usr/bin/powershell.exe\n", "");
        return;
      }
      if (command === "powershell.exe") {
        callback(null, "C:\\Users\\tester\\project-alpha\\\r\n", "");
        return;
      }
      if (command === "wslpath") {
        callback(null, "/mnt/c/Users/tester/project-alpha\n", "");
        return;
      }
      callback(new Error(`unexpected command: ${command}`), "", "");
    });

    const { POST } = await import("@/app/api/local-folder-picker/route");
    const response = await POST();

    expect(response.status).toBe(200);
    expect(execFileMock).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-NoProfile", "-STA", "-Command"]),
      expect.any(Function),
    );
    await expect(response.json()).resolves.toEqual({
      path: "/mnt/c/Users/tester/project-alpha",
    });
  });

  it("returns a descriptive error when powershell.exe is unavailable in WSL", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    process.env.WSL_INTEROP = "/run/WSL/123_interop";
    execFileMock.mockImplementation((command: string, args: string[], callback: (...cbArgs: unknown[]) => void) => {
      if (command === "which" && args[0] === "powershell.exe") {
        callback(new Error("not found"), "", "");
        return;
      }
      callback(new Error(`unexpected command: ${command}`), "", "");
    });

    const { POST } = await import("@/app/api/local-folder-picker/route");
    const response = await POST();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error:
        "Windows host folder picker is unavailable in this WSL session. Make sure powershell.exe is on PATH, or paste a path manually.",
    });
  });

  it("rejects non-local requests", async () => {
    mockIsLocal.mockResolvedValue(false);

    const { POST } = await import("@/app/api/local-folder-picker/route");
    const response = await POST();

    expect(response.status).toBe(403);
  });
});
