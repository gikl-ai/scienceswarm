export const OPENCLAW_CONTEXT_OVERFLOW_MESSAGE_LINES = [
  "ScienceSwarm could not complete this request because the research agent context became too large for the current turn.",
  "Your uploaded files and existing artifacts are still preserved in the workspace.",
  "Start a fresh study chat or retry after removing extra attached context.",
];

export function formatOpenClawContextOverflowMessage(separator = "\n\n"): string {
  return OPENCLAW_CONTEXT_OVERFLOW_MESSAGE_LINES.join(separator);
}
