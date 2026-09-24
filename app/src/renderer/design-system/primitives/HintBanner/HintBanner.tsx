import type { ReactNode } from "react";
import { cn } from "../../lib/variants";

export function HintBanner({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border border-l-[3px] border-l-gold bg-gold/[0.05] px-3.5 py-2.5 text-[12.5px]",
        className,
      )}
    >
      {children}
    </div>
  );
}
