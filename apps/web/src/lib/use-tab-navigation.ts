import { usePathname } from "next/navigation";
import { useLocale } from "next-intl";
import { useEffect, useRef, type MouseEvent } from "react";

import { type Locale, localizedPath } from "@/lib/i18n";
import { prefersReducedMotion } from "@/lib/motion";
import { TABS, type TabKey, tabOf } from "@/lib/nav";
import {
  lastUrlOf,
  markInAppNavigation,
  rememberOwnerTab,
  rememberScroll,
  rememberTabUrl,
  requestScrollRestore,
  takeScrollRestore,
  useTabMemory,
} from "@/lib/tab-memory";

// 탭 이동 규칙 (노션 1장: 각 탭의 마지막 상태로, 같은 탭을 다시 누르면 맨 위로) (BRD-24)
// 모바일 하단 탭과 PC 상단 내비가 같은 규칙을 쓰도록 한 곳에 모음
const currentUrl = () => window.location.pathname + window.location.search;

type PendingTab = {
  tab: TabKey;
  fromPathname: string;
};

// 전환 중 목표 탭을 추적하는 상태기(모바일 하단 탭·PC 상단 내비가 모듈 단위로 공유)
// usePathname()은 Next.js 새 경로 커밋 뒤에야 바뀌므로, 전환 중에 목표 탭을 기억해
// 같은 탭 분기 오작동과 떠나는 탭 상태 덮어쓰기를 막음
export function createTabTransition() {
  let pending: PendingTab | null = null;
  let effectPathname: string | null = null;

  return {
    // 같은 탭 판정 기준: 전환 중이면 가는 중인 탭, 아니면 현재 커밋된 탭
    activeTab(current: TabKey | null): TabKey | null {
      return pending?.tab ?? current;
    },
    // 떠나는 탭의 마지막 주소·스크롤을 저장해도 되는지:
    // - 전환 중이거나 pushState로 주소만 먼저 바뀐 상태면 첫 클릭 저장값을 유지
    // - 새 경로 DOM이 커밋됐지만 passive effect(useEffect)가 아직 돌기 전 틈에도
    //   잘린 scrollY(예: 짧은 홈)로 저장 위치를 덮어쓰지 않음
    shouldSaveOrigin(
      current: TabKey | null,
      committedPathname: string,
      browserPathname: string,
    ): boolean {
      if (effectPathname !== null && effectPathname !== committedPathname) {
        return false;
      }
      if (pending === null) return true;
      return pending.tab === current && browserPathname === committedPathname;
    },
    start(tab: TabKey, fromPathname: string) {
      pending = { tab, fromPathname };
    },
    // 반환값: 이 경로에서 복원 예약을 꺼내도 되는지
    // pending.fromPathname과 같으면 앞선 전환의 passive effect가 재클릭 뒤에 늦게 돈
    // 중간 경로이므로, 복원 예약을 지우지 않고 목적지 도착 때까지 pending을 유지함
    onPathnameChange(pathname: string): boolean {
      effectPathname = pathname;
      if (pending !== null && pathname === pending.fromPathname) {
        return false;
      }
      pending = null;
      return true;
    },
  };
}

const transition = createTabTransition();

export function useTabNavigation() {
  const pathname = usePathname();
  const locale = useLocale() as Locale;
  const memory = useTabMemory();
  const current = tabOf(pathname, locale); // 지금 탭 화면이면 그 탭, 아니면 null
  const owner = current ?? memory.owner; // 상세·검색은 들어오기 전 탭 소속
  const isFirstRender = useRef(true);

  // 탭 화면에 들어오면 "지금 탭"으로 기억
  useEffect(() => {
    if (current) rememberOwnerTab(current);
  }, [current]);

  // 주소가 바뀔 때마다: 진행 중이던 탭 목표를 비우고, 앱 안 이동 표시 + 저장 위치 복원
  // (하단 탭과 상단 내비가 둘 다 이 훅을 써도, 복원 예약은 한 번 꺼내면 지워져서 한 번만 실행)
  useEffect(() => {
    const shouldRestore = transition.onPathnameChange(pathname);
    if (isFirstRender.current) isFirstRender.current = false;
    else markInAppNavigation();
    if (!shouldRestore) return;
    const y = takeScrollRestore(currentUrl());
    if (y !== null) window.scrollTo(0, y);
  }, [pathname]);

  // 탭의 링크 주소: 지금 속한 탭은 첫 화면(상세에서 누르면 탭 처음으로), 다른 탭은 마지막으로 보던 주소
  function hrefFor(tab: TabKey): string {
    const root = localizedPath(
      locale,
      TABS.find((item) => item.key === tab)!.path,
    );
    return tab === owner ? root : (lastUrlOf(memory, tab, locale) ?? root);
  }

  function onTabClick(event: MouseEvent<HTMLAnchorElement>, tab: TabKey) {
    // ⌘·Ctrl 클릭(새 탭에서 열기)은 브라우저에 맡김
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return;

    if (tab === transition.activeTab(current)) {
      // 같은 탭을 다시 누름 → 이동하지 않고 맨 위로 (동작 줄이기면 바로)
      event.preventDefault();
      window.scrollTo({
        top: 0,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      return;
    }

    const target = hrefFor(tab);
    if (
      transition.shouldSaveOrigin(current, pathname, window.location.pathname)
    ) {
      const here = currentUrl();
      if (owner) rememberTabUrl(owner, here);
      rememberScroll(here, window.scrollY);
    }
    requestScrollRestore(target);
    transition.start(tab, pathname);
  }

  return { pathname, locale, current, hrefFor, onTabClick };
}
