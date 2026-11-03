import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { messages } from "@/lib/messages";

// 운영자 화면 공통 부품 (BRD-148, 캔버스 4차 S3·V26). 값은 공유 토큰(D17-3)

const t = messages;

export function BrandRow() {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="flex size-8 items-center justify-center rounded-badge bg-brand-default text-[12px] font-medium text-brand-on"
      >
        {t.brand.mark}
      </span>
      <span className="flex flex-col leading-tight whitespace-nowrap">
        <span className="text-[14px] font-medium text-text-default">
          {t.brand.name}
        </span>
        <span className="text-[12px] text-text-muted">{t.brand.sub}</span>
      </span>
    </div>
  );
}

// 로그인 카드 틀: PC는 가운데 카드(최대 360), 모바일은 카드 없이 화면 전체
export function AuthShell({
  title,
  description,
  children,
  footer = t.common.operatorOnly,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: string | null;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center bg-bg-surface px-6 pt-15 pb-10 sm:justify-center sm:bg-bg-page sm:px-4 sm:py-10">
      <div className="flex w-full max-w-[360px] flex-col gap-[18px] sm:rounded-[8px] sm:border sm:border-border-default sm:bg-bg-surface sm:px-6 sm:py-7 sm:shadow-card">
        <BrandRow />
        <div>
          <h1 className="text-[20px] leading-snug font-semibold text-text-default sm:text-[18px]">
            {title}
          </h1>
          {description && (
            <p className="mt-1 text-[12.5px] text-text-muted">{description}</p>
          )}
        </div>
        {children}
        {footer && (
          <p className="text-[12px] text-text-muted sm:hidden">{footer}</p>
        )}
      </div>
      {footer && (
        <p className="mt-5 hidden text-[12px] text-text-muted sm:block">
          {footer}
        </p>
      )}
    </main>
  );
}

type Tone = "warn" | "neutral" | "fail" | "brand";

const TONES: Record<Tone, string> = {
  warn: "border-status-stale-border bg-status-stale-bg",
  neutral: "border-border-default bg-bg-page",
  fail: "border-danger-border bg-status-blocked-bg",
  brand: "border-brand-border bg-brand-weak",
};

// 알림 상자: 굵은 첫 줄 + 설명. 색만으로 뜻을 나누지 않게 첫 줄 문구가 상태를 말함
export function Notice({
  tone,
  title,
  children,
  role,
}: {
  tone: Tone;
  title: string;
  children?: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div
      role={role}
      className={`rounded-[8px] border px-3.5 py-3 text-[13px] ${TONES[tone]}`}
    >
      <p className="font-semibold text-text-default">{title}</p>
      {children && <div className="mt-1 text-text-body">{children}</div>}
    </div>
  );
}

export function Button({
  variant = "primary",
  size = "auth",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet";
  size?: "auth" | "small";
}) {
  const sizes = {
    auth: "h-11 w-full text-[15px] sm:h-10 sm:text-[14px]",
    small: "h-9 px-3 text-[13px]",
  };
  const variants = {
    primary:
      "bg-brand-default text-brand-on hover:bg-brand-hover disabled:opacity-50",
    secondary:
      "border border-border-strong bg-bg-surface text-text-default hover:bg-bg-page disabled:opacity-50",
    quiet: "text-brand-default underline-offset-2 hover:underline",
  };
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center rounded-[6px] font-medium whitespace-nowrap disabled:cursor-not-allowed ${sizes[size]} ${variants[variant]} ${className}`}
    />
  );
}

// 안쪽 이동은 Link(페이지를 새로 불러오지 않음). 새로 불러오면 메모리의 로그인이 사라짐(D16-A2)
export function TextLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`text-[12.5px] text-brand-default underline-offset-2 hover:underline ${className}`}
    >
      {children}
    </Link>
  );
}
