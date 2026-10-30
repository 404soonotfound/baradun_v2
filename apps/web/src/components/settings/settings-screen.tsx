"use client"; // 기기 저장(스위치·테마·기본 지역)과 위치 상태를 쓰므로 브라우저 부품

import {
  Check,
  ChevronRight,
  Database,
  FileText,
  Languages,
  Mail,
  Map as MapIcon,
  MapPin,
  Moon,
  Navigation,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState, type ReactNode } from "react";

import { WaveIcon } from "@/components/logo-mark";
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

// 설정 (BRD-36 · 노션 2장 SET·D-SET, 결정 기록 11장 10/27 ⑩·⑫, Figma S_M06_01 179:159 · S_D10_02 184:1061)
// 묶음: 위치(위치 사용 스위치·브라우저 권한·기본 지역) · 화면(테마·언어·화면 움직임) · 도움·문의 · 정보(약관·출처·기기 데이터)
// 줄은 아이콘 칸 32px + 이름 + 값·› 또는 스위치(Figma set). 테마·언어는 줄을 누르면 시트에서 고름
// 로그인·오류 제보는 Figma에 자리가 있지만 노션 SET(로그인 출시 제외 D1, 오류 제보는 데이터 문의로 합침)을 따라 두지 않음
// PC(lg)는 왼쪽 목록 260px + 오른쪽에 고른 묶음 하나(위치·화면·기기 데이터). 안내·문의·약관·출처는 왼쪽 목록에서 바로 이동
// 위치 스위치를 끄면 위치를 묻지도 쓰지도 않음(ON-2 '설정에서 끌 수 있어요' 약속, lib/location.ts)

