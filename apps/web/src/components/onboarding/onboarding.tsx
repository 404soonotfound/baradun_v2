"use client"; // 기기 기록·위치 상태·포커스 이동을 쓰므로 브라우저 부품

import {
  Check,
  CircleAlert,
  Clock,
  Info,
  MapPin,
  TriangleAlert,
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
  showsResetNotice,
  useOnboarding,
  type OnboardingRecord,
} from "@/lib/onboarding";
import { setRegion, useRegionChoice } from "@/lib/region";
import { NATIONWIDE, type RegionGroup } from "@/lib/region-list";
import { useScrollLock } from "@/lib/scroll-lock";
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
// 기기 데이터 초기화 직후 ON-1 맨 위 결과 줄. 있으면 제목보다 먼저 포커스(화면 읽기가 결과부터 읽음)
const RESET_NOTICE_ID = "onboarding-reset-notice";

// Vue: props: { locale, groups }
export function Onboarding({
  locale,
  groups,
}: {
  locale: Locale;
  groups: readonly RegionGroup[]; // 지역 고르기 시트용(AppShell이 빌드 때 만듦)
}) {
  const record = useOnboarding();
  const choice = useRegionChoice();
  const region = choice === NATIONWIDE ? null : choice;
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
        // '전국'도 기본 지역처럼 저장(BRD-127). 위치를 켜도 홈은 전국
        nationwide={{
          selected: choice === NATIONWIDE,
          onSelect: () => {
            setRegion(NATIONWIDE);
            regionSheet.close();
          },
        }}
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
          // 전에 고른 지역이 있으면 지움 → 홈이 가까운 바다로 돌아감(홈 '내 주변'과 같음)
          setRegion(null);
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
    (
      document.getElementById(RESET_NOTICE_ID) ??
      document.getElementById(titleId)
    )?.focus();
  }, [titleId]);

  // 덮는 동안 뒤 페이지 스크롤 막기(Sheet·SystemDialog와 잠금 수를 나눠 셈)
  useScrollLock();

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
      {/* 좌우 16 (Figma pad.stack 185:265). ON-1은 맨 위 그림이 화면 끝까지, ON-2는 위 76(머리 줄 자리) + 24 띄움 */}
      <div
        className={cn(
          "mx-auto flex min-h-full w-full max-w-[480px] flex-col px-4",
          // ON-2 아래 32 = 사이 18 + 빈 자리 14 (Figma 185:368)
          step === "location"
            ? "pt-[calc(100px+env(safe-area-inset-top))] pb-[max(32px,env(safe-area-inset-bottom))]"
            : "pb-[max(14px,env(safe-area-inset-bottom))]",
        )}
      >
        {children}
        {/* 단계. 점은 각 단계의 버튼 바로 위(StepDots), 화면 읽기에는 글자로 */}
        <p className="sr-only">
          {t("step", { current: step === "notice" ? 1 : 2, total: 2 })}
        </p>
      </div>
    </dialog>
  );
}

// 단계 점 2개: 지금 단계 18×6 브랜드, 다른 단계 6×6 (Figma 185:300, 모서리 3·사이 6)
function StepDots({ current }: { current: 1 | 2 }) {
  return (
    <span aria-hidden="true" className="flex justify-center gap-1.5">
      {[1, 2].map((index) => (
        <span
          key={index}
          className={cn(
            "h-1.5 rounded-[3px]",
            index === current
              ? "w-[18px] bg-brand-default"
              : "w-1.5 bg-onboarding-dot",
          )}
        />
      ))}
    </span>
  );
}

// ON-1 맨 위 그림 (Figma 그림 185:257, 390×190): 하늘 그라데이션 + 물결 3겹(맨 앞은 화면 바탕과 이음) + 가운데 로고 48
// 물결 경로는 Figma 원본 그대로. 색은 토큰(color.onboarding.*)이라 다크에서 밤바다로 바뀜. 꾸밈이라 화면 읽기에서 숨김
function NoticeSky() {
  return (
    <div
      aria-hidden="true"
      className="relative -mx-4 h-[190px] shrink-0 bg-linear-to-b from-onboarding-sky-1 to-onboarding-sky-2"
    >
      <svg
        className="absolute inset-0 size-full"
        viewBox="0 0 390 190"
        preserveAspectRatio="none"
      >
        <path
          d="M0 120C60 104 110 104 170 118C230 132 300 134 390 112V190H0V120Z"
          className="fill-onboarding-wave-1"
        />
        <path
          d="M0 142C80 126 150 128 230 142C310 156 340 152 390 138V190H0V142Z"
          className="fill-onboarding-wave-2"
        />
        <path
          d="M0 164C90 152 190 156 280 166C370 176 370 170 390 162V190H0V164Z"
          className="fill-bg-page"
        />
      </svg>
      <span className="absolute top-[52px] left-1/2 flex size-12 -translate-x-1/2 items-center justify-center rounded-[14px] bg-brand-default text-brand-on">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <path
            d="M10 26C14 21 17 21 21 26C25 31 28 31 32 26C36 21 38 22 39 24"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      </span>
    </div>
  );
}

