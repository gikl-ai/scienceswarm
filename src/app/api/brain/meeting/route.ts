/**
 * POST /api/brain/meeting
 *
 * Parse and ingest a meeting transcript into the second brain.
 * Body: { content: string, title?: string, date?: string, attendees?: string[] }
 */

import {
  parseMeetingTranscript,
  ingestMeeting,
} from "@/brain/meeting-ingest";
import { isLocalRequest } from "@/lib/local-guard";
import { getBrainConfig, getLLMClient, isErrorResponse } from "../_shared";

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return Response.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }
    body = parsed;
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { content, title, date, attendees } = body as {
    content?: unknown;
    title?: unknown;
    date?: unknown;
    attendees?: unknown;
  };

  if (!content || typeof content !== "string") {
    return Response.json(
      { error: "Missing required field: content" },
      { status: 400 }
    );
  }

  if (title !== undefined && typeof title !== "string") {
    return Response.json(
      { error: "title must be a string" },
      { status: 400 }
    );
  }

  if (date !== undefined && typeof date !== "string") {
    return Response.json(
      { error: "date must be a string (YYYY-MM-DD)" },
      { status: 400 }
    );
  }

  if (attendees !== undefined) {
    if (
      !Array.isArray(attendees) ||
      !attendees.every((a: unknown) => typeof a === "string")
    ) {
      return Response.json(
        { error: "attendees must be an array of strings" },
        { status: 400 }
      );
    }
  }

  try {
    // Parse the transcript content
    const transcript = parseMeetingTranscript(content as string);

    // Override with explicit values if provided
    if (title) transcript.title = title as string;
    if (date) transcript.date = date as string;
    if (attendees) transcript.attendees = attendees as string[];

    const llm = getLLMClient(config);
    const result = await ingestMeeting(config, llm, transcript);
    return Response.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Meeting ingestion failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
