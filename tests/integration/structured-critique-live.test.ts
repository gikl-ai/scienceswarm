import { describe, expect, it } from "vitest";

import {
  POST,
  GET,
} from "@/app/api/structured-critique/route";

const RUN_LIVE = process.env.SCIENCESWARM_LIVE_DESCARTES_E2E === "1";

describe.skipIf(!RUN_LIVE)("live Descartes structured critique contract", () => {
  it("submits a real text critique job and polls the returned job envelope", async () => {
    expect(process.env.STRUCTURED_CRITIQUE_SERVICE_URL).toMatch(/\/v1\/?$/);
    expect(process.env.STRUCTURED_CRITIQUE_SERVICE_TOKEN).toBeTruthy();

    const formData = new FormData();
    formData.append(
      "text",
      "This manuscript claims that a single intervention explains all observed improvement, but it does not establish causal identification, rule out confounding, or justify why the sample generalizes beyond the measured setting. ".repeat(
        2,
      ),
    );
    formData.append("style_profile", "professional");

    const submit = await POST(
      new Request("http://localhost/api/structured-critique", {
        method: "POST",
        body: formData,
      }),
    );
    expect([200, 202]).toContain(submit.status);

    const queued = await submit.json();
    expect(queued).toMatchObject({
      id: expect.any(String),
      status: expect.stringMatching(/^(PENDING|RUNNING|COMPLETED)$/),
    });

    const poll = await GET(
      new Request(
        `http://localhost/api/structured-critique?job_id=${encodeURIComponent(queued.id)}`,
      ),
    );
    expect([200, 202]).toContain(poll.status);
    await expect(poll.json()).resolves.toMatchObject({
      id: queued.id,
      status: expect.stringMatching(/^(PENDING|RUNNING|COMPLETED|CANCELLED|FAILED)$/),
    });
  }, 120_000);
});
