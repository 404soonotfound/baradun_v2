import { LOADING_TIMES } from "./loading-timing";

// 페이지 이동 중 상태 (GH-462, 캔버스 로딩 보드 L9·LS ①)
// - 메뉴·링크를 누르면 그 주소를 바로 기억 → 왼쪽 메뉴 선택이 즉시 바뀜(새 화면이 오기 전)
// - 본문 위 2px 진행 막대는 150ms 뒤에 보임(빠른 이동은 막대 없이)
// - 새 화면 주소가 되면 지움. 이동이 멈춰도 막대가 남지 않게 15초 뒤 지움
// 화면마다 공통 틀(AdminShell)이 새로 그려지므로 상태는 모듈 메모리에 둠

export interface PendingNavigation {
  readonly href: string;
  // 진행 막대를 보일 때(150ms 지남)
  readonly visible: boolean;
}

let pending: PendingNavigation | null = null;
let timers: ReturnType<typeof setTimeout>[] = [];
const listeners = new Set<() => void>();

const emit = () => {
  for (const fn of listeners) fn();
};

const clearTimers = () => {
  for (const timer of timers) clearTimeout(timer);
  timers = [];
};

// 주소 끝 / 를 맞춤(정적 내보내기 trailingSlash)
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (p.endsWith("/") ? p : `${p}/`);
  return norm(a) === norm(b);
}

export function startNavigation(href: string, current: string): void {
  // 지금 화면을 누르면 이동이 없음. 앞서 누른 다른 화면 이동이 있었으면 그것도 취소된 것으로 보고 지움
  // (지우지 않으면 메뉴 선택·진행 막대가 15초 동안 남음)
  if (samePath(href, current)) {
    finishNavigation();
    return;
  }
  clearTimers();
  pending = { href, visible: false };
  emit();
  timers.push(
    setTimeout(() => {
      if (pending?.href !== href) return;
      pending = { href, visible: true };
      emit();
    }, LOADING_TIMES.delay),
    setTimeout(() => finishNavigation(), LOADING_TIMES.timeout),
  );
}

export function finishNavigation(): void {
  clearTimers();
  if (pending === null) return;
  pending = null;
  emit();
}

export function subscribeNavigation(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function pendingNavigation(): PendingNavigation | null {
  return pending;
}

// 같은 탭 안 이동으로 볼 링크 누르기인지(새 탭·다운로드·바깥 주소·보조 키 누름은 아님)
export function internalHref(
  event: {
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    defaultPrevented: boolean;
  },
  anchor: { getAttribute(name: string): string | null } | null,
): string | null {
  if (!anchor || event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return null;
  }
  const target = anchor.getAttribute("target");
  if (target && target !== "_self") return null;
  if (anchor.getAttribute("download") !== null) return null;
  const href = anchor.getAttribute("href");
  // 같은 사이트 주소만('/'로 시작, '//' 다른 사이트 제외). 같은 화면 안 '#' 이동은 아님
  if (!href || !href.startsWith("/") || href.startsWith("//")) return null;
  const path = href.split(/[?#]/)[0] ?? href;
  return path;
}
