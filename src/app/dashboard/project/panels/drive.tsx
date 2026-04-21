import { DrivePanel as DrivePanelComponent } from "@/components/research/drive-panel";
import type { ComponentProps } from "react";

type DrivePanelComponentProps = ComponentProps<typeof DrivePanelComponent>;

export interface DrivePanelProps {
  onImport: NonNullable<DrivePanelComponentProps["onImport"]>;
}

export function DrivePanel({ onImport }: DrivePanelProps) {
  return <DrivePanelComponent onImport={onImport} />;
}
