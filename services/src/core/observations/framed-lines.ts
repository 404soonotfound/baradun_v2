// 기상청 관측 응답(sea_obs·kma_buoy)의 공통 틀 읽기
// 모양: "#START7777" → 머리글(#로 시작) → 자료 줄 → "#7777END"
// 끝 표시가 없으면 중간에 잘린 응답 → 일부만 받은 값을 정상으로 쓰지 않음

// lines: 머리글을 뺀 자료 줄. headers: 머리글 줄마다 '#'를 뺀 낱말 목록(칸 이름·단위 확인용)
export type FramedLines =
  | { status: "ok"; lines: string[]; headers: string[][] }
  | { status: "failed"; reason: string };

const START = "#START7777";
const END = "#7777END";

export function readFramedLines(text: string): FramedLines {
  // 줄로 나눔 → 줄마다 앞뒤 빈칸 지움 → 빈 줄 버림
  // \r?\n: 윈도식(\r\n)·유닉스식(\n) 줄바꿈 모두 처리
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines[0] !== START) return { status: "failed", reason: "시작 표시 없음" };
  if (lines[lines.length - 1] !== END) {
    return { status: "failed", reason: "끝 표시 없음(잘린 응답)" };
  }
  // slice(1, -1): 첫 줄(시작 표시)과 마지막 줄(끝 표시)을 뺀 나머지
  const body = lines.slice(1, -1);
  const data = body.filter((line) => !line.startsWith("#"));
  // 자료 줄이 하나도 없으면 장애 응답으로 봄 → 빈 결과를 정상 수집으로 남기지 않음(운영 알림, BRD-56)
  if (data.length === 0) return { status: "failed", reason: "자료 줄 없음" };
  const headers = body
    .filter((line) => line.startsWith("#"))
    .map((line) => line.slice(1).trim().split(/\s+/));
  return { status: "ok", lines: data, headers };
}

// 머리글에 기대한 칸 이름 줄이 그대로 있는지. 칸 수가 같아도 순서가 바뀌면 다른 값을 읽게 됨 → 다르면 응답 전체 실패
export function hasHeader(
  headers: readonly string[][],
  expected: readonly string[],
): boolean {
  return headers.some(
    (words) =>
      words.length === expected.length &&
      words.every((word, index) => word === expected[index]),
  );
}

// 줄 읽기 결과(sea_obs·kma_buoy 공통). status 값으로 어느 쪽인지 구별
// skippedRows: 모양·시각·번호를 읽지 못해 건너뛴 줄 수(운영 알림용, BRD-56)
export type RowsResult<Row> =
  | { status: "ok"; rows: Row[]; skippedRows: number }
  | { status: "failed"; reason: string };

export const STATION_ID = /^\d+$/; // 측정기 번호는 숫자만

// cells[i]는 칸이 없을 수도 있어 타입이 string | undefined(설정 noUncheckedIndexedAccess)
// 없으면 빈 글자로 바꿈 → 이후 코드는 항상 string으로 다룸
export function cellAt(cells: readonly string[], index: number): string {
  return cells[index] ?? "";
}

// 쓸 수 있는 줄이 하나도 없으면 실패. 모든 줄이 모양·시각·번호 문제로 빠진 응답을 정상 수집으로 남기지 않음
export const NO_USABLE_ROWS = {
  status: "failed",
  reason: "쓸 수 있는 줄 없음",
} as const satisfies RowsResult<never>;
