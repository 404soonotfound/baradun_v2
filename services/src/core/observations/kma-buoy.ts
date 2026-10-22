import { parseKstTime } from "../warnings/time";
import { readMetricValue } from "./values";

// kma_buoy 응답 읽기 (데이터 출처 3장, 결정 기록 11장 B1·10/22 BRD-19)
// 파주기·파향만 씀(파고·수온·바람은 sea_obs). 측정기 종류 칸이 없어 모든 줄을 읽음
// 모양: "#START7777" → 머리글 3줄(#) → 자료 줄(빈칸 구분) → "#7777END"
// 한 측정기가 10분 간격 여러 시각으로 옴 → 줄을 모두 돌려주고 최신 값 고르기는 부르는 쪽에서 함

export interface KmaBuoyRow {
  readonly stationId: string;
  readonly observedAt: string; // UTC ISO, 예 "2026-10-20T15:00:00Z"
  readonly wavePeriod: number | null; // 초
  readonly waveDirection: number | null; // 도(0~360)
}

// skippedRows: 시각·측정기 번호를 읽지 못해 건너뛴 줄 수(운영 알림용, BRD-56)
export type KmaBuoyResult =
  | { status: "ok"; rows: KmaBuoyRow[]; skippedRows: number }
  | { status: "failed"; reason: string };

const START = "#START7777";
const END = "#7777END";
// 실응답 180줄 모두 17칸 → 이 모양이 아니면 칸 자리를 믿을 수 없음
const CELLS_PER_LINE = 17;
const COLUMN = {
  time: 0,
  station: 1,
  wavePeriod: 15,
  waveDirection: 16,
} as const;
const STATION_ID = /^\d+$/;

export function parseKmaBuoy(text: string): KmaBuoyResult {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines[0] !== START) return { status: "failed", reason: "시작 표시 없음" };
  if (lines[lines.length - 1] !== END) {
    return { status: "failed", reason: "끝 표시 없음(잘린 응답)" };
  }

  const rows: KmaBuoyRow[] = [];
  let skippedRows = 0;
  for (const line of lines.slice(1, -1)) {
    if (line.startsWith("#")) continue;
    // \s+: 빈칸이 몇 개든 한 번의 구분으로 봄(칸 너비를 빈칸으로 맞춰 줌)
    const cells = line.split(/\s+/);
    if (cells.length !== CELLS_PER_LINE) {
      return { status: "failed", reason: `줄 모양이 다름: ${line}` };
    }
    const cell = (index: number): string => cells[index] ?? "";

    const time = parseKstTime(cell(COLUMN.time));
    const stationId = cell(COLUMN.station);
    if (time.kind !== "time" || !STATION_ID.test(stationId)) {
      skippedRows += 1;
      continue;
    }
    rows.push({
      stationId,
      observedAt: time.iso,
      wavePeriod: readMetricValue("wavePeriod", cell(COLUMN.wavePeriod)),
      waveDirection: readMetricValue(
        "waveDirection",
        cell(COLUMN.waveDirection),
      ),
    });
  }
  return { status: "ok", rows, skippedRows };
}
