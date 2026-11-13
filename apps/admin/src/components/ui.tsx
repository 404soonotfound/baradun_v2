import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { messages } from "@/lib/messages";
import { Spinner } from "./loading";

// 운영자 화면 공통 부품 (BRD-148, 캔버스 4차 S3·V26). 값은 공유 토큰(D17-3)
// 색·글자는 사용자 화면과 같은 토큰, 높이·모서리는 시안 S3 값을 담은 운영자 토큰(admin-*, BRD-173)

const t = messages;

export function BrandRow() {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="flex size-8 items-center justify-center rounded-admin-badge bg-brand-default text-caption font-medium text-brand-on"
      >
        {t.brand.mark}
      </span>
      <span className="flex flex-col leading-tight whitespace-nowrap">
        <span className="text-body font-medium text-text-default">
          {t.brand.name}
        </span>
        <span className="text-caption text-text-muted">{t.brand.sub}</span>
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
      <div className="flex w-full max-w-[360px] flex-col gap-[18px] sm:rounded-admin-box sm:border sm:border-border-default sm:bg-bg-surface sm:px-6 sm:py-7 sm:shadow-card">
        <BrandRow />
        <div>
          <h1 className="text-title-l leading-snug font-semibold text-text-default">
            {title}
          </h1>
          {description && (
            <p className="mt-1 text-label-s text-text-muted">{description}</p>
          )}
        </div>
        {children}
        {footer && (
          <p className="text-caption text-text-muted sm:hidden">{footer}</p>
        )}
      </div>
      {footer && (
        <p className="mt-5 hidden text-caption text-text-muted sm:block">
          {footer}
        </p>
      )}
    </main>
  );
}

type Tone = "warn" | "neutral" | "fail" | "brand" | "success";

// 작업 성공색(color.success, 결정 E6·BRD-165): 저장·게시 완료·수집 정상에만. 해변 '특보 없음' 파랑과 섞지 않음
// 배지 모양은 수집 현황·데이터 출처가 함께 씀
export const SUCCESS_BADGE =
  "bg-success-bg text-success-fg ring-1 ring-success-border ring-inset";

const TONES: Record<Tone, string> = {
  warn: "border-status-stale-border bg-status-stale-bg",
  neutral: "border-border-default bg-bg-page",
  fail: "border-danger-border bg-status-blocked-bg",
  brand: "border-brand-border bg-brand-weak",
  success: "border-success-border bg-success-bg",
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
      className={`rounded-admin-box border px-3.5 py-3 text-body-s ${TONES[tone]}`}
    >
      <p className="font-semibold text-text-default">{title}</p>
      {children && <div className="mt-1 text-text-body">{children}</div>}
    </div>
  );
}

// 진행 중 버튼(GH-462, 보드 L0): busy면 왼쪽 14px 회전 표시 + busyLabel('게시 중…'), 다시 누르기 막음
// 두 라벨을 같은 칸에 겹쳐 두어 폭이 둘 중 넓은 쪽으로 고정됨(라벨이 바뀌어도 버튼 폭·주변이 밀리지 않음)
// disabled 대신 aria-disabled: 누른 버튼에 포커스가 남음
export function Button({
  variant = "primary",
  size = "auth",
  className = "",
  busy = false,
  busyLabel,
  children,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet";
  size?: "auth" | "small";
  busy?: boolean;
  busyLabel?: ReactNode;
}) {
  const sizes = {
    auth: "h-touch w-full text-title-s sm:h-admin-action sm:text-body",
    // 작은 버튼: PC 36, 모바일·태블릿은 터치 영역 44(시안 S3 '모바일 44')
    small: "h-touch px-3 text-body lg:h-admin-control",
  };
  const variants = {
    primary:
      "bg-brand-default text-brand-on hover:bg-brand-hover disabled:opacity-45",
    secondary:
      "border border-border-strong bg-bg-surface text-text-default hover:bg-bg-page disabled:opacity-45",
    quiet: "text-brand-default underline-offset-2 hover:underline",
  };
  return (
    <button
      type="button"
      {...props}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={(e) => {
        // 진행 중에는 다시 보내지 않음(제출 버튼이면 폼 제출도 막음)
        if (busy) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      className={`inline-flex items-center justify-center rounded-admin-control font-medium whitespace-nowrap disabled:cursor-not-allowed aria-disabled:cursor-progress ${sizes[size]} ${variants[variant]} ${className}`}
    >
      {busyLabel === undefined ? (
        children
      ) : (
        <span className="grid">
          <span
            className={`col-start-1 row-start-1 ${busy ? "invisible" : ""}`}
          >
            {children}
          </span>
          <span
            className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5 ${busy ? "" : "invisible"}`}
          >
            <Spinner size={14} />
            {busyLabel}
          </span>
        </span>
      )}
    </button>
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
      className={`text-label-s text-brand-default underline-offset-2 hover:underline ${className}`}
    >
      {children}
    </Link>
  );
}
