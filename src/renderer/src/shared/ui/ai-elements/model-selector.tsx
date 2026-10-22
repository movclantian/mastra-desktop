import type { ComponentProps } from "react";
import { cn } from "@/shared/lib";

import { MODELS_DEV_LOGOS_URL } from "../../../../../shared/proxy-contract";

export type ModelSelectorLogoProps = Omit<ComponentProps<"img">, "src" | "alt"> & {
  provider: string;
};

export const ModelSelectorLogo = ({ provider, className, ...props }: ModelSelectorLogoProps) => (
  <img
    {...props}
    alt={`${provider} logo`}
    className={cn("size-3 dark:invert", className)}
    height={12}
    src={`${MODELS_DEV_LOGOS_URL}/${encodeURIComponent(provider)}.svg`}
    width={12}
  />
);

export type ModelSelectorNameProps = ComponentProps<"span">;

export const ModelSelectorName = ({ className, ...props }: ModelSelectorNameProps) => (
  <span className={cn("min-w-0 flex-1 truncate text-left", className)} {...props} />
);
