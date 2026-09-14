import { Badge } from "@/shared/ui/badge";
import type { getModelCapabilities } from "../model/providers";

export const CAPABILITY_STYLES = [
  {
    key: "reasoning",
    label: "推理",
    className: "border-violet-500/25 bg-violet-500/10 text-violet-600",
  },
  {
    key: "vision",
    label: "视觉",
    className: "border-blue-500/25 bg-blue-500/10 text-blue-600",
  },
  {
    key: "audio",
    label: "音频",
    className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-600",
  },
  {
    key: "tools",
    label: "工具",
    className: "border-amber-500/25 bg-amber-500/10 text-amber-600",
  },
] as const;

export function CapabilityBadges({ caps }: { caps: ReturnType<typeof getModelCapabilities> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {CAPABILITY_STYLES.filter((cap) => caps[cap.key]).map((cap) => (
        <Badge key={cap.key} variant="outline" className={`text-[10px] ${cap.className}`}>
          {cap.label}
        </Badge>
      ))}
    </div>
  );
}
