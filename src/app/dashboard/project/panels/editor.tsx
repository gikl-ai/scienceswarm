"use client";

type FilePreviewKind = "iframe" | "image" | "video" | null;

const EDITOR_QUICK_ACTIONS = [
  "Improve this paragraph",
  "Check LaTeX syntax",
  "Suggest citations",
  "Simplify explanation",
  "Add proof details",
  "Generate figure caption",
] as const;

function getVideoMimeType(path: string | null): string | undefined {
  const ext = path?.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "ogg":
      return "video/ogg";
    default:
      return undefined;
  }
}

export interface EditorPanelProps {
  selectedFile: string | null;
  fileContent: string | null;
  filePreviewUrl: string | null;
  filePreviewKind: FilePreviewKind;
  onChangeContent: (value: string) => void;
  onQuickAction: (action: string) => void;
}

export function EditorPanel({
  selectedFile,
  fileContent,
  filePreviewUrl,
  filePreviewKind,
  onChangeContent,
  onQuickAction,
}: EditorPanelProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-white">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-muted">{selectedFile || "No file selected"}</span>
        </div>
        <div className="flex gap-2">
          <button className="text-xs bg-surface border border-border rounded px-3 py-1 text-muted hover:text-foreground transition-colors">
            Format
          </button>
          <button className="text-xs bg-accent text-white rounded px-3 py-1 hover:bg-accent-hover transition-colors">
            Save
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden flex">
        {filePreviewUrl ? (
          filePreviewKind === "image" ? (
            <div className="flex flex-1 items-center justify-center bg-black/5 p-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={filePreviewUrl}
                alt={selectedFile || "Image preview"}
                className="max-h-full max-w-full rounded-lg border border-border bg-white object-contain shadow-sm"
              />
            </div>
          ) : filePreviewKind === "video" ? (
            <div className="flex flex-1 items-center justify-center bg-black p-6">
              <video
                controls
                className="max-h-full max-w-full rounded-lg border border-border bg-black shadow-sm"
              >
                <source src={filePreviewUrl} type={getVideoMimeType(selectedFile)} />
              </video>
            </div>
          ) : (
            <iframe
              src={filePreviewUrl}
              title={selectedFile || "File preview"}
              className="flex-1 bg-white"
            />
          )
        ) : (
          <textarea
            value={fileContent ?? "Select a file from the tree to edit.\n\nSupported previews: text/code, .pdf, .xlsx, .ipynb, images, and common video files."}
            onChange={(e) => onChangeContent(e.target.value)}
            className="flex-1 p-6 font-mono text-sm bg-white resize-none focus:outline-none leading-relaxed"
            spellCheck={false}
          />
        )}
        <div className="w-80 border-l-2 border-border bg-surface/30 p-4 overflow-y-auto">
          <h3 className="text-xs font-bold text-muted uppercase tracking-wider mb-3">AI Assistant</h3>
          <p className="text-xs text-muted mb-4">Select text and ask the AI to help edit, improve, or analyze it.</p>
          <div className="space-y-2">
            {EDITOR_QUICK_ACTIONS.map((action) => (
              <button
                key={action}
                onClick={() => onQuickAction(action)}
                className="w-full text-left text-xs bg-white border-2 border-border rounded-lg px-3 py-2 text-foreground hover:border-accent hover:text-accent transition-colors"
              >
                {action}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
