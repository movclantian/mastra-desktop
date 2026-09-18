import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
import { zh } from "./locales/zh";

export const defaultNS = "common";
export const resources = {
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

export const SUPPORTED_LANGUAGES = [
  { code: "zh", label: "简体中文", subLabel: "Chinese (Simplified)" },
  { code: "en", label: "English", subLabel: "English (US)" },
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]["code"];

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "zh",
    defaultNS: "common",
    fallbackNS: "common",
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "mastra-desktop:language",
      caches: ["localStorage"],
    },
  });

export { Trans, useTranslation } from "react-i18next";
export { i18n };
export default i18n;
