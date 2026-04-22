import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBrainConfig: vi.fn(),
  getLLMClient: vi.fn(),
  interpretMultimodalResultPacket: vi.fn(),
  isLocalRequest: vi.fn(),
}));

vi.mock("@/app/api/brain/_shared", () => ({
  getBrainConfig: mocks.getBrainConfig,
  getLLMClient: mocks.getLLMClient,
  isErrorResponse: (value: unknown) => value instanceof Response,
}));

vi.mock("@/brain/multimodal-result-interpreter", () => ({
  interpretMultimodalResultPacket: mocks.interpretMultimodalResultPacket,
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: mocks.isLocalRequest,
}));

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/brain/multimodal-interpret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("multimodal interpret route", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getBrainConfig.mockReset();
    mocks.getLLMClient.mockReset();
    mocks.interpretMultimodalResultPacket.mockReset();
    mocks.isLocalRequest.mockReset();

    mocks.getBrainConfig.mockReturnValue({ synthesisModel: "test-model" });
    mocks.getLLMClient.mockReturnValue({ complete: vi.fn() });
    mocks.isLocalRequest.mockResolvedValue(true);
    mocks.interpretMultimodalResultPacket.mockResolvedValue({
      response: "packet interpreted",
      filesConsidered: ["docs/result-note.md"],
      unsupportedInputs: [],
      savePath: "projects/project-alpha/multimodal-interpretation.md",
    });
  });

  it("rejects non-local requests before loading config or invoking the interpreter", async () => {
    mocks.isLocalRequest.mockResolvedValue(false);

    const { POST } = await import("@/app/api/brain/multimodal-interpret/route");
    const response = await POST(request({
      project: "project-alpha",
      prompt: "Interpret the mixed result packet.",
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mocks.getBrainConfig).not.toHaveBeenCalled();
    expect(mocks.interpretMultimodalResultPacket).not.toHaveBeenCalled();
  });

  it("passes validated visible packet context to the interpreter for local requests", async () => {
    const llm = { complete: vi.fn() };
    mocks.getLLMClient.mockReturnValue(llm);

    const { POST } = await import("@/app/api/brain/multimodal-interpret/route");
    const response = await POST(request({
      project: "project-alpha",
      prompt: "Interpret the mixed result packet.",
      files: [
        { workspacePath: "docs/result-note.md", displayPath: "Result note" },
      ],
    }));

    expect(response.status).toBe(200);
    expect(mocks.interpretMultimodalResultPacket).toHaveBeenCalledWith({
      llm,
      project: "project-alpha",
      prompt: "Interpret the mixed result packet.",
      files: [
        { workspacePath: "docs/result-note.md", displayPath: "Result note" },
      ],
    });
  });
});
