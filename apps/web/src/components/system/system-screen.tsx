"use client"; // 바다 정보 상태 구독·대화상자(showModal)·포커스 이동을 쓰므로 브라우저 부품

import { Download, RotateCw, Wrench } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { FinalCallNote } from "@/components/final-call-note";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  maintenanceUntil,
  systemScreen,
  type SystemScreenKind,
} from "@/lib/system-screen";
import { useScrollLock } from "@/lib/scroll-lock";
import {
  getSnapshotState,
  refreshSnapshot,
  useSnapshot,
} from "@/lib/snapshot/use-snapshot";

// 시스템 화면: 점검(L12)·강제 업데이트(L15) (BRD-38 · 노션 2장 SYS, 아키텍처 9.1)
// 배너 없이 어느 화면이든 전체를 덮음. 닫기 없음. 지난 값은 store가 이미 비워 두어 뒤 화면에도 남지 않음
// 덮는 동안 뒤 화면은 그대로 두고(입력 중 내용이 사라지지 않게) 브라우저 기본 <dialog>로 막음(inert·포커스 가두기)
// 점검이 끝나면 store가 다음 조회(5분마다·앱 복귀·다시 확인)에서 phase를 바꾸고 이 화면이 사라짐
// 문구는 무슨 일(제목) → 영향 → 다음 행동 순서
const TITLE_ID = "system-screen-title";

export function SystemScreen() {
  const snapshot = useSnapshot();
  const kind = systemScreen(snapshot.phase);
  if (kind === null) return null;
  return (
    <SystemDialog kind={kind}>
      {kind === "maintenance" ? (
        <MaintenanceBody
          until={maintenanceUntil(
            snapshot.manifest?.maintenance.until,
            snapshot.nowMs,
          )}
        />
      ) : (
        <UpdateBody />
      )}
    </SystemDialog>
  );
}

// [1] 덮는 틀. 첫 실행 안내(Onboarding)와 같은 방식: Esc로 닫지 않고, 브라우저가 닫아도 다시 엶
// 종류가 바뀌면(점검 → 강제 업데이트) 그 제목으로 포커스를 옮김
function SystemDialog({
  kind,
  children,
}: {
  kind: SystemScreenKind;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    document.getElementById(TITLE_ID)?.focus();
  }, [kind]);

  // 덮는 동안 뒤 페이지 스크롤 막기(Sheet·Onboarding과 잠금 수를 나눠 셈)
  useScrollLock();

  // 점검(Figma L12 187:445): 화면 바탕 위 가운데 정렬, 좌우 여백 28, 간격 14
  // 강제 업데이트(Figma L15 188:399): 불투명 dim 위 카드(좌우 24, 모서리 22, 안쪽 위 24·옆 20·아래 18, 간격 12)
  const update = kind === "update_required";
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={TITLE_ID}
      onCancel={(event) => event.preventDefault()}
      onClose={(event) => {
        const dialog = event.currentTarget;
        if (dialog.isConnected && !dialog.open) dialog.showModal();
      }}
      className={cn(
        "m-0 h-dvh max-h-none w-full max-w-none p-0 text-text-default",
        update ? "bg-dim backdrop:bg-dim" : "bg-bg-page backdrop:bg-bg-page",
      )}
    >
      <div
        className={cn(
          "mx-auto flex min-h-full w-full flex-col justify-center pt-[calc(40px+env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]",
          update ? "max-w-[390px] px-6" : "max-w-[480px] gap-3.5 px-7",
        )}
      >
        {update ? (
          <div className="flex flex-col items-center gap-3 rounded-sheet bg-bg-surface px-5 pt-6 pb-[18px]">
            {children}
          </div>
        ) : (
          children
        )}
      </div>
    </dialog>
  );
}

