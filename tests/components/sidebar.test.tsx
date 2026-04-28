// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let pathnameValue = "/dashboard/gbrain";
let searchParamsValue = "name=demo-project";

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameValue,
  useSearchParams: () => new URLSearchParams(searchParamsValue),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { Sidebar } from "@/components/sidebar";

describe("Sidebar", () => {
  beforeEach(() => {
    pathnameValue = "/dashboard/gbrain";
    searchParamsValue = "name=demo-project";
    window.localStorage.clear();
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  it("routes workspace and gbrain links with the active study scope", () => {
    render(<Sidebar />);

    expect(screen.getByTitle("Workspace")).toHaveAttribute("href", "/dashboard/study?name=demo-project");
    expect(screen.getByTitle("gbrain")).toHaveAttribute("href", "/dashboard/gbrain?name=demo-project");
    expect(screen.getByTitle("Reasoning")).toHaveAttribute("href", "/dashboard/reasoning");
  });

  it("falls back to the remembered study slug when the URL is unscoped", () => {
    searchParamsValue = "";
    window.localStorage.setItem("scienceswarm.project.lastSlug", "remembered-project");

    render(<Sidebar />);

    expect(screen.getByTitle("Workspace")).toHaveAttribute("href", "/dashboard/study?name=remembered-project");
    expect(screen.getByTitle("gbrain")).toHaveAttribute("href", "/dashboard/gbrain?name=remembered-project");
  });
});
