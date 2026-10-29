"use client"; // 기기 저장(스위치·테마·기본 지역)과 위치 상태를 쓰므로 브라우저 부품

import { ChevronRight, Trash2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useMemo, type ReactNode } from "react";

import { RegionSheet } from "@/components/region/region-sheet";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { resetDeviceData } from "@/lib/device-reset";
import { LOCALE_NAMES, LOCALES, localizedPath, type Locale } from "@/lib/i18n";
import { setLanguageChoice } from "@/lib/language-choice";
import {
  requestLocation,
  setLocationEnabled,
  useUserLocation,
} from "@/lib/location";
import { setMotionEnabled, useMotionSwitch } from "@/lib/motion";
import { setRegion, useRegionChoice } from "@/lib/region";
import type { BeachSummary } from "@/lib/beach-summary";
import {
  NATIONWIDE,
  regionGroups,
  regionName,
  savedScope,
} from "@/lib/region-list";
import { setTheme, THEMES, useTheme } from "@/lib/theme";
import { useSheet } from "@/lib/use-sheet";

// 설정 (BRD-36 · 노션 2장 SET·D-SET, 결정 기록 11장 10/27 ⑩·⑫)
// 묶음: 위치(위치 사용 스위치·브라우저 권한·기본 지역) · 화면(테마·언어·화면 움직임) · 도움·문의 · 정보(약관·출처·기기 데이터)
// 로그인은 출시 제외(D1)라 자리도 두지 않음. PC(lg)는 왼쪽 목록 260px + 오른쪽 내용
// 위치 스위치를 끄면 위치를 묻지도 쓰지도 않음(ON-2 '설정에서 끌 수 있어요' 약속, lib/location.ts)

const GROUPS = ["location", "display", "help", "info"] as const;
type GroupKey = (typeof GROUPS)[number];

