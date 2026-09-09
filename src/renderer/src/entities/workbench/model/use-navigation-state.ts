import { useCallback, useState } from "react";
import type { SkillMetadata } from "./types";
import { DEFAULT_MAIN_VIEW, type MainView } from "./types";

export function useNavigationState() {
  const [activeView, setActiveView] = useState<MainView>(DEFAULT_MAIN_VIEW);
  const [activeSkill, setActiveSkill] = useState<SkillMetadata | null>(null);

  const openView = useCallback((view: MainView) => {
    setActiveView(view);
    if (view !== "skills") setActiveSkill(null);
  }, []);

  return { activeView, setActiveView, activeSkill, setActiveSkill, openView };
}
