import { OLLAMA_RECOMMENDED_MODEL } from "@/lib/ollama-constants";
import { Section, StatusDot } from "./_primitives";

interface Props {
  strictLocalOnlyEnabled: boolean;
  saving: string | null;
  buttonClassName: string;
  onToggleStrictLocalOnly: (next: boolean) => void;
}

export function SetupAndConfigurationSection({
  strictLocalOnlyEnabled,
  saving,
  buttonClassName,
  onToggleStrictLocalOnly,
}: Props) {
  return (
    <Section title="Setup and configuration">
      <p className="text-sm text-muted">
        ScienceSwarm can use the OpenAI API or stay fully local with OpenClaw + Ollama +
        {" "}{OLLAMA_RECOMMENDED_MODEL}. Strict local-only mode forces the local path for chat
        and runtime.
      </p>
      <div className="rounded-lg border border-border bg-background p-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">Strict local-only mode</p>
            <p className="text-xs text-muted">
              Keeps chat and runtime on the local OpenClaw + Ollama path only.
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
              strictLocalOnlyEnabled
                ? "border border-ok/30 bg-ok/10 text-ok"
                : "border border-warn/30 bg-warn/10 text-warn"
            }`}
          >
            <StatusDot status={strictLocalOnlyEnabled ? "ok" : "warn"} />
            {strictLocalOnlyEnabled ? "on" : "off"}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onToggleStrictLocalOnly(!strictLocalOnlyEnabled)}
          disabled={saving === "strict-local-only"}
          className={buttonClassName}
        >
          {saving === "strict-local-only"
            ? "Saving..."
            : strictLocalOnlyEnabled
              ? "Turn off strict local-only"
              : "Turn on strict local-only"}
        </button>
      </div>
      <a
        href="/setup"
        className="inline-flex items-center px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:opacity-90 transition"
      >
        Open onboarding
      </a>
    </Section>
  );
}
