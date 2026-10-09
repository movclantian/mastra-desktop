import "../../shared/zod-config";
import "./index.css";
// 主题专属字体离线自托管(Fontsource) —— 必须在 index.css 之后导入,
// 确保 @font-face 声明先于主题变量注入生效。
import "@/shared/theme/fonts";
import "@/shared/i18n";

import * as React from "react";
import { createRoot } from "react-dom/client";
import RendererApp from "@/app/app";
import { installAuthenticatedFetch } from "@/features/auth";
import { logWorkError } from "@/shared/lib/errors";
import { hasWorkspaceDrafts } from "@/shared/lib/workspace-drafts";

installAuthenticatedFetch();

if (import.meta.env.DEV) {
  const writeError = console.error.bind(console);
  // Passive-effect loops are warnings and never reach createRoot's error callbacks.
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("Maximum update depth exceeded")) {
      logWorkError(
        new Error(args[0]),
        "react:update-loop",
        React.captureOwnerStack?.() ?? undefined,
      );
      return;
    }
    writeError(...args);
  };
  import.meta.hot?.dispose(() => {
    console.error = writeError;
  });
}

window.addEventListener("beforeunload", (event) => {
  if (!hasWorkspaceDrafts()) return;
  event.preventDefault();
  event.returnValue = "";
});

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement, {
    onCaughtError: (error, info) => logWorkError(error, "react:caught", info.componentStack),
    onUncaughtError: (error, info) => logWorkError(error, "react:uncaught", info.componentStack),
    onRecoverableError: (error, info) =>
      logWorkError(error, "react:recoverable", info.componentStack),
  }).render(
    <React.StrictMode>
      <RendererApp />
    </React.StrictMode>,
  );
}
