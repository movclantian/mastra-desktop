import { en } from "../src/renderer/src/shared/i18n/locales/en.ts";
import { zh } from "../src/renderer/src/shared/i18n/locales/zh.ts";

function flatten(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

const enKeys = new Set(flatten({ common: en.common, settings: en.settings }));
const zhKeys = new Set(flatten({ common: zh.common, settings: zh.settings }));
const missingInEnglish = [...zhKeys].filter((key) => !enKeys.has(key));
const missingInChinese = [...enKeys].filter((key) => !zhKeys.has(key));

if (missingInEnglish.length || missingInChinese.length) {
  console.error(JSON.stringify({ missingInEnglish, missingInChinese }, null, 2));
  process.exitCode = 1;
} else {
  console.log(`settings i18n complete: ${enKeys.size} shared keys`);
}
