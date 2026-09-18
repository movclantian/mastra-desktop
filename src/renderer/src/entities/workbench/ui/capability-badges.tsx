import { useTranslation } from "@/shared/i18n";
import { Badge } from "@/shared/ui/badge";
import type { getModelCapabilities } from "../model/providers";

export const CAPABILITY_STYLES = [
  {
    key: "reasoning",
    className: "border-violet-500/25 bg-violet-500/10 text-violet-600",
  },
  {
    key: "vision",
    className: "border-blue-500/25 bg-blue-500/10 text-blue-600",
  },
  {
    key: "audio",
    className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-600",
  },
  {
    key: "tools",
    className: "border-amber-500/25 bg-amber-500/10 text-amber-600",
  },
  {
    key: "structuredOutput",
    className: "border-cyan-500/25 bg-cyan-500/10 text-cyan-600",
  },
] as const;

export function CapabilityBadges({ caps }: { caps: ReturnType<typeof getModelCapabilities> }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1">
      {CAPABILITY_STYLES.filter((cap) => caps[cap.key]).map((cap) => (
        <Badge key={cap.key} variant="outline" className={`text-[10px] ${cap.className}`}>
          {t(`chat:models.capabilitiesList.${cap.key}`)}
        </Badge>
      ))}
    </div>
  );
}
