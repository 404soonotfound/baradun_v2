import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

const statusBadgeVariants = cva(
  "inline-flex min-h-7 items-center rounded-full border px-3 py-1 text-xs font-bold",
  {
    variants: {
      tone: {
        available:
          "border-[var(--status-available-border)] bg-[var(--status-available-background)] text-[var(--status-available-foreground)]",
        caution:
          "border-[var(--status-caution-border)] bg-[var(--status-caution-background)] text-[var(--status-caution-foreground)]",
        unavailable:
          "border-[var(--status-unavailable-border)] bg-[var(--status-unavailable-background)] text-[var(--status-unavailable-foreground)]",
        unknown:
          "border-[var(--status-unknown-border)] bg-[var(--status-unknown-background)] text-[var(--status-unknown-foreground)]",
      },
    },
    defaultVariants: {
      tone: "unknown",
    },
  },
);

export interface StatusBadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusBadgeVariants> {}

export function StatusBadge({
  className,
  tone,
  ...props
}: StatusBadgeProps) {
  return (
    <span className={cn(statusBadgeVariants({ tone }), className)} {...props} />
  );
}
