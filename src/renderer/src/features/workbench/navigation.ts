export const MAIN_VIEWS = ["chat", "agents", "skills", "library"] as const;
export type MainView = (typeof MAIN_VIEWS)[number];
export const DEFAULT_MAIN_VIEW: MainView = "chat";
