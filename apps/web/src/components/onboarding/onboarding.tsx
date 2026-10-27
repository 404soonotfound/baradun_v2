"use client"; // 기기 기록·위치 상태·포커스 이동을 쓰므로 브라우저 부품

import {
  Check,
  CircleAlert,
  Clock,
  Info,
  MapPin,
  TriangleAlert,
  Waves,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, type ReactNode } from "react";

import { RegionSheet } from "@/components/region/region-sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { localizedPath, type Locale } from "@/lib/i18n";
import { requestLocation, useUserLocation } from "@/lib/location";
import {
  acknowledgeNotice,
  finishLocationStep,
  locationDecided,
  onboardingStep,
  useOnboarding,
  type OnboardingRecord,
} from "@/lib/onboarding";
import { setRegion, useRegion } from "@/lib/region";
import type { RegionGroup } from "@/lib/region-list";
import { useSheet } from "@/lib/use-sheet";

// 첫 실행 안내 (BRD-25 · 노션 2장 ON-1/ON-2, Figma L01 · L02)
// 주소 없이 덮는 화면. AppShell 안에 두어 어느 주소로 들어와도(공유 링크 포함) 먼저 보임
// ON-1 서비스 안내·면책 고지(건너뛰기 없음) → ON-2 위치 사전 안내
//   위치 사용하기 → 그때 브라우저 권한 창 / 지역 직접 고르기 → 권한 창 없이 지역 고르기 시트

// 단계마다 제목 id. 대화상자 이름(aria-labelledby)과 포커스 이동에 씀
const TITLE_IDS = {
  notice: "onboarding-notice-title",
  location: "onboarding-location-title",
} as const;

// Vue: props: { locale, groups }
export function Onboarding({
  locale,
  groups,
}: {
  locale: Locale;
  groups: readonly RegionGroup[]; // 지역 고르기 시트용(AppShell이 빌드 때 만듦)
}) {
  const record = useOnboarding();
  const region = useRegion();
  const pathname = usePathname();
  const regionSheet = useSheet("onboarding-region");

  // [1] '자세히 보기'로 간 안전·데이터 안내 위에는 덮지 않음. 다른 화면으로 가면 다시 덮음
  // trailingSlash 설정이라 끝의 /를 떼고 비교
  const onGuide =
    pathname.replace(/\/+$/, "") === localizedPath(locale, "/guide");
  // [2] 기기 기록을 읽기 전(undefined, 서버 HTML·첫 그리기)에는 덮지 않음
  // 위치 권한 상태는 ON-2가 남은 기기만 LocationGate에서 확인(다른 기기는 화면마다 위치를 받지 않게).
  // 여기서는 권한을 아직 묻지 않은 것으로 보고 단계만 정함
  const step =
    record === undefined || onGuide ? null : onboardingStep(record, "idle");

  return (
    <>
      {step === "notice" && (
        <OnboardingDialog step="notice">
          <NoticeStep locale={locale} />
        </OnboardingDialog>
      )}
      {step === "location" && record && (
        <LocationGate
          record={record}
          onPick={() => {
            finishLocationStep();
            regionSheet.show(); // 권한 창 없이 지역 고르기
          }}
        />
      )}
      <RegionSheet
        open={regionSheet.open}
        onClose={regionSheet.close}
        groups={groups}
        value={region}
        onSelect={(next) => {
          setRegion(next); // 기기에 기본 지역으로 저장
          regionSheet.close();
        }}
      />
    </>
  );
}

// ON-2를 아직 안 지난 기기. 권한 확인이 끝날 때까지 덮지 않음
// 이미 정한 기기(허용·거부)는 ON-2를 지난 것으로 저장해 다음에 열 때 권한을 확인하지 않음
function LocationGate({
  record,
  onPick,
}: {
  record: OnboardingRecord;
  onPick: () => void;
}) {
  const location = useUserLocation();
  const decided = locationDecided(location.status);

  // Vue: watch(decided)
  useEffect(() => {
    if (decided) finishLocationStep();
  }, [decided]);

  if (onboardingStep(record, location.status) !== "location") return null;
  return (
    <OnboardingDialog step="location">
      <LocationStep
        onUse={() => {
          finishLocationStep();
          requestLocation(); // 여기서 처음으로 브라우저가 위치를 물음
        }}
        onPick={onPick}
      />
    </OnboardingDialog>
  );
}

// [3] 덮는 틀. 브라우저 기본 <dialog>의 showModal(): 뒤 화면을 막고(inert) 포커스를 안에 가둠
// 열리면 그 단계 제목으로 포커스(화면 읽기가 고지를 처음부터 읽음. 첫 버튼으로 바로 가면 고지를 건너뛰고 읽게 됨)
function OnboardingDialog({
  step,
  children,
}: {
  step: "notice" | "location";
  children: ReactNode;
}) {
  const t = useTranslations("onboarding");
  // Vue: ref="dialog" → this.$refs.dialog
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = TITLE_IDS[step];

  // Vue: mounted + watch(step)
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    document.getElementById(titleId)?.focus();
  }, [titleId]);

  // 덮는 동안 뒤 페이지 스크롤 막기(Sheet와 같음)
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
      aria-labelledby={titleId}
      // Esc로 닫지 않음(건너뛰기 없음)
      onCancel={(event) => event.preventDefault()}
      // 브라우저가 그래도 닫으면(Esc를 빠르게 두 번 등) 다시 엶. 화면에서 빠진 뒤에는 열지 않음
      onClose={(event) => {
        const dialog = event.currentTarget;
        if (dialog.isConnected && !dialog.open) dialog.showModal();
      }}
      className="m-0 h-dvh max-h-none w-full max-w-none bg-bg-page p-0 text-text-default backdrop:bg-bg-page"
    >
      <div className="mx-auto flex min-h-full w-full max-w-[480px] flex-col px-gutter pt-[calc(56px+env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
        {children}
        {/* 단계 점 2개. 화면 읽기에는 글자로 */}
        <p className="sr-only">
          {t("step", { current: step === "notice" ? 1 : 2, total: 2 })}
        </p>
        <span aria-hidden="true" className="mt-6 flex justify-center gap-1.5">
          <StepDot active={step === "notice"} />
          <StepDot active={step === "location"} />
        </span>
      </div>
    </dialog>
  );
}

