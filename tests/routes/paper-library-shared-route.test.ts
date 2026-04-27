import { describe, expect, it } from "vitest";
import {
  normalizeStudyBody,
  readStudyOrProjectParam,
} from "@/app/api/brain/paper-library/_shared";

describe("paper-library study compatibility helpers", () => {
  it("falls back to legacy project when canonical study query is blank", () => {
    const url = new URL("http://localhost/api/brain/paper-library/apply-plan?study=&project=alpha");

    expect(readStudyOrProjectParam(url)).toBe("alpha");
  });

  it("falls back to legacy project when canonical study body is blank", () => {
    expect(normalizeStudyBody({ study: " ", project: "alpha" })).toMatchObject({
      project: "alpha",
    });
  });
});
