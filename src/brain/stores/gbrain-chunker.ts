/**
 * Recursive text chunker — port of gbrain's delimiter hierarchy.
 */

export interface TextChunk {
  text: string;
  index: number;
}

const DEFAULT_CHUNK_SIZE = 300;
const DEFAULT_CHUNK_OVERLAP = 50;

const DELIMITERS: RegExp[] = [
  /\n\n+/,
  /\n/,
  /(?<=[.!?])\s+/,
  /(?<=[,;:])\s+/,
  /\s+/,
];

export function chunkText(
  text: string,
  opts?: { chunkSize?: number; chunkOverlap?: number },
): TextChunk[] {
  const chunkSize = Math.max(1, opts?.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const chunkOverlap = Math.max(
    0,
    Math.min(opts?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP, chunkSize - 1),
  );

  const trimmed = text.trim();
  if (!trimmed) return [];

  const words = trimmed.split(/\s+/);
  if (words.length <= chunkSize) {
    return [{ text: trimmed, index: 0 }];
  }

  const segments = recursiveSplit(trimmed, chunkSize, 0);
  return mergeWithOverlap(segments, chunkSize, chunkOverlap);
}

function recursiveSplit(
  text: string,
  chunkSize: number,
  delimiterLevel: number,
): string[] {
  const wordCount = countWords(text);
  if (wordCount <= chunkSize) return [text];

  if (delimiterLevel >= DELIMITERS.length) {
    return hardSplitWords(text, chunkSize);
  }

  const delimiter = DELIMITERS[delimiterLevel];
  const parts = text.split(delimiter).filter((part) => part.length > 0);

  if (parts.length <= 1) {
    return recursiveSplit(text, chunkSize, delimiterLevel + 1);
  }

  const segments: string[] = [];
  let current = "";

  for (const part of parts) {
    const candidate = current ? `${current} ${part}` : part;
    if (countWords(candidate) > chunkSize && current) {
      segments.push(current.trim());
      current = part;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  const result: string[] = [];
  for (const segment of segments) {
    if (countWords(segment) > chunkSize) {
      result.push(...recursiveSplit(segment, chunkSize, delimiterLevel + 1));
    } else {
      result.push(segment);
    }
  }

  return result;
}

function hardSplitWords(text: string, chunkSize: number): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += chunkSize) {
    chunks.push(words.slice(index, index + chunkSize).join(" "));
  }
  return chunks;
}

function mergeWithOverlap(
  segments: string[],
  chunkSize: number,
  overlapWords: number,
): TextChunk[] {
  if (segments.length === 0) return [];

  const chunks: TextChunk[] = [];
  let index = 0;

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    let chunk = segments[segmentIndex];

    if (segmentIndex > 0 && overlapWords > 0 && chunks.length > 0) {
      const prevWords = segments[segmentIndex - 1].split(/\s+/);
      const overlapSlice = prevWords.slice(-overlapWords).join(" ");
      if (overlapSlice) {
        const currentStart = chunk.split(/\s+/).slice(0, overlapWords).join(" ");
        if (currentStart !== overlapSlice) {
          chunk = `${overlapSlice} ${chunk}`;
        }
      }
    }

    const words = chunk.split(/\s+/);
    if (words.length > chunkSize * 2) {
      chunk = words.slice(0, chunkSize * 2).join(" ");
    }

    chunks.push({ text: chunk.trim(), index });
    index += 1;
  }

  return chunks;
}

function countWords(text: string): number {
  if (!text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}
