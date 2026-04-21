import { ChatCircleText, FileMagnifyingGlass } from "@phosphor-icons/react";
import { Section } from "./_primitives";
import type { FilePreviewLocation } from "@/lib/file-preview-preferences";
import type { KeyboardEvent } from "react";

const FILE_PREVIEW_LOCATION_OPTIONS: Array<{
  value: FilePreviewLocation;
  label: string;
  description: string;
  Icon: typeof FileMagnifyingGlass;
}> = [
  {
    value: "upper-pane",
    label: "Upper pane",
    description: "Files open above the chat transcript.",
    Icon: FileMagnifyingGlass,
  },
  {
    value: "chat-pane",
    label: "Chat pane",
    description: "Files open as cards in the chat transcript.",
    Icon: ChatCircleText,
  },
];

export function WorkspaceDisplaySection({
  filePreviewLocation,
  onFilePreviewLocationChange,
}: {
  filePreviewLocation: FilePreviewLocation;
  onFilePreviewLocationChange: (location: FilePreviewLocation) => void;
}) {
  const handleFilePreviewLocationKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keyActions: Record<string, "next" | "previous" | "first" | "last"> = {
      ArrowDown: "next",
      ArrowRight: "next",
      ArrowUp: "previous",
      ArrowLeft: "previous",
      Home: "first",
      End: "last",
    };
    const action = keyActions[event.key];
    if (!action) return;

    const radios = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='radio']"),
    );
    if (radios.length === 0) return;

    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[role='radio']")
      : null;
    const activeIndex = radios.findIndex((radio) => radio.getAttribute("aria-checked") === "true");
    const currentIndex = Math.max(0, target ? radios.indexOf(target) : activeIndex);
    const nextIndex =
      action === "first"
        ? 0
        : action === "last"
          ? radios.length - 1
          : action === "next"
            ? (currentIndex + 1) % radios.length
            : (currentIndex - 1 + radios.length) % radios.length;
    const nextValue = radios[nextIndex]?.dataset.previewLocation;
    if (nextValue !== "upper-pane" && nextValue !== "chat-pane") return;

    event.preventDefault();
    onFilePreviewLocationChange(nextValue);
    radios[nextIndex]?.focus();
  };

  return (
    <Section id="workspace-display" title="Workspace Display">
      <div>
        <div className="text-sm font-semibold text-foreground">File previews</div>
        <div
          className="mt-3 grid gap-2 sm:grid-cols-2"
          role="radiogroup"
          aria-label="File preview location"
          onKeyDown={handleFilePreviewLocationKeyDown}
        >
          {FILE_PREVIEW_LOCATION_OPTIONS.map(({ value, label, description, Icon }) => {
            const active = filePreviewLocation === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                data-preview-location={value}
                tabIndex={active ? 0 : -1}
                onClick={() => onFilePreviewLocationChange(value)}
                className={`flex min-h-20 items-start gap-3 rounded-lg border-2 px-4 py-3 text-left transition-colors ${
                  active
                    ? "border-accent bg-white text-foreground"
                    : "border-border bg-surface text-muted hover:border-accent hover:text-foreground"
                }`}
              >
                <Icon
                  size={18}
                  className={active ? "mt-0.5 text-accent" : "mt-0.5 text-muted"}
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{label}</span>
                  <span className="mt-1 block text-xs leading-5 text-muted">{description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </Section>
  );
}
