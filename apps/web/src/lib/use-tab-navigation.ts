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

  // 주소가 바뀔 때마다: 앱 안 이동 표시 + 탭을 눌러 왔으면 그 탭에서 보던 위치로 이동
  // (하단 탭과 상단 내비가 둘 다 이 훅을 써도, 복원 예약은 한 번 꺼내면 지워져서 한 번만 실행)
  useEffect(() => {
    if (isFirstRender.current) isFirstRender.current = false;
    else markInAppNavigation();
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

    const here = currentUrl();
    if (tab === current) {
      // 같은 탭을 다시 누름 → 이동하지 않고 맨 위로 (동작 줄이기면 바로)
      event.preventDefault();
      window.scrollTo({
        top: 0,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      return;
    }
    // 떠나는 탭의 마지막 상태(주소·스크롤) 저장, 가는 탭은 저장된 위치로 돌아가도록 예약
    if (owner) rememberTabUrl(owner, here);
    rememberScroll(here, window.scrollY);
    requestScrollRestore(hrefFor(tab));
  }

  return { pathname, locale, current, hrefFor, onTabClick };
}
