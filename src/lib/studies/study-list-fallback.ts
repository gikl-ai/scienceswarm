import type { StudyRecord } from "@/brain/gbrain-data-contracts";
import { listProjectRecordsFromDisk } from "@/lib/projects/project-list-fallback";
import { studyRecordFromProjectRecord } from "./study-repository";

export async function listStudyRecordsFromDisk(): Promise<StudyRecord[]> {
  return (await listProjectRecordsFromDisk()).map(studyRecordFromProjectRecord);
}
