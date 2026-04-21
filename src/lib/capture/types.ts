import type {
  CaptureChannel,
  CaptureKind,
  PrivacyMode,
  SourceRef,
} from "@/brain/types";

export interface CaptureInput {
  brainRoot: string;
  stateRoot: string;
  channel: CaptureChannel;
  userId: string;
  content: string;
  project?: string | null;
  kind?: CaptureKind;
  privacy?: PrivacyMode;
  transcript?: string;
  attachmentPaths?: string[];
  sourceRefs?: SourceRef[];
  sessionActiveProject?: string | null;
}

export interface ProjectResolution {
  project: string | null;
  source: "explicit" | "session" | "single-project" | "ambiguous";
  choices: string[];
  clarificationQuestion?: string;
}

export interface CaptureClassification {
  kind: CaptureKind;
  confidence: "low" | "medium" | "high";
  needsClarification: boolean;
}

export interface MaterializedCapture {
  materializedPath?: string;
  project: string | null;
  sourceRef: SourceRef;
}
