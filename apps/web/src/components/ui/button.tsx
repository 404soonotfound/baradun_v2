import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-[var(--radius-md)] px-5 text-sm font-bold transition-[background-color,box-shadow,transform] duration-150 disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--color-action-primary)] text-[var(--color-action-on-primary)] shadow-sm hover:bg-[var(--color-action-primary-hover)] active:translate-y-px",
        secondary:
          "border border-[var(--color-border-default)] bg-[var(--color-background-surface)] text-[var(--color-text-primary)] hover:bg-[var(--color-background-subtle)]",
        ghost:
          "text-[var(--color-text-primary)] hover:bg-[var(--color-background-subtle)]",
      },
    },
    defaultVariants: {
      variant: "primary",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({
  asChild = false,
  className,
  variant,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";

  return (
    <Component
      className={cn(buttonVariants({ variant }), className)}
      {...props}
    />
  );
}
