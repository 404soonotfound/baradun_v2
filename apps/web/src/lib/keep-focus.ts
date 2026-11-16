import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

// 칸을 새로 그려도(key가 바뀜) 그 안에 있던 키보드·화면 읽기 포커스를 같은 항목으로 옮김 (BRD-39)
// 장소 상세는 불러오는 동안 자리 상자를 쓰다가 받은 뒤 칸을 새로 그림(CLS). 그 사이 포커스가 문서 맨 앞으로 사라지지 않게 함
// 같은 항목 = 태그·href·보이는 글자가 같은 요소(예: 긴급신고 119 링크, 정보 출처 링크). 못 찾으면 옮기지 않음

// [1] 항목 알아보는 글자
export function focusKey(element: Element): string {
  return [
    element.tagName,
    element.getAttribute("href") ?? "",
    (element.textContent ?? "").trim(),
  ].join("|");
}

// [2] 화면에서: const ref = useRef(null); useKeepFocus(ref, key); <div ref={ref}>
// ref는 새로 그리는 칸들을 감싸는(새로 그리지 않는) 요소
export function useKeepFocus(ref: RefObject<HTMLElement | null>, key: string) {
  // 마지막으로 이 영역 안에서 포커스를 받은 항목. 영역 밖으로 옮기면 지움
  const last = useRef<string | null>(null);
  useEffect(() => {
    const remember = (target: EventTarget | null) => {
      last.current =
        target instanceof Element && ref.current?.contains(target)
          ? focusKey(target)
          : null;
    };
    // 수화 전(정적 HTML)에 이미 옮겨 둔 포커스도 기억
    remember(document.activeElement);
    const onFocusIn = (event: FocusEvent) => remember(event.target);
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [ref]);
  // key가 바뀐 뒤 그리기 전에: 포커스가 사라졌으면(body) 새 칸에서 같은 항목을 찾아 옮김
  useLayoutEffect(() => {
    const wanted = last.current;
    const root = ref.current;
    if (!wanted || !root) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const match = [
      ...root.querySelectorAll<HTMLElement>("a[href], button, [tabindex]"),
    ].find((element) => focusKey(element) === wanted);
    match?.focus();
  }, [key, ref]);
}
