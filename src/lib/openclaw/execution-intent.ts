export function shouldForceOpenClawToolExecution(message: string): boolean {
  if (isExplanatoryClarificationRequest(message)) {
    return false;
  }

  const asksToCreateConcreteWorkspaceOutputs =
    /\b(?:scaffold|build|create|generate|write|draft|produce|implement|save|export|set\s+up|setup)\b/i.test(
      message,
    ) &&
    /\b(?:visible\s+)?(?:artifact|artifacts|file|files|workspace|project|experiment|starter code|codebase|code|config(?:uration)?s?|dataset(?:\s+entry\s+points?)?|entry\s+points?|training script|evaluation script|readme|notebook|chart|plot|graph|figure|report|plan|critique|cover letter|manuscript|package|benchmark|sweep|ablation)\b/i.test(
      message,
    );
  const asksToExecuteResearchWorkflow =
    /\b(?:run|rerun|re-run|execute|perform|start|train|evaluate|benchmark|sweep)\b/i.test(
      message,
    ) &&
    /\b(?:experiment|training|evaluation|benchmark|sweep|ablation|test[- ]time|analysis|script|job|pipeline|workflow)\b/i.test(
      message,
    );

  return asksToCreateConcreteWorkspaceOutputs || asksToExecuteResearchWorkflow;
}

function isExplanatoryClarificationRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    /^(?:what|which|where|why|how)\b/.test(normalized) ||
    /\b(?:explain|describe|summari[sz]e|tell me about|walk me through)\b/.test(normalized)
  ) &&
    !/\b(?:run|execute|create|generate|write|save|build|implement|train|evaluate|benchmark|sweep)\b/.test(normalized);
}
