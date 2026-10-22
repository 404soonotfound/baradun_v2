// 수집용 HTTP GET (아키텍처 5장, BRD-56 완료 조건: 재시도·시간 제한)
// 실패 사유에는 주소를 넣지 않음(주소에 API 키가 들어 있음). 로그는 log.ts가 키를 가림
// fetch는 인자로 받음 → 테스트가 시간 초과·응답 없음·5xx를 흉내 냄

export type HttpResult =
  | { status: "ok"; body: string; httpStatus: number; attempts: number }
  | { status: "failed"; reason: string; attempts: number };

export interface HttpOptions {
  readonly timeoutMs: number; // 한 번 시도의 시간 제한
  readonly retries: number; // 첫 시도 뒤 다시 하는 횟수
  readonly fetchFn?: typeof fetch;
}

// 다시 해 볼 만한 응답: 서버 오류·요청 과다. 4xx(키 오류 등)는 다시 해도 같음
const RETRYABLE = (httpStatus: number) =>
  httpStatus >= 500 || httpStatus === 429;

export async function getText(
  url: string,
  options: HttpOptions,
): Promise<HttpResult> {
  const fetchFn = options.fetchFn ?? fetch;
  let reason = "not_tried";
  const maxAttempts = options.retries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // AbortSignal.timeout: 시간이 지나면 요청을 끊음. 본문 읽기까지 포함
    const signal = AbortSignal.timeout(options.timeoutMs);
    try {
      const response = await fetchFn(url, { signal });
      if (!response.ok) {
        reason = `http:${response.status}`;
        if (RETRYABLE(response.status)) continue;
        return { status: "failed", reason, attempts: attempt };
      }
      const body = await response.text();
      return {
        status: "ok",
        body,
        httpStatus: response.status,
        attempts: attempt,
      };
    } catch (error) {
      // 시간 초과는 TimeoutError, 연결 실패 등은 그 밖. 원문 메시지는 주소를 담을 수 있어 쓰지 않음
      reason =
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "network";
    }
  }
  return { status: "failed", reason, attempts: maxAttempts };
}
