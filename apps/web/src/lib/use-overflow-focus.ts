import { useEffect, useRef } from "react";

// 모바일 한 줄 + 옆으로 넘김 클래스(탐색·즐겨찾기 요약 줄 공용, GH-218 CLS). 넘칠 때(data-overflow)만 오른쪽 끝을 흐림
// 흐림(mask)은 요소 밖에 그리는 포커스 테두리까지 지우므로 키보드 포커스 동안은 흐림을 끔(WCAG 2.4.7)
export const OVERFLOW_LINE_CLASS =
  "max-lg:flex-nowrap max-lg:overflow-x-auto max-lg:whitespace-nowrap max-lg:[scrollbar-width:none] max-lg:[&>*]:shrink-0 max-lg:data-[overflow]:pr-6 max-lg:data-[overflow]:[mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)] max-lg:data-[overflow]:focus-visible:[mask-image:none]";

// 옆으로 넘치는 한 줄(모바일 요약 줄 등)을 키보드로도 넘겨 볼 수 있게 함 (GH-218 · WCAG 2.1.1)
// 실제로 넘칠 때만 Tab 순서에 넣고 data-overflow를 붙임(오른쪽 끝을 흐리게 해 더 있음을 알림). 넘치지 않는 PC에서는
// Tab 정지 칸을 늘리지 않음. 크기가 바뀌면 다시 확인
export function useOverflowFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const check = () => {
      if (element.scrollWidth > element.clientWidth + 1) {
        element.tabIndex = 0;
        element.dataset.overflow = "";
      } else {
        element.removeAttribute("tabindex");
        delete element.dataset.overflow;
      }
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return ref;
}