// 아이콘 상자 + 제목(20·굵기 700). 점검: 76·모서리 24 회색 면, 업데이트: 56·모서리 18 브랜드 약한 면
function Heading({
  icon,
  title,
  size,
}: {
  icon: ReactNode;
  title: string;
  size: "l" | "m";
}) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "flex items-center justify-center self-center",
          size === "l"
            ? "size-[76px] rounded-[24px] bg-banner-gray-icon-bg text-text-body"
            : "size-14 rounded-card bg-brand-weak text-brand-default",
        )}
      >
        {icon}
      </span>
      <h1
        id={TITLE_ID}
        tabIndex={-1}
        className="text-center text-title-l font-bold text-text-default outline-none"
      >
        {title}
      </h1>
    </>
  );
}

// [2] 점검(L12): 예정 시간 · 영향 · 현장 안내 카드 · 다시 확인(보조 버튼)
function MaintenanceBody({ until }: { until: string | null }) {
  const t = useTranslations("systemScreen");
  const [checking, setChecking] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  // 다시 조회. 점검이 끝나면 이 화면이 사라지고, 그대로면 화면 읽기에 조용히 알림
  async function recheck() {
    if (checking) return;
    setChecking(true);
    setAnnouncement("");
    try {
      await refreshSnapshot();
    } catch {
      // 결과는 아래에서 store 상태로 판단
    } finally {
      setChecking(false);
    }
    if (getSnapshotState().phase === "maintenance") {
      setAnnouncement(t("stillMaintenance"));
    }
  }

  return (
    <>
      <Heading
        size="l"
        icon={<Wrench size={34} strokeWidth={2.55} absoluteStrokeWidth />}
        title={t("maintenanceTitle")}
      />
      {/* 끝 예정 시각 → 영향 (14.5/21). 시작 시각은 받지 않아 지어내지 않음 */}
      <div className="text-center text-[14.5px]/[21px] text-text-body">
        <p>
          {until ? t("maintenanceUntil", { time: until }) : t("untilUnknown")}
        </p>
        <p>{t("maintenanceBody")}</p>
      </div>
      {/* 현장 안내 카드: 흰 면·기본 테두리·모서리 14, 13/18.9 (Figma 187:456) */}
      <p className="w-full rounded-button border border-border-default bg-bg-surface px-[15px] py-[13px] text-body-s text-text-body">
        {t("fieldNotice")}
      </p>
      {/* 다시 확인은 보조 버튼 + 새로고침 아이콘 16 (Figma 187:459).
          disabled 대신 aria-disabled: 확인하는 동안에도 포커스가 버튼에 남음 */}
      <Button
        type="button"
        variant="secondary"
        onClick={() => void recheck()}
        aria-disabled={checking}
        className="w-full gap-1.5 aria-disabled:opacity-60"
      >
        <RotateCw aria-hidden="true" size={16} />
        {checking ? t("rechecking") : t("recheck")}
      </Button>
      <FinalCallNote className="justify-center text-center" />
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </>
  );
}

// [3] 강제 업데이트(L15): 닫기 없음. 판단 로직·데이터 형식이 바뀌어 이 화면 빌드가 데이터를 읽으면 안 될 때만
// 새로고침하면 새 화면을 받음(사이트 HTML은 max-age=0, store.ts 주석)
function UpdateBody() {
  const t = useTranslations("systemScreen");
  return (
    <>
      <Heading
        size="m"
        icon={<Download size={26} strokeWidth={2.2} absoluteStrokeWidth />}
        title={t("updateTitle")}
      />
      {/* 무슨 일·영향 → 다음 행동 (14/20.3, Figma 188:408) */}
      <div className="text-center text-body text-text-body">
        <p>{t("updateBody")}</p>
        <p>{t("updateNext")}</p>
      </div>
      <Button
        type="button"
        className="w-full"
        onClick={() => window.location.reload()}
      >
        {t("reload")}
      </Button>
      <FinalCallNote className="justify-center text-center" />
    </>
  );
}
