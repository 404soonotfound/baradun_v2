// import { 이름 } from "경로": 다른 파일이 export한 것을 가져옴(.ts 확장자는 쓰지 않음)
import { parseKstTime } from "../warnings/time";
import { readMetricValue } from "./values";

// sea_obs 응답 읽기 (데이터 출처 3장, 결정 기록 11장 B1·10/22 BRD-19)
// 파고·수온·풍속만 씀(파주기·파향은 kma_buoy). 측정기는 부이(B)·파고부이(C)만
// 모양: "#START7777" → 머리글 2줄(#) → 자료 줄(쉼표 구분, 측정기마다 1줄) → "#7777END"

// 측정기 한 곳의 한 번 관측. 값은 검사를 통과한 숫자 또는 null(무효)
// interface: 객체가 어떤 칸을 가져야 하는지 적은 설계도
// readonly: 만든 뒤 바꿀 수 없는 칸(실수로 덮어쓰기 방지)
export interface SeaObsRow {
  readonly stationId: string;
  readonly observedAt: string; // UTC ISO, 예 "2026-10-20T15:00:00Z"
  readonly waveHeight: number | null;
  readonly wind: number | null;
  readonly waterTemp: number | null;
}

// 결과는 두 모양 중 하나. status 값으로 어느 쪽인지 구별(부르는 쪽이 if로 나눠 씀)
// skippedRows: 시각·측정기 번호를 읽지 못해 건너뛴 줄 수(운영 알림용, BRD-56)
export type SeaObsResult =
  | { status: "ok"; rows: SeaObsRow[]; skippedRows: number }
  | { status: "failed"; reason: string };

const START = "#START7777";
const END = "#7777END";
const STATION_TYPES = new Set(["B", "C"]); // B 부이, C 파고부이(결정 기록 11장 B1)
// 자료 줄 = 공식 칸 14개 + 뜻 모르는 숫자 묶음 1칸(빈 칸일 때가 많음) + 끝 표시 "="
// 실응답 188줄 모두 16칸·"="로 끝남 → 이 모양이 아니면 칸 자리를 믿을 수 없음
const CELLS_PER_LINE = 16;
const LINE_END = "=";
// 쓰는 칸의 자리(0부터 셈). as const: 숫자를 고정값으로 둠(바꿀 수 없음)
const COLUMN = {
  type: 0,
  time: 1,
  station: 2,
  waveHeight: 6,
  windSpeed: 8,
  waterTemp: 10,
} as const;
const STATION_ID = /^\d+$/; // 측정기 번호는 숫자만

export function parseSeaObs(text: string): SeaObsResult {
  // 줄로 나눔 → 줄마다 앞뒤 빈칸 지움 → 빈 줄 버림
  // \r?\n: 윈도식(\r\n)·유닉스식(\n) 줄바꿈 모두 처리
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  // 끝 표시가 없으면 중간에 잘린 응답 → 일부만 받은 값을 정상으로 쓰지 않음
  if (lines[0] !== START) return { status: "failed", reason: "시작 표시 없음" };
  if (lines[lines.length - 1] !== END) {
    return { status: "failed", reason: "끝 표시 없음(잘린 응답)" };
  }

  const rows: SeaObsRow[] = []; // 빈 배열에서 시작해 한 줄씩 채움
  let skippedRows = 0; // let: 나중에 값을 바꿀 수 있는 변수(const는 못 바꿈)
  // slice(1, -1): 첫 줄(시작 표시)과 마지막 줄(끝 표시)을 뺀 나머지
  for (const line of lines.slice(1, -1)) {
    if (line.startsWith("#")) continue; // 머리글. continue: 이 줄은 건너뛰고 다음 줄로
    const cells = line.split(",").map((cell) => cell.trim());
    // 칸 수·끝 표시가 다르면 형식이 바뀐 것 → 칸 자리를 믿을 수 없어 응답 전체를 실패로 봄
    if (
      cells.length !== CELLS_PER_LINE ||
      cells[cells.length - 1] !== LINE_END
    ) {
      return { status: "failed", reason: `줄 모양이 다름: ${line}` };
    }
    // cells[i]는 칸이 없을 수도 있어 타입이 string | undefined(설정 noUncheckedIndexedAccess)
    // ?? "": 없으면(undefined) 빈 글자로 바꿈 → 이후 코드는 항상 string으로 다룸
    const cell = (index: number): string => cells[index] ?? "";
    if (!STATION_TYPES.has(cell(COLUMN.type))) continue; // B·C가 아닌 측정기는 건너뜀

    const time = parseKstTime(cell(COLUMN.time)); // KST 글자 → UTC (특보와 같은 함수)
    const stationId = cell(COLUMN.station);
    // 시각·번호를 못 읽으면 이 줄만 버리고 셈. 그 측정기 값은 갱신되지 않아 나중에 지연으로 보임
    if (time.kind !== "time" || !STATION_ID.test(stationId)) {
      skippedRows += 1;
      continue;
    }
    rows.push({
      stationId,
      observedAt: time.iso,
      waveHeight: readMetricValue("waveHeight", cell(COLUMN.waveHeight)),
      wind: readMetricValue("wind", cell(COLUMN.windSpeed)),
      waterTemp: readMetricValue("waterTemp", cell(COLUMN.waterTemp)),
    });
  }
  return { status: "ok", rows, skippedRows };
}
