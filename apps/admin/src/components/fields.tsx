"use client";

import { Check, Info } from "lucide-react";
import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { messages } from "@/lib/messages";
import { PASSWORD_RULE } from "@/lib/auth/policy";

// 입력 칸 (캔버스 S3: 높이 32(모바일 44), 포커스 링 3px brand.border, 오류 문구는 칸 아래)

export function Field({
  label,
  error,
  aside,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string | null;
  aside?: ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-body font-medium text-text-default">
          {label}
        </label>
        {aside}
      </div>
      <input
        id={id}
        {...input}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`h-touch rounded-admin-control border bg-bg-surface px-2.5 text-title-s font-normal text-text-default outline-none placeholder:text-text-muted read-only:bg-bg-page read-only:text-text-muted focus:border-brand-default focus:ring-[3px] focus:ring-brand-border sm:h-admin-control sm:text-body ${
          error
            ? "border-danger-text ring-[3px] ring-danger-border"
            : "border-border-strong"
        }`}
      />
      {error && (
        <p id={errorId} className="text-label-s text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

// 6자리 코드: 진짜 입력은 하나(붙여 넣기·자동 채움·화면 낭독기가 한 칸으로 다룸), 6칸은 보이는 모양만
export function CodeInput({
  label,
  value,
  onChange,
  error,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  autoFocus?: boolean;
}) {
  const id = useId();
  const digits = value.padEnd(6, " ").slice(0, 6).split("");
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      {/* 입력 칸은 6칸 위에 겹친 투명 칸 하나. 포커스 링은 다음에 넣을 칸에만 그림(겹친 칸 전체 테두리 없음) */}
      <div className="group relative">
        <div aria-hidden="true" className="grid grid-cols-6 gap-2">
          {digits.map((d, i) => (
            <span
              key={i}
              className={`flex h-touch items-center justify-center rounded-admin-control border text-num-count font-medium tabular-nums ${
                i !== Math.min(value.length, 5)
                  ? error
                    ? "border-danger-text"
                    : "border-border-strong"
                  : // 틀린 코드여도 포커스 링은 남김(키보드로 어디 있는지 보이게)
                    error
                    ? "border-danger-text group-focus-within:ring-[3px] group-focus-within:ring-brand-border"
                    : "border-border-strong group-focus-within:border-brand-default group-focus-within:ring-[3px] group-focus-within:ring-brand-border"
              }`}
            >
              {d.trim()}
            </span>
          ))}
        </div>
        <input
          id={id}
          value={value}
          onChange={(e) =>
            onChange(e.target.value.replace(/\D/g, "").slice(0, 6))
          }
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="absolute inset-0 h-full w-full cursor-text rounded-admin-control bg-transparent text-transparent caret-transparent outline-none"
        />
      </div>
      {error && (
        <p id={`${id}-error`} className="text-label-s text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

// 비밀번호 규칙 표시(D16-A4). 길이·숫자·두 칸 일치만 화면이 미리 봄. 최근 5개 재사용은 Cognito가 판단
export function passwordChecks(next: string, confirm: string) {
  return {
    length: next.length >= PASSWORD_RULE.minLength,
    number: /\d/.test(next),
    match: next.length > 0 && next === confirm,
  };
}

export function PasswordRules({
  next,
  confirm,
}: {
  next: string;
  confirm: string;
}) {
  const checks = passwordChecks(next, confirm);
  const rows = [
    [checks.length, messages.rules.length],
    [checks.number, messages.rules.number],
    [checks.match, messages.rules.match],
  ] as const;
  return (
    <ul className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-label-s text-text-body">
      {rows.map(([ok, label]) => (
        <li key={label} className="inline-flex items-center gap-1.5">
          {ok ? (
            <Check
              aria-hidden="true"
              size={14}
              strokeWidth={2.4}
              className="shrink-0 text-success-fg"
            />
          ) : (
            <Info
              aria-hidden="true"
              size={14}
              strokeWidth={2.2}
              className="shrink-0 text-text-muted"
            />
          )}
          <span>{label}</span>
          <span className="sr-only">
            {ok ? messages.rules.met : messages.rules.notMet}
          </span>
        </li>
      ))}
    </ul>
  );
}
