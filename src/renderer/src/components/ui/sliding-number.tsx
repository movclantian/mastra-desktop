import { motion, useSpring, useTransform } from "motion/react";
import * as React from "react";
import { cn } from "@/lib/utils";

export interface SlidingNumberProps {
  number: number;
  className?: string;
  decimalPlaces?: number;
  decimalSeparator?: string;
  thousandSeparator?: string;
  padStart?: number;
  transition?: {
    stiffness?: number;
    damping?: number;
    mass?: number;
  };
}

function Digit({
  place,
  value,
  transition,
}: {
  place: number;
  value: number;
  transition?: { stiffness?: number; damping?: number; mass?: number };
}) {
  const spring = useSpring(value, {
    stiffness: transition?.stiffness ?? 200,
    damping: transition?.damping ?? 22,
    mass: transition?.mass ?? 0.4,
  });

  React.useEffect(() => {
    spring.set(value);
  }, [spring, value]);

  const y = useTransform(spring, (latest) => {
    const digit = Math.floor(latest / place) % 10;
    return `-${(digit >= 0 ? digit : 0) * 10}%`;
  });

  return (
    <span className="relative inline-block h-[1em] w-[0.6em] overflow-hidden leading-none tabular-nums">
      <motion.span style={{ y }} className="absolute top-0 left-0 flex flex-col font-mono">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className="flex h-[1em] items-center justify-center">
            {i}
          </span>
        ))}
      </motion.span>
    </span>
  );
}

export function SlidingNumber({
  number,
  className,
  decimalPlaces = 0,
  decimalSeparator = ".",
  thousandSeparator = ",",
  padStart = 0,
  transition,
}: SlidingNumberProps) {
  const isNegative = number < 0;
  const absValue = Math.abs(number);

  const formattedStr = absValue.toFixed(decimalPlaces);
  const [intPartRaw, decPart] = formattedStr.split(".");
  const intPartPadded = intPartRaw.padStart(padStart, "0");

  const intDigits = intPartPadded.split("").map(Number);

  return (
    <span className={cn("inline-flex items-center font-mono tabular-nums", className)}>
      {isNegative && <span>-</span>}
      {intDigits.map((digit, idx) => {
        const placeFromRight = intDigits.length - 1 - idx;
        const place = 10 ** placeFromRight;
        const showThousand = thousandSeparator && placeFromRight > 0 && placeFromRight % 3 === 0;

        return (
          <React.Fragment key={`int-${idx}-${placeFromRight}`}>
            <Digit place={place} value={digit} transition={transition} />
            {showThousand && <span>{thousandSeparator}</span>}
          </React.Fragment>
        );
      })}
      {decimalPlaces > 0 && decPart && (
        <>
          <span>{decimalSeparator}</span>
          {decPart.split("").map((digit, idx) => (
            <Digit key={`dec-${idx}`} place={1} value={Number(digit)} transition={transition} />
          ))}
        </>
      )}
    </span>
  );
}
