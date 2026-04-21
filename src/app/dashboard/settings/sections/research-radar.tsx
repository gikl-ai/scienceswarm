import { RadarSettingsPanel } from "@/components/radar/radar-settings-panel";
import { Section } from "./_primitives";

interface Props {
  inputClassName: string;
  primaryButtonClassName: string;
}

export function ResearchRadarSection({ inputClassName, primaryButtonClassName }: Props) {
  return (
    <Section id="radar" title="Research Radar">
      <RadarSettingsPanel
        inputClassName={inputClassName}
        primaryButtonClassName={primaryButtonClassName}
      />
    </Section>
  );
}
