import { type BotAvatarProps, botAvatarFaces, botAvatarTypes } from "bot-avatars";
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Stable identity-based choices across every free stock shape, material and accessory. */
export function getBotAvatarAppearance(identity: string) {
  const hash = (key: string) => {
    let value = 2166136261;
    for (const char of `${identity}:${key}`)
      value = Math.imul(value ^ (char.codePointAt(0) ?? 0), 16777619);
    return value >>> 0;
  };
  const pick = <T>(key: string, values: readonly T[]): T => values[hash(key) % values.length];
  return {
    type: pick("shape", botAvatarTypes),
    face: pick("face", botAvatarFaces),
    shading: pick("material", ["fabric", "plastic", "crisp", "smooth", "flat"] as const),
    hat: pick("hat", ["none", "beret", "beanie", "party", "crown"] as const),
    glasses: pick("glasses", ["none", "round", "square", "shades"] as const),
    headphones: hash("headphones") % 3 === 0,
    bowTie: hash("bow-tie") % 3 === 0,
    whirl: pick("whirl", [0, 1]),
    speed: pick("speed", [0.85, 1, 1.15]),
    turn: pick("turn", [0.65, 1, 1.25]),
    jumpEvery: pick("jump-every", [8, 10, 12]),
    jumpSquashEase: pick("jump-ease", ["sharp", "pulse", "soft", "bouncy"] as const),
    seed: hash("phase") / 0x100000000,
  } satisfies BotAvatarProps;
}
