"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { LogoMark } from "@/components/logo-mark";
import { SettingsIcon } from "@/components/settings-icon";
import { cn } from "@/lib/cn";
import { useFavorites } from "@/lib/favorites";
import { isDelayedView, shownDataTime } from "@/lib/situation";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { deriveBeachView } from "@/lib/snapshot/view";
import { updateStatus } from "@/lib/update-status";
import { useOnline } from "@/lib/use-online";
import { localizedPath } from "@/lib/i18n";
import { TABS, isTabActive } from "@/lib/nav";
import { useTabNavigation } from "@/lib/use-tab-navigation";

// 상단 내비 (노션 1장 'PC 흐름', 3장 TopNav): 높이 64, 현재 메뉴는 아래 2px 파란 줄
// 홈 · 탐색 · 즐겨찾기 + 검색 + 설정. 업데이트 상태는 데이터 연결 이슈에서 추가 예정
// 메뉴(설정 포함)는 하단 탭과 같은 이동 규칙(마지막 상태·맨 위로) 사용. PC(lg 이상)에서만 표시
// 모양(Figma 'PC 상단 내비' 170:407, BRD-129): 로고 그림 + 이름 · 메뉴(즐겨찾기 개수) · 가운데 검색(/ 키) · 설정

// 글자를 쓰는 중이 아닐 때 '/'를 누르면 검색 화면으로(Figma 검색칸의 / 표시)
function typingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}
// Vue: props: { beachIds } — 노출 중인 해변 id(관측 지연 수를 셀 범위)
export function TopNav({ beachIds }: { beachIds: readonly string[] }) {
  const t = useTranslations("nav");
  const tMeta = useTranslations("meta");
  const { pathname, locale, current, hrefFor, onTabClick } = useTabNavigation();
  const menu = TABS.filter((tab) => tab.key !== "settings");
  const searchActive = isTabActive(pathname, "/search/", locale);
  const favorites = useFavorites().length;
  const router = useRouter();
  const searchHref = localizedPath(locale, "/search/");
  const snapshot = useSnapshot();
  const online = useOnline();
  // 업데이트 상태 알약(lib/update-status.ts). 관측 지연은 게시된 사유 그대로 셈(분류 재계산 없음)
  const status = updateStatus({
    time: shownDataTime(snapshot.manifest?.generatedAt, snapshot.nowMs),
    online,
    live: snapshot.live,
    delayed: beachIds.filter((id) =>
      isDelayedView(deriveBeachView({ id, hidden: false }, snapshot)),
    ).length,
  });

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (
        event.key !== "/" ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        typingTarget(event.target) ||
        // 시트·대화상자가 열려 있으면 그 안의 일을 끊지 않음
        document.querySelector("dialog[open]") !== null
      )
        return;
      event.preventDefault();
      router.push(searchHref);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, searchHref]);

  return (
    <header className="sticky top-0 z-40 hidden h-16 border-b border-border-default bg-bg-surface lg:block">
      {/* 높이 64는 아래 테두리 1px 포함 (header에 h-16, 안쪽은 h-full) */}
      <div className="mx-auto flex h-full max-w-[1280px] items-center gap-10 px-8">
        <Link
          href={localizedPath(locale, "/")}
          className="flex min-h-touch items-center gap-2 text-title-m text-text-default"
        >
          <LogoMark />
          {tMeta("siteName")}
        </Link>

        <nav aria-label={t("main")} className="h-full">
          <ul className="flex h-full gap-7">
            {menu.map(({ key }) => {
              const active = key === current;
              return (
                <li key={key} className="h-full">
                  <Link
                    href={hrefFor(key)}
                    scroll={false}
                    onClick={(event) => onTabClick(event, key)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      // 글자가 짧아도(예: '홈') 누르는 폭 44px: 밑줄은 글자 폭 그대로 두고 눌림 영역만 가운데 기준으로 넓힘(BRD-39)
                      "relative flex h-full items-center gap-1.5 border-b-2 pb-0.5 text-title-s before:absolute before:inset-y-0 before:left-1/2 before:w-full before:min-w-touch before:-translate-x-1/2 before:content-['']",
                      active
                        ? "border-brand-default text-text-default"
                        : "border-transparent font-normal text-text-body hover:text-text-default",
                    )}
                  >
                    {t(key)}
                    {/* 즐겨찾기 개수(이 기기에 저장한 해변). 0이면 숨김 */}
                    {key === "favorites" && favorites > 0 && (
                      <>
                        <span
                          aria-hidden="true"
                          className="flex h-5 items-center rounded-badge bg-status-clear-bg px-[7px] text-badge text-status-clear-fg"
                        >
                          {favorites}
                        </span>
                        <span className="sr-only">
                          {t("favoritesSaved", { count: favorites })}
                        </span>
                      </>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-1 justify-center">
          <Link
            href={searchHref}
            aria-current={searchActive ? "page" : undefined}
            aria-keyshortcuts="/"
            aria-label={t("search")}
            className={cn(
              "flex h-[42px] w-full max-w-[340px] min-w-0 items-center gap-2 rounded-input border bg-bg-subtle px-3 text-body text-text-muted",
              searchActive ? "border-brand-default" : "border-transparent",
            )}
          >
            <Search aria-hidden="true" size={17} />
            <span className="flex-1 truncate">{t("searchPlaceholder")}</span>
            <kbd
              aria-hidden="true"
              className="flex h-[19.4px] items-center rounded-[5px] border border-border-strong px-[7px] font-sans text-caption"
            >
              /
            </kbd>
          </Link>
        </div>
        {status.kind !== "hidden" && (
          <p className="flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-border-default px-[15px] text-body-s font-bold text-text-default">
            {/* 점은 관측 지연이 있을 때만(색만으로 알리지 않고 글자도 함께) */}
            {status.kind === "live" && status.delayed > 0 && (
              <span
                aria-hidden="true"
                className="size-2 rounded-full bg-status-stale-border"
              />
            )}
            {status.kind === "live" ? (
              <>
                {t("updated", { time: status.time })}
                {status.delayed > 0 && (
                  <span className="text-status-stale-fg">
                    {" · "}
                    {t("delayedCount", { count: status.delayed })}
                  </span>
                )}
              </>
            ) : (
              <span className="font-normal text-text-muted">
                {t("notLive", { time: status.time })}
              </span>
            )}
          </p>
        )}
        <div className="flex items-center">
          <Link
            href={hrefFor("settings")}
            scroll={false}
            onClick={(event) => onTabClick(event, "settings")}
            aria-current={current === "settings" ? "page" : undefined}
            aria-label={t("settings")}
            className={cn(
              "flex size-touch items-center justify-center rounded-full hover:bg-bg-subtle",
              current === "settings" ? "text-brand-default" : "text-text-body",
            )}
          >
            <SettingsIcon aria-hidden="true" size={20} strokeWidth={1.8} />
          </Link>
        </div>
      </div>
    </header>
  );
}
