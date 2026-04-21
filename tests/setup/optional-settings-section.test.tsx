// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import {
  OptionalSettingsSection,
  type OptionalSettingsValue,
} from "@/components/setup/optional-settings-section";

function makeValues(
  overrides: Partial<OptionalSettingsValue> = {},
): OptionalSettingsValue {
  return {
    scienceswarmDir: "",
    googleClientId: "",
    googleClientSecret: "",
    githubId: "",
    githubSecret: "",
    ...overrides,
  };
}

describe("OptionalSettingsSection", () => {
  it("shows only the advanced-settings handoff note", () => {
    render(
      <OptionalSettingsSection values={makeValues()} onChange={() => {}} />,
    );

    expect(screen.getByTestId("optional-settings-panel")).toBeInTheDocument();
    expect(
      screen.getByText(/custom data directories, integrations, and other advanced controls/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Data directory"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Google OAuth client ID"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("GitHub OAuth client secret"),
    ).not.toBeInTheDocument();
  });

  it("links to dashboard settings for the advanced configuration surface", () => {
    render(
      <OptionalSettingsSection values={makeValues()} onChange={() => {}} />,
    );

    const link = screen.getByRole("link", {
      name: "Open advanced settings later",
    }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/dashboard/settings");
  });
});
