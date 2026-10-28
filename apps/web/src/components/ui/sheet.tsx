"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useEffect,
  useId,
  useRef,
  type PointerEvent,
  type ReactNode,
} from "react";

import { useScrollLock } from "@/lib/scroll-lock";

// 시트 (노션 3장 Sheet): 모바일은 아래에서 올라오는 시트, PC(lg 이상)는 가운데 대화상자
//   위 모서리 22, 손잡이 40×4, 뒤 화면 어둡게, 아래로 끌거나 닫기로 닫힘, 포커스는 시트 안에 가둠
// 브라우저 기본 <dialog>의 showModal() 사용 → 포커스 가두기·Esc·뒤 화면 막기(inert)는 브라우저가 처리
// 열고 닫는 상태와 뒤로 가기는 useSheet() 담당
const DRAG_CLOSE_PX = 80; // 이만큼 아래로 끌면 닫힘

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const t = useTranslations("sheet");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; dy: number } | null>(null);
  const titleId = useId();

  // open 값에 맞춰 대화상자 열기·닫기
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // 열려 있는 동안 뒤 페이지 스크롤 막기(겹친 대화상자와 잠금 수를 나눠 셈)
  useScrollLock(open);

  // 손잡이 끌기 (모바일만)
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    drag.current = { startY: event.clientY, dy: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    const panel = panelRef.current;
    if (!current || !panel) return;
    current.dy = Math.max(0, event.clientY - current.startY); // 위로는 움직이지 않음
    panel.style.transform = `translateY(${current.dy}px)`;
  }
  function onPointerEnd() {
    const current = drag.current;
    drag.current = null;
    if (panelRef.current) panelRef.current.style.transform = "";
    if (current && current.dy > DRAG_CLOSE_PX) onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      // Esc 등으로 브라우저가 직접 닫았을 때도 기록 칸을 정리하도록 onClose로 연결
      onClose={() => {
        if (open) onClose();
      }}
      className="m-0 h-dvh max-h-none w-full max-w-none bg-transparent p-0 text-text-default backdrop:bg-transparent"
    >
      {/* 뒤 화면 어둡게 + 누르면 닫힘. 키보드는 Esc·닫기 버튼으로 닫기 */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 animate-[sheet-fade_400ms_var(--ease-standard)] bg-scrim lg:animate-[sheet-fade_200ms_var(--ease-standard)]"
      />
      <div
        ref={panelRef}
        className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] animate-[sheet-up_400ms_var(--ease-decelerate)] flex-col rounded-t-sheet bg-bg-surface pb-[max(22px,env(safe-area-inset-bottom))] shadow-floating lg:inset-auto lg:top-1/2 lg:left-1/2 lg:max-h-[80dvh] lg:w-[min(560px,calc(100vw-80px))] lg:-translate-x-1/2 lg:-translate-y-1/2 lg:animate-[sheet-fade_200ms_var(--ease-standard)] lg:rounded-card lg:pb-6"
      >
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          className="flex h-6 shrink-0 touch-none items-center justify-center lg:hidden"
        >
          <span
            aria-hidden="true"
            className="h-1 w-10 rounded-full bg-border-strong"
          />
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 pr-2 pl-gutter lg:pt-4 lg:pl-6">
          <h2 id={titleId} className="text-title-l">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            className="flex size-touch items-center justify-center rounded-full text-text-body hover:bg-bg-subtle"
          >
            <X aria-hidden="true" size={22} />
          </button>
        </div>
        {/* 내용이 길어 스크롤될 때 안에 누를 것이 없어도 키보드(화살표)로 스크롤하게 Tab으로 닿게 함
            (BRD-39, WCAG 2.1.1). 처음 포커스는 앞의 닫기 버튼.
            Tab이 멈추는 자리라 시트 제목을 이름으로 둠(이름 없는 정지점이 되지 않게) */}
        <div
          tabIndex={0}
          role="region"
          aria-labelledby={titleId}
          className="overflow-y-auto px-gutter pt-2 lg:px-6"
        >
          {children}
        </div>
      </div>
    </dialog>
  );
}
