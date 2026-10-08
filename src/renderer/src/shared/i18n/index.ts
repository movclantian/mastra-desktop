import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
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

export { useTranslation } from "react-i18next";
export { i18n };
export default i18n;
