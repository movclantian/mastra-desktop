import type { SkillMetadata } from "@/features/workbench";

const ICONS = ["📦", "📝", "🪟", "📄", "🤖", "📘", "⚡", "🛠️"];

export function skillIcon(skill: SkillMetadata, index = 0) {
  const icon = skill.metadata?.icon;
  return typeof icon === "string" && icon.length > 0 ? icon : ICONS[index % ICONS.length];
}

export function skillSourceLabel(skill?: SkillMetadata) {
  if (skill?.origin === "builtin") return "Mastra 内置";
  if (skill?.isOfficial) return "官方认证";
  if (skill?.origin === "skills-sh") return "skills.sh";
  return skill?.marketplaceName || "个人技能";
}

export function formatInstalls(count?: number): string {
  if (count === undefined || count === null || Number.isNaN(count)) return "0";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(count);
}

export function getPaginationRange(current: number, total: number): (number | string)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, "...", total];
  if (current >= total - 3) return [1, "...", total - 4, total - 3, total - 2, total - 1, total];
  return [1, "...", current - 1, current, current + 1, "...", total];
}