// [4] ON-1 서비스 안내·면책 고지. 확인하는 두 가지(특보·측정 시각) → 확인하지 않는 것(출입 통제) → 면책
function NoticeStep({ locale }: { locale: Locale }) {
  const t = useTranslations();
  // 블록 사이 18, 제목·소개 사이 8 (Figma 185:265·185:266)
  return (
    <div className="flex flex-1 flex-col gap-[18px]">
      <NoticeSky />
      {showsResetNotice() && (
        <p
          id={RESET_NOTICE_ID}
          tabIndex={-1}
          className="flex items-center gap-2 rounded-card bg-bg-surface p-3.5 text-body-s font-bold text-text-default shadow-card outline-none"
        >
          <Check
            aria-hidden="true"
            size={18}
            className="shrink-0 text-brand-default"
          />
          {t("settings.reset.done")}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <h2
          id={TITLE_IDS.notice}
          tabIndex={-1}
          className="text-title-home text-text-default outline-none"
        >
          {t("onboarding.notice.title1")}
          <br />
          {t("onboarding.notice.title2")}
        </h2>
        <p className="text-[14.5px]/[21px] text-text-body">
          {t("onboarding.notice.intro")}
        </p>
      </div>
      <ul className={CARD_CLASS}>
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
      {/* 면책 고지(앰버 면·테두리, 모서리 14, 13/18.9, Figma 185:294). 색만으로 구분하지 않게 아이콘 + 글자 */}
      <p className="flex gap-2.5 rounded-button border border-banner-amber-border bg-banner-amber-icon-bg px-[15px] py-[13px] text-body-s text-banner-amber-text">
        <CircleAlert
          aria-hidden="true"
          size={18}
          className="shrink-0 text-banner-amber-icon-fg"
        />
        <span>
          {t("onboarding.notice.disclaimer")} {t("safety.finalCall")}
        </span>
      </p>
      {/* 남는 높이는 버튼 위로 몰아 점·버튼·링크가 화면 아래에 붙음 */}
      <div className="mt-auto flex flex-col gap-[18px]">
        <StepDots current={1} />
        <div className="flex flex-col items-center">
          <Button className="w-full" onClick={acknowledgeNotice}>
            {t("onboarding.notice.confirm")}
          </Button>
          {/* 링크 글자 14/20.3 굵게, 누르는 영역 44 (Figma 185:305) */}
          <Link
            href={localizedPath(locale, "/guide/")}
            className="mt-[9px] inline-flex min-h-touch items-center text-body font-bold text-brand-default"
          >
            {t("onboarding.notice.more")}
          </Link>
        </div>
      </div>
    </div>
  );
}

// 안내 묶음 카드: 흰 면·기본 테두리·모서리 16, 행 사이 옅은 구분선 (Figma card.stack 185:269)
const CARD_CLASS =
  "flex flex-col divide-y divide-border-subtle rounded-tile border border-border-default bg-bg-surface";

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
    // 행: 좌우 16·위아래 14, 아이콘 상자 36·모서리 11(보조 면 + 브랜드 아이콘 18), 제목 14.5/21 · 설명 12.5/18.1 (Figma 185:270)
    <li className="flex items-center gap-3 px-4 py-3.5">
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-bg-subtle text-brand-default"
      >
        {icon}
      </span>
      <span className="flex flex-col gap-px">
        <span className="text-[14.5px]/[21px] font-bold text-text-default">
          {title}
        </span>
        <span className="text-label-s text-text-muted">{body}</span>
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
  // 아이콘 상자 72·모서리 22(브랜드 약한 면 + 위치 아이콘 34), 블록 사이 18 (Figma 185:333)
  return (
    <div className="flex flex-1 flex-col gap-[18px]">
      <span
        aria-hidden="true"
        className="flex size-[72px] items-center justify-center rounded-sheet bg-brand-weak text-brand-default"
      >
        <MapPin size={34} strokeWidth={2.55} absoluteStrokeWidth />
      </span>
      <div className="flex flex-col gap-2">
        <h2
          id={TITLE_IDS.location}
          tabIndex={-1}
          className="text-title-home text-text-default outline-none"
        >
          {t("title1")}
          <br />
          {t("title2")}
        </h2>
        <p className="text-[14.5px]/[21px] text-text-body">{t("body")}</p>
      </div>
      <ul className={CARD_CLASS}>
        <PromiseRow text={t("promise1")} />
        <PromiseRow text={t("promise2")} />
        <PromiseRow text={t("promise3")} />
      </ul>
      {/* 점 → 위치 사용하기(주요) → 지역 직접 고르기, 사이 18 (Figma 185:356~185:366) */}
      <div className="mt-auto flex flex-col gap-[18px]">
        <StepDots current={2} />
        <Button className="w-full gap-1.5" onClick={onUse}>
          <MapPin aria-hidden="true" size={16} />
          {t("use")}
        </Button>
        <Button variant="secondary" className="w-full" onClick={onPick}>
          {t("pick")}
        </Button>
      </div>
    </div>
  );
}

// 약속 한 줄: 체크 18(브랜드) + 14/20.3, 좌우 16·위아래 12 (Figma 185:343)
function PromiseRow({ text }: { text: string }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3 text-body text-text-default">
      <Check
        aria-hidden="true"
        size={18}
        strokeWidth={2.5}
        className="shrink-0 text-brand-default"
      />
      {text}
    </li>
  );
}
