import type { KnownBlock } from "@slack/web-api";

const BLOCK_CHAR_LIMIT = 3000;

/** Convert markdown **bold** to Slack mrkdwn *bold* */
function convertBold(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "*$1*");
}

/** Convert markdown `inline code` — already valid in Slack mrkdwn, no change needed */
/** Convert markdown [link](url) to Slack <url|link> */
function convertLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
}

/** Convert a full markdown string to Slack mrkdwn syntax */
function markdownToMrkdwn(text: string): string {
  let result = convertBold(text);
  result = convertLinks(result);
  return result;
}

/** Split text into chunks respecting the Slack block character limit.
 *  Splits on paragraph boundaries (double newlines) to avoid breaking
 *  fenced code blocks or other structured content mid-block. */
function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const paragraphs = text.split(/\n\n/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? current + "\n\n" + para : para;

    if (candidate.length <= limit) {
      current = candidate;
    } else if (current) {
      // Push what we have and start a new chunk with this paragraph
      chunks.push(current);
      // If the single paragraph itself exceeds the limit, split at newlines
      if (para.length > limit) {
        const subChunks = splitLongParagraph(para, limit);
        // All but last go directly into chunks
        for (let i = 0; i < subChunks.length - 1; i++) {
          chunks.push(subChunks[i]);
        }
        current = subChunks[subChunks.length - 1];
      } else {
        current = para;
      }
    } else {
      // current is empty and para alone exceeds limit
      const subChunks = splitLongParagraph(para, limit);
      for (let i = 0; i < subChunks.length - 1; i++) {
        chunks.push(subChunks[i]);
      }
      current = subChunks[subChunks.length - 1];
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

/** Split an oversized paragraph at single newlines, then spaces as fallback */
function splitLongParagraph(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n", limit);
    if (splitIndex < limit * 0.3) {
      splitIndex = remaining.lastIndexOf(" ", limit);
    }
    if (splitIndex < limit * 0.3) {
      splitIndex = limit;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n/, "");
  }

  return chunks;
}

/**
 * Convert markdown text to an array of Slack Block Kit blocks.
 * Handles code blocks, bullet lists, and regular text.
 * Splits long content across multiple blocks to stay within Slack limits.
 */
export function markdownToBlocks(text: string): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  // Split on fenced code blocks
  const parts = text.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    if (!part.trim()) continue;

    if (part.startsWith("```")) {
      // Code block — preserve as-is in mrkdwn (Slack renders ```)
      const codeContent = part;
      const chunks = splitText(codeContent, BLOCK_CHAR_LIMIT);
      for (const chunk of chunks) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: chunk },
        });
      }
    } else {
      // Regular text — convert markdown syntax to Slack mrkdwn
      const converted = markdownToMrkdwn(part);
      const chunks = splitText(converted, BLOCK_CHAR_LIMIT);
      for (const chunk of chunks) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: chunk },
        });
      }
    }
  }

  if (blocks.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: text || "(empty response)" },
    });
  }

  return blocks;
}

/** Return a standardized error block for Slack responses */
export function errorBlock(message: string): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: *Error:* ${message}`,
      },
    },
  ];
}
