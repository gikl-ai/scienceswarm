import { FrontierWatchComposer } from "@/components/settings/frontier-watch-composer";
import type { ProjectWatchConfig } from "@/lib/watch/types";
import type { Dispatch, SetStateAction } from "react";
import { Section } from "./_primitives";

interface ProjectOption {
  id: string;
  name: string;
}

interface Props {
  projectOptions: ProjectOption[];
  watchProject: string;
  onWatchProjectChange: (project: string) => void;
  watchConfig: ProjectWatchConfig;
  setWatchConfig: Dispatch<SetStateAction<ProjectWatchConfig>>;
  watchLoading: boolean;
  watchSaving: boolean;
  watchError: string | null;
  onSave: () => void;
  inputClassName: string;
  primaryButtonClassName: string;
  secondaryButtonClassName: string;
}

export function FrontierWatchSection(props: Props) {
  return (
    <Section id="frontier-watch" title="Frontier Watch">
      <FrontierWatchComposer {...props} />
    </Section>
  );
}
