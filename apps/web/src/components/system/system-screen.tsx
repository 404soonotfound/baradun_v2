"use client"; // 바다 정보 상태 구독·대화상자(showModal)·포커스 이동을 쓰므로 브라우저 부품

import { RefreshCw, Wrench } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  maintenanceUntil,
  systemScreen,
  type SystemScreenKind,
} from "@/lib/system-screen";
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

  // 덮는 동안 뒤 페이지 스크롤 막기(Sheet·Onboarding과 같음)
  useEffect(() => {
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = before;
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={TITLE_ID}
      onCancel={(event) => event.preventDefault()}
      onClose={(event) => {
        const dialog = event.currentTarget;
        if (dialog.isConnected && !dialog.open) dialog.showModal();
      }}
      className="m-0 h-dvh max-h-none w-full max-w-none bg-bg-page p-0 text-text-default backdrop:bg-bg-page"
    >
      <div className="mx-auto flex min-h-full w-full max-w-[480px] flex-col justify-center gap-5 px-gutter pt-[calc(40px+env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
        {children}
      </div>
    </dialog>
  );
}

function Heading({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="flex size-[60px] items-center justify-center self-center rounded-full bg-bg-subtle text-text-muted"
      >
        {icon}
      </span>
      <h1
        id={TITLE_ID}
        tabIndex={-1}
        className="text-center text-title-xl text-text-default outline-none"
      >
        {title}
      </h1>
    </>
  );
}

// 현장 우선 문구(주요 행동 가까이, 저장소 AGENTS.md 제품 규칙)
function FinalCall() {
  const t = useTranslations("safety");
  return (
    <p className="text-center text-caption text-text-muted">{t("finalCall")}</p>
  );
}

// [2] 점검(L12): 예정 시간 · 현장 안내를 따르라는 문구 · 다시 확인
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
      <Heading icon={<Wrench size={26} />} title={t("maintenanceTitle")} />
      <div className="flex flex-col gap-1.5 text-center">
        <p className="text-body-m text-text-body">{t("maintenanceBody")}</p>
        <p className="text-body-m text-text-body">
          {until ? t("maintenanceUntil", { time: until }) : t("untilUnknown")}
        </p>
      </div>
      <p className="rounded-card bg-bg-surface px-4 py-3 text-center text-body-s text-text-default shadow-card">
        {t("fieldNotice")}
      </p>
      {/* disabled 대신 aria-disabled: 확인하는 동안에도 포커스가 버튼에 남음 */}
      <Button
        type="button"
        onClick={() => void recheck()}
        aria-disabled={checking}
        className="aria-disabled:opacity-60"
      >
        {checking ? t("rechecking") : t("recheck")}
      </Button>
      <FinalCall />
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
      <Heading icon={<RefreshCw size={26} />} title={t("updateTitle")} />
      <div className="flex flex-col gap-1.5 text-center">
        <p className="text-body-m text-text-body">{t("updateBody")}</p>
        <p className="text-body-m text-text-body">{t("updateNext")}</p>
      </div>
      <Button type="button" onClick={() => window.location.reload()}>
        {t("reload")}
      </Button>
      <FinalCall />
    </>
  );
}