function StepDot({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "h-1.5 rounded-full",
        active ? "w-5 bg-brand-default" : "w-1.5 bg-border-strong",
      )}
    />
  );
}

// [4] ON-1 서비스 안내·면책 고지. 확인하는 두 가지(특보·측정 시각) → 확인하지 않는 것(출입 통제) → 면책
function NoticeStep({ locale }: { locale: Locale }) {
  const t = useTranslations();
  return (
    <div className="flex flex-1 flex-col gap-5">
      <span
        aria-hidden="true"
        className="flex size-12 items-center justify-center self-center rounded-icon bg-brand-default text-brand-on"
      >
        <Waves size={26} />
      </span>
      <div className="flex flex-col gap-2">
        <h2
          id={TITLE_IDS.notice}
          tabIndex={-1}
          className="text-title-xl text-text-default outline-none"
        >
          {t("onboarding.notice.title1")}
          <br />
          {t("onboarding.notice.title2")}
        </h2>
        <p className="text-body-s text-text-body">
          {t("onboarding.notice.intro")}
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-border-default rounded-card bg-bg-surface shadow-card">
        <InfoRow
          icon={<TriangleAlert size={18} />}
          title={t("onboarding.notice.warning")}
          body={t("onboarding.notice.warningBody")}
        />
        <InfoRow
          icon={<Clock size={18} />}
          title={t("onboarding.notice.measured")}
          body={t("onboarding.notice.measuredBody")}
        />
        <InfoRow
          icon={<Info size={18} />}
          title={t("onboarding.notice.control")}
          body={t("onboarding.notice.controlBody")}
        />
      </ul>
      {/* 면책 고지(앰버). 색만으로 구분하지 않게 아이콘 + 글자 */}
      <p className="flex gap-2.5 rounded-input border border-banner-amber-border bg-bg-surface p-3.5 text-body-s text-text-default">
        <CircleAlert
          aria-hidden="true"
          size={18}
          className="mt-0.5 shrink-0 text-banner-amber-icon-fg"
        />
        <span>
          {t("onboarding.notice.disclaimer")} {t("safety.finalCall")}
        </span>
      </p>
      <div className="mt-auto flex flex-col items-center gap-2 pt-4">
        <Button className="w-full" onClick={acknowledgeNotice}>
          {t("onboarding.notice.confirm")}
        </Button>
        <Link
          href={localizedPath(locale, "/guide/")}
          className="inline-flex min-h-touch items-center text-body-s font-bold text-brand-default"
        >
          {t("onboarding.notice.more")}
        </Link>
      </div>
    </div>
  );
}

// 안내 한 줄: 아이콘 상자 + 제목 + 설명
function InfoRow({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <li className="flex items-start gap-3 p-4">
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-icon bg-brand-weak text-brand-default"
      >
        {icon}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-body-s font-bold text-text-default">{title}</span>
        <span className="text-caption text-text-body">{body}</span>
      </span>
    </li>
  );
}

// [5] ON-2 위치 사전 안내. 버튼 둘 중 하나를 눌러야 지나감
function LocationStep({
  onUse,
  onPick,
}: {
  onUse: () => void;
  onPick: () => void;
}) {
  const t = useTranslations("onboarding.location");
  return (
    <div className="flex flex-1 flex-col gap-5">
      <span
        aria-hidden="true"
        className="flex size-[72px] items-center justify-center rounded-card bg-brand-weak text-brand-default"
      >
        <MapPin size={30} />
      </span>
      <div className="flex flex-col gap-2">
        <h2
          id={TITLE_IDS.location}
          tabIndex={-1}
          className="text-title-xl text-text-default outline-none"
        >
          {t("title1")}
          <br />
          {t("title2")}
        </h2>
        <p className="text-body-s text-text-body">{t("body")}</p>
      </div>
      <ul className="flex flex-col divide-y divide-border-default rounded-card bg-bg-surface shadow-card">
        <PromiseRow text={t("promise1")} />
        <PromiseRow text={t("promise2")} />
        <PromiseRow text={t("promise3")} />
      </ul>
      <div className="mt-auto flex flex-col gap-3 pt-4">
        <Button className="w-full" onClick={onUse}>
          <MapPin aria-hidden="true" size={18} />
          {t("use")}
        </Button>
        <Button variant="secondary" className="w-full" onClick={onPick}>
          {t("pick")}
        </Button>
      </div>
    </div>
  );
}

function PromiseRow({ text }: { text: string }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3 text-body-s text-text-default">
      <Check
        aria-hidden="true"
        size={18}
        className="shrink-0 text-brand-default"
      />
      {text}
    </li>
  );
}
