import "./index.css";
// 主题专属字体离线自托管(Fontsource) —— 必须在 index.css 之后导入,
// 确保 @font-face 声明先于主题变量注入生效。
import "@/lib/theme/fonts";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import App from "./App";

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme">
        <App />
      </ThemeProvider>
    </StrictMode>,
  );
}
