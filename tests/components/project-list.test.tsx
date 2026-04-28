// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudyList } from "@/components/research/study-list";
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

describe("StudyList file tree", () => {
  const studies = [
    {
      id: "demo-project",
      slug: "demo-project",
      name: "Demo Project",
      description: "AI for science",
      status: "active",
    },
  ];
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
          studies,
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the active study from the URL while the project list is still loading", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    render(
      <StudyList
        activeSlug="project-alpha"
        files={[]}
        onSelect={vi.fn()}
        selectedPath={null}
        onUpload={vi.fn()}
      />,
    );

    expect(screen.getByText("Project Alpha")).toBeInTheDocument();
    expect(screen.queryByTestId("study-list-spinner")).not.toBeInTheDocument();
    expect(screen.getByText(/No files yet/)).toBeInTheDocument();
  });

  it("starts with folders collapsed and supports expanding or collapsing all folders", async () => {
    render(
      <StudyList
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
      <StudyList
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

  it("does not let an inactive study chevron reopen the active study", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          studies: [
            ...studies,
            {
              id: "other-project",
              slug: "other-project",
              name: "Other Project",
              status: "active",
            },
          ],
        }),
      ),
    );

    render(
      <StudyList
        activeSlug="demo-project"
        files={files}
        onSelect={vi.fn()}
        selectedPath={null}
        onUpload={vi.fn()}
      />,
    );

    expect(await screen.findByText("First Proof")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse study" }));
    expect(screen.queryByText("First Proof")).not.toBeInTheDocument();

    const expandProjectButtons = screen.getAllByRole("button", { name: "Expand study" });
    fireEvent.click(expandProjectButtons[1]);

    expect(screen.queryByText("First Proof")).not.toBeInTheDocument();
  });
});
