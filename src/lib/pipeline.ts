import { startConversation } from "./openhands";
import { completeChat } from "./message-handler";
import { PIPELINE_TEMPLATES } from "./pipeline-templates";
export type { PipelineTemplate } from "./pipeline-templates";
export { PIPELINE_TEMPLATES } from "./pipeline-templates";

// ── Types ──────────────────────────────────────────────────────

export interface PipelineStep {
  id: string;
  name: string;
  type: "script" | "transform" | "analyze" | "chart" | "notify" | "condition";
  config: Record<string, unknown>;
  dependsOn?: string[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  output?: unknown;
}

export interface Pipeline {
  id: string;
  name: string;
  description: string;
  steps: PipelineStep[];
  status: "idle" | "running" | "completed" | "failed";
  currentStep: number;
  results: Record<string, unknown>[];
}

// ── In-Memory Store ────────────────────────────────────────────

const pipelines = new Map<string, Pipeline>();

// ── Step Executors ─────────────────────────────────────────────

async function executeStep(
  step: PipelineStep,
  previousOutput: unknown
): Promise<unknown> {
  switch (step.type) {
    case "script": {
      const script = (step.config.script as string) ?? "";
      const message = previousOutput
        ? `Run this script with the following input data:\nScript: ${script}\nInput: ${JSON.stringify(previousOutput)}`
        : `Run the following script and report the results: ${script}`;
      const conversation = await startConversation({ message });
      return {
        conversationId: conversation.id ?? conversation.conversation_id,
        script,
        status: "submitted",
      };
    }

    case "transform": {
      const format = (step.config.format as string) ?? "auto";
      const method = (step.config.method as string) ?? "";
      const prompt = [
        `Transform the following data.`,
        format !== "auto" ? `Format: ${format}.` : "",
        method ? `Method: ${method}.` : "",
        previousOutput ? `Input data: ${JSON.stringify(previousOutput)}` : "",
        `Config: ${JSON.stringify(step.config)}.`,
        `Return only the transformed result.`,
      ].filter(Boolean).join(" ");

      return completeChat({
        messages: [{ role: "user", content: prompt }],
        channel: "web",
      });
    }

    case "analyze": {
      const prompt = previousOutput
        ? `Analyze the following research data and provide detailed scientific insights:\n${JSON.stringify(previousOutput)}\n\nAdditional config: ${JSON.stringify(step.config)}`
        : `Perform the following analysis: ${step.name}. Config: ${JSON.stringify(step.config)}`;

      return completeChat({
        messages: [{ role: "user", content: prompt }],
        channel: "web",
        maxTokens: 4096,
      });
    }

    case "chart": {
      const chartPrompt = previousOutput
        ? `Generate Python matplotlib code to visualize this data:\n${JSON.stringify(previousOutput)}\n\nChart config: ${JSON.stringify(step.config)}`
        : `Generate Python matplotlib code for: ${step.name}. Config: ${JSON.stringify(step.config)}`;

      const chartCode = await completeChat({
        messages: [{ role: "user", content: chartPrompt }],
        channel: "web",
      });

      const conversation = await startConversation({
        message: `Run this Python chart code and save output to /workspace/charts/:\n\`\`\`python\n${chartCode}\n\`\`\``,
      });

      return {
        chartCode,
        conversationId: conversation.id ?? conversation.conversation_id,
      };
    }

    case "notify": {
      const channels = (step.config.channels as string[]) ?? [];
      const summary = previousOutput
        ? `Pipeline step "${step.name}" completed. Results:\n${JSON.stringify(previousOutput)}`
        : `Pipeline step "${step.name}" completed.`;

      // In production, this would send to Telegram/Slack/email via their APIs
      return {
        notified: true,
        channels,
        message: summary,
        timestamp: new Date().toISOString(),
      };
    }

    case "condition": {
      const conditionField = step.config.field as string | undefined;
      const conditionOp = (step.config.operator as string) ?? "truthy";
      const conditionValue = step.config.value;

      if (previousOutput == null) {
        return { conditionMet: false, reason: "No previous output to evaluate" };
      }

      const data = typeof previousOutput === "object" ? previousOutput as Record<string, unknown> : { value: previousOutput };
      const fieldValue = conditionField ? data[conditionField] : previousOutput;

      let conditionMet = false;
      switch (conditionOp) {
        case "equals":
          conditionMet = fieldValue === conditionValue;
          break;
        case "greater-than":
          conditionMet = Number(fieldValue) > Number(conditionValue);
          break;
        case "less-than":
          conditionMet = Number(fieldValue) < Number(conditionValue);
          break;
        case "contains":
          conditionMet = String(fieldValue).includes(String(conditionValue));
          break;
        case "truthy":
        default:
          conditionMet = Boolean(fieldValue);
          break;
      }

      return { conditionMet, fieldValue, operator: conditionOp, expected: conditionValue };
    }

    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

// ── Pipeline Execution ─────────────────────────────────────────

export async function executePipeline(pipeline: Pipeline): Promise<Pipeline> {
  pipelines.set(pipeline.id, pipeline);
  pipeline.status = "running";
  pipeline.currentStep = 0;
  pipeline.results = [];

  // Reset all step states before each run
  for (const step of pipeline.steps) {
    step.status = "pending";
    step.output = undefined;
  }

  // Build dependency graph — steps with no dependsOn run in declaration order
  const completedSteps = new Map<string, unknown>();

  for (let i = 0; i < pipeline.steps.length; i++) {
    const step = pipeline.steps[i];
    pipeline.currentStep = i;

    // Check dependencies
    if (step.dependsOn && step.dependsOn.length > 0) {
      const allDependenciesMet = step.dependsOn.every((depId) => {
        const depStep = pipeline.steps.find((s) => s.id === depId);
        return depStep && depStep.status === "completed";
      });
      if (!allDependenciesMet) {
        step.status = "skipped";
        step.output = { reason: "Dependencies not met" };
        pipeline.results.push({ stepId: step.id, skipped: true });
        continue;
      }
    }

    // Check condition gating: if a dependency step (or the previous step) is a
    // condition that returned false, skip this step.
    {
      const gatingSteps: PipelineStep[] = [];
      if (step.dependsOn && step.dependsOn.length > 0) {
        for (const depId of step.dependsOn) {
          const dep = pipeline.steps.find((s) => s.id === depId);
          if (dep) gatingSteps.push(dep);
        }
      } else if (i > 0) {
        gatingSteps.push(pipeline.steps[i - 1]);
      }

      const blockedByCondition = gatingSteps.some((dep) => {
        if (dep.type === "condition" && dep.output) {
          const condResult = dep.output as { conditionMet?: boolean };
          return condResult.conditionMet === false;
        }
        return false;
      });

      if (blockedByCondition) {
        step.status = "skipped";
        step.output = { reason: "Condition not met" };
        pipeline.results.push({ stepId: step.id, skipped: true });
        continue;
      }
    }

    step.status = "running";

    try {
      // Previous output: from dependencies or the preceding step
      let previousOutput: unknown = null;
      if (step.dependsOn && step.dependsOn.length > 0) {
        previousOutput = step.dependsOn.map((depId) => completedSteps.get(depId));
        if ((previousOutput as unknown[]).length === 1) {
          previousOutput = (previousOutput as unknown[])[0];
        }
      } else if (i > 0 && pipeline.steps[i - 1].status === "completed") {
        previousOutput = pipeline.steps[i - 1].output;
      }

      const output = await executeStep(step, previousOutput);
      step.status = "completed";
      step.output = output;
      completedSteps.set(step.id, output);
      pipeline.results.push({ stepId: step.id, output });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      step.status = "failed";
      step.output = { error: errorMsg };
      pipeline.results.push({ stepId: step.id, error: errorMsg });
      pipeline.status = "failed";
      return pipeline;
    }
  }

  pipeline.status = "completed";
  return pipeline;
}

// ── Pipeline Management ────────────────────────────────────────

export function createPipeline(
  name: string,
  description: string,
  steps: Omit<PipelineStep, "id" | "status" | "output">[]
): Pipeline {
  const id = `pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pipeline: Pipeline = {
    id,
    name,
    description,
    steps: steps.map((s, i) => ({
      ...s,
      id: s.dependsOn ? `step-${i}` : `step-${i}`,
      status: "pending" as const,
    })),
    status: "idle",
    currentStep: 0,
    results: [],
  };
  pipelines.set(id, pipeline);
  return pipeline;
}

export function createPipelineFromTemplate(
  templateKey: string,
  overrides?: Partial<Pick<Pipeline, "name" | "description">> & {
    stepConfigs?: Record<number, Record<string, unknown>>;
  }
): Pipeline | null {
  const template = PIPELINE_TEMPLATES[templateKey];
  if (!template) return null;

  const steps = template.steps.map((s, i) => {
    const config = overrides?.stepConfigs?.[i]
      ? { ...s.config, ...overrides.stepConfigs[i] }
      : s.config;
    return { ...s, config };
  });

  return createPipeline(
    overrides?.name ?? template.name,
    overrides?.description ?? template.description,
    steps
  );
}

export function getPipeline(id: string): Pipeline | undefined {
  return pipelines.get(id);
}

export function getPipelines(): Pipeline[] {
  return Array.from(pipelines.values());
}

export function deletePipeline(id: string): void {
  pipelines.delete(id);
}
