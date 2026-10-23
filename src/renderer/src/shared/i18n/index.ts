import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
import { zh } from "./locales/zh";

const resources = {
  zh: {
    ...zh,
    common: {
      ...zh.common,
      ...zh,
    },
  },
  en: {
    ...en,
    common: {
      ...en.common,
      ...en,
    },
  },
} as const;

export type InterfaceLanguageMode = "auto" | "zh" | "en";

const LANGUAGE_MODE_KEY = "mastra-desktop:language-mode";

function detectInterfaceLanguage(): "zh" | "en" {
  if (typeof navigator === "undefined") return "zh";
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  const match = languages.find((language) => /^(zh|en)([-_]|$)/i.test(language));
  return match?.toLowerCase().startsWith("en") ? "en" : "zh";
}

export function getInterfaceLanguageMode(): InterfaceLanguageMode {
  try {
    const value = localStorage.getItem(LANGUAGE_MODE_KEY);
    return value === "zh" || value === "en" || value === "auto" ? value : "auto";
  } catch {
    return "auto";
  }
}

export function setInterfaceLanguageMode(mode: InterfaceLanguageMode) {
  try {
    localStorage.setItem(LANGUAGE_MODE_KEY, mode);
  } catch {}
  return i18n.changeLanguage(mode === "auto" ? detectInterfaceLanguage() : mode);
}

const initialLanguageMode = getInterfaceLanguageMode();

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguageMode === "auto" ? detectInterfaceLanguage() : initialLanguageMode,
  fallbackLng: "zh",
  defaultNS: "common",
  fallbackNS: "common",
  interpolation: {
    escapeValue: false,
  },
});

export { useTranslation } from "react-i18next";
export { i18n };
export default i18n;
