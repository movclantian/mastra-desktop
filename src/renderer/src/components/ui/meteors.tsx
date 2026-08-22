import { cn } from "@/lib/utils";

export interface MeteorsProps {
  number?: number;
  className?: string;
}

export function Meteors({ number = 20, className }: MeteorsProps) {
  const meteors = new Array(number).fill(true);

  return (
    <>
      {meteors.map((_, idx) => (
        <span
          key={`meteor-${idx}`}
          className={cn(
            "animate-meteor-effect absolute top-1/2 left-1/2 size-0.5 rotate-[215deg] rounded-[9999px] bg-slate-400 shadow-[0_0_0_1px_#ffffff10]",
            "before:absolute before:top-1/2 before:h-px before:w-[50px] before:-translate-y-[50%] before:bg-linear-to-r before:from-slate-400 before:to-transparent before:content-['']",
            className,
          )}
          style={{
            top: 0,
            left: `${Math.floor(Math.random() * (400 - -400) + -400)}px`,
            animationDelay: `${Math.random() * (0.8 - 0.2) + 0.2}s`,
            animationDuration: `${Math.floor(Math.random() * (10 - 2) + 2)}s`,
          }}
        />
      ))}
    </>
  );
}
