// 기상청 관측 응답(sea_obs·kma_buoy)의 공통 틀 읽기
// 모양: "#START7777" → 머리글(#로 시작) → 자료 줄 → "#7777END"
// 끝 표시가 없으면 중간에 잘린 응답 → 일부만 받은 값을 정상으로 쓰지 않음

export type FramedLines =
  | { status: "ok"; lines: string[] } // 머리글을 뺀 자료 줄만
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
  // slice(1, -1): 첫 줄(시작 표시)과 마지막 줄(끝 표시)을 뺀 나머지. 머리글(#)도 뺌
  const data = lines.slice(1, -1).filter((line) => !line.startsWith("#"));
  return { status: "ok", lines: data };
}
