// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectList } from "@/components/research/project-list";
import type { FileNode } from "@/components/research/file-tree";

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

describe("ProjectList file tree", () => {
  const files: FileNode[] = [
    {
      name: "First Proof",
      type: "directory",
      children: [
        {
          name: "solution.pdf",
          type: "file",
          size: "385 KB",
        },
        {
          name: "supplementary",
          type: "directory",
          children: [
            {
              name: "appendix.tex",
              type: "file",
            },
          ],
        },
      ],
    },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              description: "AI for science",
              status: "active",
            },
          ],
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts with folders collapsed and supports expanding or collapsing all folders", async () => {
    render(
      <ProjectList
        activeSlug="demo-project"
        files={files}
        onSelect={vi.fn()}
        selectedPath={null}
        onUpload={vi.fn()}
      />,
    );

    const project = await screen.findByText("Demo Project");
    expect(project).toBeInTheDocument();
    expect(screen.getByText("First Proof")).toBeInTheDocument();
    expect(screen.queryByText("solution.pdf")).not.toBeInTheDocument();
    expect(screen.queryByText("appendix.tex")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand all folders" }));

    expect(await screen.findByText("solution.pdf")).toBeInTheDocument();
    expect(screen.getByText("appendix.tex")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse all folders" }));

    await waitFor(() => {
      expect(screen.queryByText("solution.pdf")).not.toBeInTheDocument();
    });
    expect(screen.queryByText("appendix.tex")).not.toBeInTheDocument();
  });

  it("lets users expand a single folder without expanding the whole tree", async () => {
    render(
      <ProjectList
        activeSlug="demo-project"
        files={files}
        onSelect={vi.fn()}
        selectedPath={null}
        onUpload={vi.fn()}
      />,
    );

    await screen.findByText("Demo Project");

    const folderButton = screen.getByRole("button", { name: /First Proof/ });
    fireEvent.click(folderButton);

    expect(await screen.findByText("solution.pdf")).toBeInTheDocument();
    expect(screen.getByText("supplementary")).toBeInTheDocument();
    expect(screen.queryByText("appendix.tex")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /supplementary/ }));

    expect(await screen.findByText("appendix.tex")).toBeInTheDocument();
  });
});
