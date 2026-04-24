import {
  getSelectableOpenAIModelOptions,
  resolveOpenAIModel,
} from "@/lib/openai-models";
import { Section, StatusDot } from "./_primitives";

type LlmProvider = "openai" | "local";

interface Props {
  provider: LlmProvider;
  model: string;
  openAiKey: string;
  savedOpenAiKeyMasked: string | null;
  strictLocalOnlyEnabled: boolean;
  openclawModel: string | null;
  openclawInstalled: boolean;
  openclawRunning: boolean;
  saving: string | null;
  inputClassName: string;
  primaryButtonClassName: string;
  secondaryButtonClassName: string;
  onProviderChange: (provider: LlmProvider) => void;
  onModelChange: (model: string) => void;
  onOpenAiKeyChange: (value: string) => void;
  onVerifyKey: () => void;
  onApplyRuntime: () => void;
}

export function ApiKeysAndModelSection({
  provider,
  model,
  openAiKey,
  savedOpenAiKeyMasked,
  strictLocalOnlyEnabled,
  openclawModel,
  openclawInstalled,
  openclawRunning,
  saving,
  inputClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
  onProviderChange,
  onModelChange,
  onOpenAiKeyChange,
  onVerifyKey,
  onApplyRuntime,
}: Props) {
  const keyAvailable = openAiKey.trim().length > 0 || Boolean(savedOpenAiKeyMasked);
  const openAiSelected = provider === "openai";
  const radioBaseClass =
    "flex cursor-pointer items-start gap-3 rounded-xl border-2 px-4 py-3 text-sm";
  const radioActiveClass = "border-accent bg-surface/40";
  const radioIdleClass = "border-border bg-white";
  const normalizedModel = resolveOpenAIModel(model);
  const modelOptions = getSelectableOpenAIModelOptions(normalizedModel);
  const selectedModel =
    modelOptions.find((option) => option.id === normalizedModel) ?? null;

  return (
    <Section title="API Keys & Model">
      <p className="text-sm text-muted">
        ScienceSwarm can run through the local Ollama path or the OpenAI API. Saving here
        updates direct chat and can push the same runtime into OpenClaw.
      </p>

      <div className="rounded-lg border border-border bg-background p-4 space-y-4">
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">LLM Provider</p>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="LLM Provider">
            <label
              className={`${radioBaseClass} ${
                openAiSelected ? radioActiveClass : radioIdleClass
              } ${strictLocalOnlyEnabled ? "opacity-60" : ""}`}
            >
              <input
                type="radio"
                name="llm-provider"
                value="openai"
                checked={openAiSelected}
                onChange={() => onProviderChange("openai")}
                disabled={strictLocalOnlyEnabled || saving !== null}
                className="mt-1 accent-accent"
                data-testid="llm-provider-openai"
              />
              <span>
                <span className="font-medium text-foreground">OpenAI API</span>
                <span className="ml-2 text-xs text-muted">
                  Cloud-backed chat and OpenClaw runtime
                </span>
              </span>
            </label>

            <label
              className={`${radioBaseClass} ${
                provider === "local" ? radioActiveClass : radioIdleClass
              }`}
            >
              <input
                type="radio"
                name="llm-provider"
                value="local"
                checked={provider === "local"}
                onChange={() => onProviderChange("local")}
                disabled={saving !== null}
                className="mt-1 accent-accent"
                data-testid="llm-provider-local"
              />
              <span>
                <span className="font-medium text-foreground">Local Ollama</span>
                <span className="ml-2 text-xs text-muted">
                  gemma and other local models
                </span>
              </span>
            </label>
          </div>
          {strictLocalOnlyEnabled && (
            <p className="text-xs text-warn">
              Strict local-only mode is enabled, so OpenAI is unavailable until you turn that off.
            </p>
          )}
        </div>

        {openAiSelected ? (
          <div className="space-y-4">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                OpenAI API Key
              </span>
              <input
                type="password"
                value={openAiKey}
                onChange={(event) => onOpenAiKeyChange(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={savedOpenAiKeyMasked ? "Saved key on file" : "sk-..."}
                className={`mt-1 ${inputClassName}`}
                disabled={saving !== null}
                data-testid="openai-api-key-input"
              />
              <span className="mt-2 flex items-center gap-2 text-xs text-muted">
                <StatusDot status={savedOpenAiKeyMasked ? "ok" : "warn"} />
                {savedOpenAiKeyMasked
                  ? `Saved key on file: ${savedOpenAiKeyMasked}`
                  : "No saved OpenAI key yet."}
              </span>
            </label>

            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                OpenAI Model
              </span>
              <select
                value={normalizedModel}
                onChange={(event) => onModelChange(event.target.value)}
                className={`mt-1 ${inputClassName}`}
                disabled={saving !== null}
                data-testid="openai-model-input"
              >
                {modelOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="mt-2 block text-xs text-muted">
                {selectedModel?.helper
                  ?? "Choose the OpenAI model for direct chat and OpenClaw."}
              </span>
            </label>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-surface/40 p-3 text-sm text-muted">
            Local provider uses the Ollama daemon and the Local model card below. Switch back to
            OpenAI here whenever you want cloud-backed direct chat or OpenClaw.
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {openAiSelected && (
            <button
              type="button"
              onClick={onVerifyKey}
              disabled={!keyAvailable || saving !== null}
              className={secondaryButtonClassName}
              data-testid="openai-verify-key-button"
            >
              {saving === "verify-openai-key" ? "Verifying..." : "Verify key"}
            </button>
          )}
          <button
            type="button"
            onClick={onApplyRuntime}
            disabled={
              saving !== null
              || (openAiSelected && (!keyAvailable || normalizedModel.trim().length === 0))
            }
            className={primaryButtonClassName}
            data-testid="runtime-apply-button"
          >
            {saving === "apply-runtime"
              ? "Saving..."
              : openAiSelected
                ? "Save and apply to OpenClaw"
                : "Save local runtime"}
          </button>
        </div>

        <p className="text-xs text-muted" data-testid="openclaw-runtime-summary">
          {openclawInstalled
            ? openclawRunning
              ? `OpenClaw is running with ${openclawModel || "its saved model"}. Applying here reconfigures and restarts it.`
              : `OpenClaw is installed${openclawModel ? ` and currently points at ${openclawModel}` : ""}. Applying here configures and starts it.`
            : "OpenClaw is not installed yet. Saving still updates direct chat, and the OpenClaw card can apply these settings after install."}
        </p>
      </div>
    </Section>
  );
}
