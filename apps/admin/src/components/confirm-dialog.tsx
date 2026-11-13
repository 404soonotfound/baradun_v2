"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./ui";

// 공통 확인 창(V30, 화면 설계서 6장 ADM-CONFIRM): 제목 → 영향 → 되돌리는 법. 취소에 먼저 포커스. 모바일은 아래 시트(하단 안전 영역만큼 띄움)
export function ConfirmDialog({
  titleId,
  title,
  children,
  confirmLabel,
  cancelLabel,
  confirmDisabled,
  busy,
  onConfirm,
  onClose,
}: {
  titleId: string;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  confirmDisabled: boolean;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // 열면 취소 버튼에 포커스(V30 '취소에 먼저 포커스'). showModal이 첫 입력 칸으로 옮긴 포커스를 다시 가져옴
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    el?.querySelector<HTMLButtonElement>("[data-cancel]")?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      className="fixed inset-x-0 bottom-0 m-0 mt-auto w-full max-w-none rounded-t-admin-box border border-border-default bg-bg-surface p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] text-text-default shadow-floating backdrop:bg-black/40 sm:inset-0 sm:m-auto sm:max-w-[480px] sm:rounded-admin-box sm:pb-5"
    >
      <h2 id={titleId} className="text-title-m font-semibold">
        {title}
      </h2>
      <div className="mt-2 flex flex-col gap-2 text-body-s text-text-body">
        {children}
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button
          data-cancel=""
          variant="secondary"
          size="small"
          disabled={busy}
          onClick={() => ref.current?.close()}
        >
          {cancelLabel}
        </Button>
        <Button
          size="small"
          disabled={confirmDisabled || busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
