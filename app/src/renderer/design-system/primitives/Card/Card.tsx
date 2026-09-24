import { forwardRef, type ElementType, type HTMLAttributes } from "react";
import { cn, cva, type VariantProps } from "../../lib/variants";

/**
 * Surface primitive for every grouped block.
 *
 * The inset top highlight is what separates two stacked dark surfaces without a
 * heavier border: the 1px edge reads as light catching the top of the panel.
 * Kept as an inset shadow (not a border-top) so `rounded-xl` corners stay clean.
 */
const cardVariants = cva(
  "rounded-xl border border-border bg-card shadow-[inset_0_1px_0_0_color-mix(in_oklab,var(--color-fg)_5%,transparent)]",
  {
    variants: {
      padding: {
        default: "p-3",
        compact: "p-2.5",
        none: "",
      },
    },
    defaultVariants: { padding: "default" },
  },
);

type CardElement = "div" | "li";

export const Card = forwardRef<
  HTMLElement,
  HTMLAttributes<HTMLElement> & VariantProps<typeof cardVariants> & { as?: CardElement }
>(function Card({ as: Tag = "div", className, padding, ...props }, ref) {
  const Element = Tag as ElementType;
  return <Element ref={ref} className={cn(cardVariants({ padding }), className)} {...props} />;
});
