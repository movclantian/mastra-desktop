import "../../shared/zod-config";
import "./index.css";
// 主题专属字体离线自托管(Fontsource) —— 必须在 index.css 之后导入,
// 确保 @font-face 声明先于主题变量注入生效。
import "@/shared/theme/fonts";
import "@/shared/i18n";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import RendererApp from "@/app/app";
import { installAuthenticatedFetch } from "@/features/auth";
import { hasWorkspaceDrafts } from "@/shared/lib/workspace-drafts";

installAuthenticatedFetch();

window.addEventListener("beforeunload", (event) => {
  if (!hasWorkspaceDrafts()) return;
  event.preventDefault();
  event.returnValue = "";
});

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <RendererApp />
    </StrictMode>,
  );
}
