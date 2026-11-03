// 로그인 뒤 돌아갈 화면 (캔버스 F2 '열려던 화면'). 이 탭 메모리에만 둠(새로고침하면 사라짐)
// 같은 사이트의 경로만 받음(외부 주소로 보내지 않음)

let target: string | null = null;

export function rememberReturnTo(path: string): void {
  target = path.startsWith("/") && !path.startsWith("//") ? path : null;
}

export function takeReturnTo(): string {
  const next = target ?? "/";
  target = null;
  return next.startsWith("/login") ? "/" : next;
}

export function peekReturnTo(): string | null {
  return target;
}
