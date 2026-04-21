import { describe, it, expect } from "vitest";
import { POST } from "@/app/api/setup/bootstrap/route";
import { TEST_TELEGRAM_BOT_TOKEN } from "../helpers/telegram-fixtures";

describe("POST /api/setup/bootstrap", () => {
  it("returns 400 on invalid JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/setup/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid JSON");
  });

  it("returns 400 on missing handle", async () => {
    const res = await POST(
      new Request("http://localhost/api/setup/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("handle");
  });

  it("returns 400 on invalid handle (spaces)", async () => {
    const res = await POST(
      new Request("http://localhost/api/setup/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "has spaces" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on handle over 64 chars", async () => {
    const res = await POST(
      new Request("http://localhost/api/setup/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "x".repeat(65) }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on malformed email", async () => {
    const res = await POST(
      new Request("http://localhost/api/setup/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "seiji", email: "not-an-email" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("email");
  });

  it("returns 400 when phone and existingBot token are both sent", async () => {
    const res = await POST(
      new Request("http://localhost/api/setup/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: "seiji",
          phone: "+15555550123",
          existingBot: {
            token: TEST_TELEGRAM_BOT_TOKEN,
          },
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Choose one");
  });

  it("returns 400 when existingBot token is malformed", async () => {
    const res = await POST(
      new Request("http://localhost/api/setup/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: "seiji",
          existingBot: {
            token: "not-a-bot-token",
          },
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Telegram bot token");
  });

  // Happy-path SSE streaming is covered by tests/e2e/onboarding-no-telegram.spec.ts
  // where Playwright can mock the stream at route level. Running a real
  // orchestrator here would shell out to docker / brew / ollama which we
  // can't do in the Vitest box.
});
