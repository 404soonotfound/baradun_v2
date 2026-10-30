import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

// 버튼 (노션 4장: 높이 52, 모서리 14). 색은 브랜드 토큰만 씀(판단 상태 색 아님).
// hover는 투명도 대신 채움 색을 바꿈(opacity-90은 글자 대비 4.03으로 4.5 미만, BRD-129). 대비는 check:tokens가 확인
const buttonVariants = cva(
  "inline-flex h-button min-w-touch items-center justify-center gap-2 rounded-button px-5 text-title-s transition-[background-color,opacity,transform] duration-200 ease-standard disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        primary:
          "bg-brand-default text-brand-on shadow-card hover:bg-brand-hover active:translate-y-px",
        secondary:
          "border border-border-strong bg-bg-surface text-text-default hover:bg-bg-subtle",
        ghost: "text-text-default hover:bg-bg-subtle",
      },
    },
    defaultVariants: {
      variant: "primary",
    },
  },
);

export interface ButtonProps
  extends
    ButtonHTMLAttributes<HTMLButtonElement>,
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