export function SettingsScreen({
  locale,
  beaches,
}: {
  locale: Locale;
  beaches: BeachSummary[]; // 기본 지역 시트·지역 확인용(빌드 때 넘김)
}) {
  const t = useTranslations("settings");
  const tp = useTranslations("pages");
  const resetSheet = useSheet("device-reset");

  function confirmReset() {
    resetDeviceData();
    // 지운 결과는 바로 덮는 첫 실행 안내(ON-1) 맨 위에 보여 줌(lib/onboarding.ts showsResetNotice)
    resetSheet.close();
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-title-xl text-text-default">{tp("settings")}</h1>

      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start lg:gap-8">
        {/* PC 왼쪽 목록: 묶음으로 건너뛰기. 모바일은 한 줄로 이어져 있어 숨김(같은 내용에 스크롤로 도달) */}
        <nav
          aria-label={t("groupsLabel")}
          className="hidden lg:sticky lg:top-24 lg:block"
        >
          <ul className="flex flex-col gap-1 rounded-card bg-bg-surface p-2 shadow-card">
            {GROUPS.map((key) => (
              <li key={key}>
                <a
                  href={`#settings-${key}`}
                  className="flex min-h-touch items-center rounded-button px-3 text-body-s font-bold text-text-default hover:bg-bg-subtle"
                >
                  {t(`${key}.title`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex flex-col gap-5">
          <LocationGroup beaches={beaches} />
          <DisplayGroup locale={locale} />

          <Group id="help">
            <LinkRow
              href={localizedPath(locale, "/guide/")}
              title={tp("guide")}
              body={t("help.guideBody")}
            />
            <LinkRow
              href={localizedPath(locale, "/settings/inquiry/")}
              title={tp("inquiry")}
              body={t("help.inquiryBody")}
            />
          </Group>

          <Group id="info">
            <LinkRow
              href={localizedPath(locale, "/terms/")}
              title={tp("terms")}
              body={t("info.termsBody")}
            />
            <LinkRow
              href={localizedPath(locale, "/about/data/")}
              title={tp("dataSources")}
              body={t("info.dataSourcesBody")}
            />
            <Row>
              <p className="text-body-s font-bold text-text-default">
                {t("info.device")}
              </p>
              <p className="text-caption text-text-body">
                {t("info.deviceBody")}
              </p>
              <Button
                variant="secondary"
                onClick={resetSheet.show}
                className="mt-2 self-start"
              >
                <Trash2 aria-hidden="true" size={18} />
                {t("info.reset")}
              </Button>
            </Row>
          </Group>
        </div>
      </div>

      {/* 초기화 확인. 되돌릴 수 없어 한 번 더 묻고, 무엇을 지우고 무엇을 남기는지 먼저 알림 */}
      <Sheet
        open={resetSheet.open}
        onClose={resetSheet.close}
        title={t("reset.title")}
      >
        <div className="flex flex-col gap-3 pb-2">
          <p className="text-body-s text-text-default">{t("reset.body")}</p>
          <p className="text-body-s text-text-body">{t("reset.keep")}</p>
          <p className="text-body-s text-text-body">{t("reset.permission")}</p>
          <div className="mt-2 flex flex-col gap-2 lg:flex-row-reverse">
            <Button onClick={confirmReset}>{t("reset.confirm")}</Button>
            <Button variant="secondary" onClick={resetSheet.close}>
              {t("reset.cancel")}
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

// 위치 묶음: 스위치 → 브라우저 권한 상태 → 기본 지역
function LocationGroup({ beaches }: { beaches: BeachSummary[] }) {
  const t = useTranslations("settings.location");
  const location = useUserLocation();
  const choice = useRegionChoice();
  const regionSheet = useSheet("settings-region");
  const switchId = useId();
  const switchBodyId = useId();
  const groups = useMemo(() => regionGroups(beaches), [beaches]);
  const status = location.status;
  // 꺼짐(off)만 스위치 꺼짐. 서버 HTML·권한 확인 중에는 켜짐으로 그렸다가 저장값을 읽으면 바뀜
  const enabled = status !== "off";
  // 저장값 → 기본 지역(savedScope). 지금 해변 목록에 없는 지역이면 고르지 않은 것으로 봄(홈과 같은 규칙)
  // 고른 전국·저장값 없음은 '전국'(BRD-127 · 10/29 사용자 결정)
  const scope = savedScope(choice, beaches);
  const shown = scope.kind === "region" ? scope.region : null;
  const name =
    (shown === null ? null : regionName(groups, shown)) ??
    t("regionNationwide");
  // 지울 저장값이 있을 때만 '기본 지역 지우기'(고른 지역·고른 전국)
  const saved = scope.kind === "region" || scope.chosen;

  return (
    <Group id="location">
      <Row>
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <p
              id={switchId}
              className="text-body-s font-bold text-text-default"
            >
              {t("switch")}
            </p>
            <p id={switchBodyId} className="text-caption text-text-body">
              {enabled ? t("onBody") : t("offBody")}
            </p>
          </div>
          <Switch
            checked={enabled}
            onChange={setLocationEnabled}
            labelledBy={switchId}
            describedBy={switchBodyId}
          />
        </div>
      </Row>

      <Row>
        <p className="text-body-s font-bold text-text-default">
          {t("permission")}
        </p>
        {/* 상태가 바뀌면 화면 읽기에 알림(허용·거부 결과) */}
        <p role="status" className="text-body-s text-text-body">
          {t(`state.${status}`)}
        </p>
        {status === "idle" && (
          <>
            <p className="text-caption text-text-muted">{t("idleHint")}</p>
            <Button
              variant="secondary"
              onClick={requestLocation}
              className="mt-2 self-start"
            >
              {t("use")}
            </Button>
          </>
        )}
        {status === "denied" && (
          <p className="text-caption text-text-muted">{t("deniedHint")}</p>
        )}
        {status === "unavailable" && (
          <>
            <p className="text-caption text-text-muted">
              {t("unavailableHint")}
            </p>
            <Button
              variant="secondary"
              onClick={requestLocation}
              className="mt-2 self-start"
            >
              {t("retry")}
            </Button>
          </>
        )}
      </Row>

      <Row>
        <p className="text-body-s font-bold text-text-default">{t("region")}</p>
        <p className="text-body-s text-text-body">{name}</p>
        <p className="text-caption text-text-muted">{t("regionHint")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={regionSheet.show}>
            {t("regionChange")}
          </Button>
          {saved && (
            <Button variant="ghost" onClick={() => setRegion(null)}>
              {t("regionClear")}
            </Button>
          )}
        </div>
      </Row>

      <RegionSheet
        open={regionSheet.open}
        onClose={regionSheet.close}
        groups={groups}
        value={shown}
        nationwide={{
          selected: scope.kind === "nationwide",
          onSelect: () => {
            setRegion(NATIONWIDE);
            regionSheet.close();
          },
        }}
        onSelect={(next) => {
          setRegion(next);
          regionSheet.close();
        }}
      />
    </Group>
  );
}

// 화면 묶음: 테마(기기 설정·밝게·어둡게) · 언어(한국어·English) · 화면 움직임
function DisplayGroup({ locale }: { locale: Locale }) {
  const t = useTranslations("settings.display");
  const theme = useTheme();
  const motion = useMotionSwitch();
  const motionId = useId();
  const motionBodyId = useId();

  return (
    <Group id="display">
      <Row>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-body-s font-bold text-text-default">
            {t("theme")}
          </legend>
          <div className="grid grid-cols-3 gap-2">
            {THEMES.map((value) => (
              <label
                key={value}
                className={cn(
                  "flex min-h-touch cursor-pointer items-center justify-center gap-1.5 rounded-button border px-2 text-center text-body-s has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-default",
                  theme === value
                    ? "border-brand-default bg-brand-weak font-bold text-text-default"
                    : "border-border-default text-text-body",
                )}
              >
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  checked={theme === value}
                  onChange={() => setTheme(value)}
                  className="sr-only"
                />
                {t(`themeOption.${value}`)}
              </label>
            ))}
          </div>
        </fieldset>
      </Row>

      <Row>
        <p className="text-body-s font-bold text-text-default">
          {t("language")}
        </p>
        {/* 언어마다 주소가 따로라(/, /en) 링크로 바꿈. 기기 언어로 자동 이동하지 않음(10장) */}
        <ul className="mt-2 grid grid-cols-2 gap-2">
          {LOCALES.map((value) => (
            <li key={value}>
              <Link
                href={localizedPath(value, "/settings/")}
                hrefLang={value}
                lang={value}
                // 고른 언어를 기기에 저장해 첫 방문 언어 안내를 다시 띄우지 않음(BRD-48)
                onClick={() => setLanguageChoice(value)}
                aria-current={value === locale ? "true" : undefined}
                className={cn(
                  "flex min-h-touch items-center justify-center rounded-button border px-2 text-body-s",
                  value === locale
                    ? "border-brand-default bg-brand-weak font-bold text-text-default"
                    : "border-border-default text-text-body",
                )}
              >
                {LOCALE_NAMES[value]}
              </Link>
            </li>
          ))}
        </ul>
      </Row>

      <Row>
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <p
              id={motionId}
              className="text-body-s font-bold text-text-default"
            >
              {t("motion")}
            </p>
            <p id={motionBodyId} className="text-caption text-text-body">
              {t("motionBody")}
            </p>
          </div>
          <Switch
            checked={motion}
            onChange={setMotionEnabled}
            labelledBy={motionId}
            describedBy={motionBodyId}
          />
        </div>
      </Row>
    </Group>
  );
}

// 묶음 카드. 제목은 h2, PC 왼쪽 목록이 #settings-<묶음>으로 건너뜀
function Group({ id, children }: { id: GroupKey; children: ReactNode }) {
  const t = useTranslations("settings");
  const headingId = `settings-${id}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2
        id={headingId}
        tabIndex={-1}
        className="scroll-mt-24 text-title-s text-text-muted outline-none"
      >
        {t(`${id}.title`)}
      </h2>
      <div className="flex flex-col divide-y divide-border-default overflow-hidden rounded-card bg-bg-surface shadow-card">
        {children}
      </div>
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-0.5 px-4 py-3">{children}</div>;
}

function LinkRow({
  href,
  title,
  body,
}: {
  href: string;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="flex min-h-touch items-center gap-3 px-4 py-3 hover:bg-bg-subtle"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body-s font-bold text-text-default">{title}</span>
        <span className="text-caption text-text-body">{body}</span>
      </span>
      <ChevronRight
        aria-hidden="true"
        size={16}
        className="shrink-0 text-text-muted"
      />
    </Link>
  );
}
