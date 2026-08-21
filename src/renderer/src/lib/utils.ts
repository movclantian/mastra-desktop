/** shadcn/ui 标准 cn 助手(class 合并 + Tailwind 冲突消解)。 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
