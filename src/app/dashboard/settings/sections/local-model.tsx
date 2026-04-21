import type { OllamaStatusSummary } from "@/lib/setup/config-status";
import { OllamaSection } from "@/components/setup/ollama-section";
import { OLLAMA_RECOMMENDED_MODEL } from "@/lib/ollama-constants";
import { Section } from "./_primitives";

interface Props {
  ollamaCardStatus: OllamaStatusSummary | null;
  configuredOllamaModel: string;
  configuredOllamaModelInstalled: boolean;
  saving: string | null;
  onConfiguredModelChange: (model: string) => void;
  onLocalModelReady: (model: string) => void;
}

export function LocalModelSection({
  ollamaCardStatus,
  configuredOllamaModel,
  configuredOllamaModelInstalled,
  saving,
  onConfiguredModelChange,
  onLocalModelReady,
}: Props) {
  return (
    <Section title="Local model">
      <p className="text-sm text-muted">
        Settings defaults to Ollama + {OLLAMA_RECOMMENDED_MODEL}, and can switch to larger
        local models like gemma4:26b.
      </p>
      <div className="rounded-lg border border-border bg-background p-3 text-sm text-muted">
        <span className="font-medium text-foreground">Selected local model:</span>{" "}
        {configuredOllamaModelInstalled
          ? `${configuredOllamaModel} ready`
          : `${configuredOllamaModel} not ready yet`}
      </div>
      <OllamaSection
        initialStatus={ollamaCardStatus}
        initialConfiguredModel={configuredOllamaModel}
        disabled={saving !== null}
        onConfiguredModelChange={onConfiguredModelChange}
        onModelSelected={onLocalModelReady}
        embedded
        autoRemediate
      />
    </Section>
  );
}