type Panel = "location" | "display" | "device";

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
  const [panel, setPanel] = useState<Panel>("location");

  function confirmReset() {
    resetDeviceData();
    // 지운 결과는 바로 덮는 첫 실행 안내(ON-1) 맨 위에 보여 줌(lib/onboarding.ts showsResetNotice)
    resetSheet.close();
  }

  // PC 왼쪽 목록: 묶음을 바꾸면 그 제목으로 포커스(화면 읽기가 바뀐 내용을 읽음)
  function show(next: Panel) {
    setPanel(next);
    // 숨김(display:none)이 풀린 다음 프레임에 포커스
    requestAnimationFrame(() =>
      document.getElementById(`settings-${next}`)?.focus(),
    );
  }
  // 모바일은 묶음을 모두 잇고, PC는 고른 묶음만
  const pcOnly = (key: Panel) => panel !== key && "lg:hidden";

  const navItem =
    "flex min-h-touch w-full items-center rounded-[10px] px-3 text-left text-body text-text-default hover:bg-bg-subtle";
  const navLinks = [
    { href: "/guide/", label: tp("guide") },
    { href: "/settings/inquiry/", label: tp("inquiry") },
    { href: "/terms/", label: tp("terms") },
    { href: "/about/data/", label: tp("dataSources") },
  ];

  return (
    <div className="flex flex-col gap-[18px] pt-4 lg:mx-auto lg:w-full lg:max-w-[1036px] lg:pt-0">
      <h1 className="text-title-xl text-text-default lg:sr-only">
        {tp("settings")}
      </h1>

      <div className="flex flex-col gap-[18px] lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start lg:gap-8">
        {/* PC 왼쪽 목록(Figma 184:1102). 모바일은 묶음이 한 줄로 이어져 있어 숨김(같은 내용에 스크롤로 도달) */}
        <nav
          aria-label={t("groupsLabel")}
          className="hidden lg:sticky lg:top-24 lg:block"
        >
          <ul className="flex flex-col rounded-card bg-bg-surface p-2 shadow-card">
            {(["location", "display"] as const).map((key) => (
              <li key={key}>
                <PanelButton
                  current={panel === key}
                  onClick={() => show(key)}
                  className={navItem}
                >
                  {t(`${key}.title`)}
                </PanelButton>
              </li>
            ))}
            {navLinks.map((item) => (
              <li key={item.href}>
                <Link
                  href={localizedPath(locale, item.href)}
                  className={navItem}
                >
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              <PanelButton
                current={panel === "device"}
                onClick={() => show("device")}
                className={navItem}
              >
                {t("info.device")}
              </PanelButton>
            </li>
          </ul>
        </nav>

        <div className="flex flex-col gap-[18px]">
          <LocationGroup beaches={beaches} className={cn(pcOnly("location"))} />
          <DisplayGroup locale={locale} className={cn(pcOnly("display"))} />

          <Group id="help" title={t("help.title")} className="lg:hidden">
            <SettingRow
              icon={<ShieldCheck size={16} />}
              label={tp("guide")}
              href={localizedPath(locale, "/guide/")}
            />
            <SettingRow
              icon={<Mail size={16} />}
              label={tp("inquiry")}
              href={localizedPath(locale, "/settings/inquiry/")}
            />
          </Group>

          <Group id="info" title={t("info.title")} className="lg:hidden">
            <SettingRow
              icon={<FileText size={16} />}
              label={tp("terms")}
              href={localizedPath(locale, "/terms/")}
            />
            <SettingRow
              icon={<Database size={16} />}
              label={tp("dataSources")}
              href={localizedPath(locale, "/about/data/")}
            />
            <SettingRow
              icon={<Trash2 size={16} />}
              label={t("info.device")}
              onClick={resetSheet.show}
            />
          </Group>

          {/* PC 오른쪽 '기기 데이터 관리'. 모바일은 정보 묶음의 줄이 같은 시트를 엶 */}
          <Group
            id="device"
            title={t("info.device")}
            description={t("info.deviceBody")}
            className={cn("hidden", panel === "device" && "lg:flex")}
          >
            <SettingRow
              icon={<Trash2 size={16} />}
              label={t("info.reset")}
              onClick={resetSheet.show}
            />
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

// PC 왼쪽 목록에서 오른쪽 묶음을 바꾸는 버튼. 고른 묶음은 aria-current로 알림
function PanelButton({
  current,
  onClick,
  className,
  children,
}: {
  current: boolean;
  onClick: () => void;
  className: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? "true" : undefined}
      className={cn(
        className,
        current &&
          "bg-brand-weak font-bold text-brand-default hover:bg-brand-weak",
      )}
    >
      {children}
    </button>
  );
}

// 위치 묶음: 스위치 → 브라우저 권한 상태 → 기본 지역
function LocationGroup({
  beaches,
  className,
}: {
  beaches: BeachSummary[];
  className?: string | undefined;
}) {
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
  // 권한 줄은 물어볼 수 있을 때(아직 안 물음·받지 못함)만 눌러서 묻기. 그 밖에는 값만 보여 줌
  const canAsk = status === "idle" || status === "unavailable";
  const hint =
    status === "idle"
      ? t("idleHint")
      : status === "denied"
        ? t("deniedHint")
        : status === "unavailable"
          ? t("unavailableHint")
          : null;

  return (
    <Group
      id="location"
      title={t("title")}
      description={
        <span id={switchBodyId}>{enabled ? t("onBody") : t("offBody")}</span>
      }
      footer={
        <>
          {/* 권한 상태가 바뀌면 화면 읽기에 알림(허용·거부 결과). 값 글자는 줄 안, 긴 설명은 여기 */}
          <span role="status" className="block">
            <span className="sr-only">
              {t("permission")} {t(`state.${status}`)}
            </span>
            {hint}
          </span>
          <span className="block">
            {t("regionHint")}
            {saved && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => setRegion(null)}
                  className="-my-3.5 inline-flex min-h-touch items-center align-middle underline"
                >
                  {t("regionClear")}
                </button>
              </>
            )}
          </span>
        </>
      }
      className={className}
    >
      <SettingRow
        icon={<Navigation size={16} />}
        label={t("switch")}
        labelId={switchId}
        control={
          <Switch
            checked={enabled}
            onChange={setLocationEnabled}
            labelledBy={switchId}
            describedBy={switchBodyId}
          />
        }
      />
      <SettingRow
        icon={<MapPin size={16} />}
        label={t("permission")}
        value={t(`value.${status}`)}
        onClick={canAsk ? requestLocation : undefined}
      />
      <SettingRow
        icon={<MapIcon size={16} />}
        label={t("region")}
        value={name}
        onClick={regionSheet.show}
      />

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
function DisplayGroup({
  locale,
  className,
}: {
  locale: Locale;
  className?: string | undefined;
}) {
  const t = useTranslations("settings.display");
  const theme = useTheme();
  const motion = useMotionSwitch();
  const themeSheet = useSheet("settings-theme");
  const languageSheet = useSheet("settings-language");
  const motionId = useId();
  const motionBodyId = useId();

  return (
    <Group
      id="display"
      title={t("title")}
      footer={<span id={motionBodyId}>{t("motionBody")}</span>}
      className={className}
    >
      <SettingRow
        icon={<Moon size={16} />}
        label={t("theme")}
        value={t(`themeOption.${theme}`)}
        onClick={themeSheet.show}
      />
      <SettingRow
        icon={<Languages size={16} />}
        label={t("language")}
        value={LOCALE_NAMES[locale]}
        onClick={languageSheet.show}
      />
      <SettingRow
        icon={<WaveIcon size={16} />}
        label={t("motion")}
        labelId={motionId}
        control={
          <Switch
            checked={motion}
            onChange={setMotionEnabled}
            labelledBy={motionId}
            describedBy={motionBodyId}
          />
        }
      />

      <Sheet
        open={themeSheet.open}
        onClose={themeSheet.close}
        title={t("theme")}
      >
        <fieldset className="pb-2">
          <legend className="sr-only">{t("theme")}</legend>
          <div className="flex flex-col gap-2">
            {THEMES.map((value) => (
              <label key={value} className={choiceClass(theme === value)}>
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  checked={theme === value}
                  onChange={() => {
                    setTheme(value);
                    themeSheet.close();
                  }}
                  className="sr-only"
                />
                {t(`themeOption.${value}`)}
                <ChoiceMark on={theme === value} />
              </label>
            ))}
          </div>
        </fieldset>
      </Sheet>

      <Sheet
        open={languageSheet.open}
        onClose={languageSheet.close}
        title={t("language")}
      >
        {/* 언어마다 주소가 따로라(/, /en) 링크로 바꿈. 기기 언어로 자동 이동하지 않음(10장) */}
        <ul className="flex flex-col gap-2 pb-2">
          {LOCALES.map((value) => (
            <li key={value}>
              <Link
                href={localizedPath(value, "/settings/")}
                hrefLang={value}
                lang={value}
                // 고른 언어를 기기에 저장해 첫 방문 언어 안내를 다시 띄우지 않음(BRD-48)
                onClick={() => setLanguageChoice(value)}
                aria-current={value === locale ? "true" : undefined}
                className={choiceClass(value === locale)}
              >
                {LOCALE_NAMES[value]}
                <ChoiceMark on={value === locale} />
              </Link>
            </li>
          ))}
        </ul>
      </Sheet>
    </Group>
  );
}

// 시트 안 선택지(테마·언어). 고른 것은 테두리·바탕 + ✓(색만으로 구분하지 않음)
function choiceClass(on: boolean) {
  return cn(
    "flex min-h-touch cursor-pointer items-center justify-between gap-2 rounded-button border px-4 text-body has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-default",
    on
      ? "border-brand-default bg-brand-weak font-bold text-text-default"
      : "border-border-strong text-text-body",
  );
}

function ChoiceMark({ on }: { on: boolean }) {
  return on ? (
    <Check aria-hidden="true" size={18} className="text-brand-default" />
  ) : null;
}

// 묶음. 모바일: 12px 굵은 보조색 제목 → 카드 → 설명 캡션. PC: 26px 제목 → 설명(13.5) → 카드 → 캡션(Figma 184:1119)
// 제목은 h2(id settings-<묶음>), PC 왼쪽 목록이 묶음을 바꾸면 이 제목으로 포커스
function Group({
  id,
  title,
  description,
  footer,
  className,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  footer?: ReactNode;
  className?: string | undefined;
  children: ReactNode;
}) {
  const headingId = `settings-${id}`;
  return (
    <section
      aria-labelledby={headingId}
      className={cn("flex flex-col gap-2 lg:gap-4", className)}
    >
      <h2
        id={headingId}
        tabIndex={-1}
        className="text-caption font-bold text-text-muted outline-none lg:text-title-home lg:leading-[37.7px] lg:tracking-[-0.5px] lg:text-text-default"
      >
        {title}
      </h2>
      {/* 설명은 PC에선 카드 위, 모바일에선 카드 아래 캡션(Figma 모바일엔 설명 자리가 없음) */}
      {description && (
        <p className="text-caption text-text-muted max-lg:order-1 lg:text-[13.5px] lg:leading-[19.6px]">
          {description}
        </p>
      )}
      <div className="flex flex-col divide-y divide-border-default overflow-hidden rounded-card bg-bg-surface shadow-card">
        {children}
      </div>
      {footer && (
        <p className="flex flex-col gap-1 text-caption text-text-muted max-lg:order-2">
          {footer}
        </p>
      )}
    </section>
  );
}

// 설정 줄(Figma set 179:166): 32px 아이콘 칸 + 이름(14) + 값(모바일 12 보조색 · PC 14 본문색)·› 또는 스위치
// href면 링크, onClick이면 버튼, 둘 다 없으면 값만 보이는 줄(›도 없음)
function SettingRow({
  icon,
  label,
  labelId,
  value,
  control,
  href,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  labelId?: string;
  value?: string;
  control?: ReactNode;
  href?: string;
  onClick?: (() => void) | undefined;
}) {
  const actionable = href !== undefined || onClick !== undefined;
  const body = (
    <>
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-brand-weak text-brand-default"
      >
        {icon}
      </span>
      <span id={labelId} className="min-w-0 flex-1 text-body text-text-default">
        {label}
      </span>
      {value && (
        <span className="shrink-0 text-caption text-text-muted lg:text-body lg:text-text-body">
          {value}
        </span>
      )}
      {actionable && (
        <ChevronRight
          aria-hidden="true"
          className="size-[15px] shrink-0 text-text-default lg:size-4"
        />
      )}
      {control}
    </>
  );
  const row =
    "flex min-h-[58px] w-full items-center gap-3 px-3.5 py-[7px] text-left";
  if (href !== undefined) {
    return (
      <Link
        href={href}
        className={cn(
          row,
          "hover:bg-bg-subtle focus-visible:-outline-offset-2",
        )}
      >
        {body}
      </Link>
    );
  }
  if (onClick !== undefined) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          row,
          "hover:bg-bg-subtle focus-visible:-outline-offset-2",
        )}
      >
        {body}
      </button>
    );
  }
  return <div className={row}>{body}</div>;
}
