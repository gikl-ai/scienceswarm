import { RadarSettingsPanel } from "@/components/radar/radar-settings-panel";
import { RadarBriefingView } from "@/components/radar/radar-briefing-view";
import { Section } from "./_primitives";

interface Props {
  inputClassName: string;
  primaryButtonClassName: string;
}

export function ResearchRadarSection({ inputClassName, primaryButtonClassName }: Props) {
  return (
    <Section id="radar" title="Research Radar">
      <div className="space-y-6">
        <RadarSettingsPanel
          inputClassName={inputClassName}
          primaryButtonClassName={primaryButtonClassName}
        />
        <RadarBriefingView />
      </div>
    </Section>
  );
}
