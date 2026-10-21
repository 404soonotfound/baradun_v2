"use client";

import { Check } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

// 토스트 (BRD-81 · 컴포넌트 명세 Toast, Figma L16 188:484)
// 어두운 바탕(라이트) 한 줄 알림. 하단 탭 위 96px, 4초 뒤 사라짐, role="status"
// 예: "링크를 복사했어요", "14:42 기준으로 바뀌었어요 · 2곳 상태 변경", 지우기 뒤 "되돌리기"

export const TOAST_MS = 4000;

export interface ToastMessage {
  text: string;
  // 되돌리기 같은 행동 버튼(선택)
  action?: { label: string; onClick: () => void };
}

// 토스트 상태 훅. show(메시지)를 부르면 4초 동안 보이고 사라짐
// 포인터가 올라가 있거나 안쪽 버튼에 포커스가 있으면(hold) 시간을 멈춤: 되돌리기를 누르기 전에 사라지지 않게
// 포인터와 포커스는 따로 셈. 하나가 풀려도 다른 하나가 남아 있으면 계속 멈춤
export type ToastHoldKind = "pointer" | "focus";

export function useToast() {
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const [holds, setHolds] = useState({ pointer: false, focus: false });
  const held = holds.pointer || holds.focus;

  // 메시지가 바뀌거나 hold가 풀릴 때마다 4초 타이머를 새로 걸어줌. 화면을 떠나면 타이머 정리(return 함수)
  useEffect(() => {
    if (message === null || held) return;
    const timer = window.setTimeout(() => setMessage(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [message, held]);

  const hold = useCallback(
    (kind: ToastHoldKind, on: boolean) =>
      setHolds((prev) => (prev[kind] === on ? prev : { ...prev, [kind]: on })),
    [],
  );
  const hide = useCallback(() => {
    setMessage(null);
    setHolds({ pointer: false, focus: false });
  }, []);
  // 행동 버튼을 누르면 토스트도 닫음(되돌리기를 두 번 누르거나, 되돌린 뒤에도 '지웠어요'가 남지 않게)
  // useCallback = 렌더링마다 새 함수를 만들지 않음(자식에게 넘겨도 불필요한 다시 그리기 없음)
  const show = useCallback(
    (next: ToastMessage) => {
      const action = next.action;
      setMessage(
        action
          ? {
              ...next,
              action: {
                label: action.label,
                onClick: () => {
                  hide();
                  action.onClick();
                },
              },
            }
          : next,
      );
    },
    [hide],
  );

  return { message, show, hide, hold };
}

export function Toast({
  message,
  icon = <Check size={16} strokeWidth={2.6} />,
  onHold,
}: {
  message: ToastMessage | null;
  icon?: ReactNode;
  // useToast의 hold. 포인터·포커스가 토스트 안에 있는 동안 사라지는 시간을 멈춤
  onHold?: (kind: ToastHoldKind, held: boolean) => void;
}) {
  return (
    // 이 상자는 늘 화면에 있어야 함: 비어 있다가 글자가 들어올 때 화면 읽기 프로그램이 읽어 줌
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(96px+env(safe-area-inset-bottom))] z-50 flex justify-center px-4 lg:bottom-8"
    >
      {message && (
        <div
          onPointerEnter={() => onHold?.("pointer", true)}
          onPointerLeave={() => onHold?.("pointer", false)}
          onFocus={() => onHold?.("focus", true)}
          // 포커스가 토스트 밖으로 나갈 때만 풀림(안쪽끼리 옮겨 갈 때는 유지)
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) {
              onHold?.("focus", false);
            }
          }}
          className="pointer-events-auto flex max-w-full items-center gap-2 rounded-[22px] bg-text-default px-4 py-2.5 text-body-s text-bg-surface shadow-floating"
        >
          <span aria-hidden="true" className="shrink-0">
            {icon}
          </span>
          <span className="min-w-0">{message.text}</span>
          {message.action && (
            <button
              type="button"
              onClick={message.action.onClick}
              className="-my-2 ml-1 min-h-touch shrink-0 px-2 font-bold underline"
            >
              {message.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
