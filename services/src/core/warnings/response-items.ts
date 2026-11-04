// data.go.kr 응답(JSON.parse 결과)의 행 목록 꺼내기. getPwnCd·getTsunamiMsg·수집기 저장이 같은 규칙을 씀
// 모양: { response: { body: { items: { item } } } }. 행이 여러 개면 배열, 한 개면 객체로 옴 → 배열로 맞춤
// 목록 자리가 없으면 null(빈 목록으로 바꾸지 않음). 행 하나하나의 모양 검사는 부르는 쪽이 함
// 결과 코드 읽기(03 처리)는 API마다 달라 부르는 쪽이 함(getPwnCd 실패, getTsunamiMsg 발표 없음 확인, 아키텍처 4장)

import { maskRequestKeys } from "../collect/log";

export type WarningSource = "getPwnCd" | "getTsunamiMsg";
export type ResponseFailure =
  | { status: "failed"; reason: string }
  | {
      status: "failed";
      reason: string;
      source: WarningSource;
      code: string | null;
      message: string | null;
    };

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 요청 값은 수집기가 정함 → 잘못되면 데이터 문제가 아니라 코드 오류라 멈춤
export function checkNumOfRows(numOfRows: number): void {
  if (!Number.isSafeInteger(numOfRows) || numOfRows < 1) {
    throw new RangeError(`numOfRows 오류: ${numOfRows}`);
  }
}

// 모양: { response: { header: { resultCode } } }. 머리가 없으면 null
export function responseHeader(json: unknown): Record<string, unknown> | null {
  const response = isObject(json) ? json.response : undefined;
  const header = isObject(response) ? response.header : undefined;
  return isObject(header) ? header : null;
}

// 출처가 돌려준 오류는 code를 바꾸지 않고 보존하고, message만 로그·운영 기록에 안전한 한 줄로 정리함(D16-E7)
export function sourceResponseFailure(
  source: WarningSource,
  header: Readonly<Record<string, unknown>>,
  code: string | null,
): ResponseFailure {
  const rawMessage = header.resultMsg;
  const message =
    typeof rawMessage === "string"
      ? maskRequestKeys(rawMessage)
          .replace(/[\u0000-\u001f\u007f]+/g, " ")
          .replace(/\s+/g, " ")
          .trim() || null
      : null;
  return {
    status: "failed",
    reason: `resultCode:${code ?? ""}`,
    source,
    code,
    message,
  };
}

// 정상 코드인데 목록이 비었거나 요청한 만큼 꽉 찬 응답 → 실패. 문제없으면 null
// 빈 목록: 두 API 모두 '없음'을 빈 목록으로 주지 않음 → 이상 응답으로 봄('없음'으로 읽지 않음)
// 꽉 참: 뒤가 잘렸을 수 있음(쪽 나누기는 불안정해서 쓰지 않음)
export function listSizeFailure(
  list: readonly unknown[],
  numOfRows: number,
): ResponseFailure | null {
  if (list.length === 0) return { status: "failed", reason: "empty" };
  if (list.length >= numOfRows) {
    return { status: "failed", reason: `truncated:${list.length}` };
  }
  return null;
}

export function responseItems(json: unknown): unknown[] | null {
  const response = isObject(json) ? json.response : undefined;
  const body = isObject(response) ? response.body : undefined;
  const items = isObject(body) ? body.items : undefined;
  const item = isObject(items) ? items.item : undefined;
  return Array.isArray(item) ? item : isObject(item) ? [item] : null;
}
