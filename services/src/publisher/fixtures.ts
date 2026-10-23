import { readFileSync } from "node:fs";
import type { Beach } from "@baradun/contracts";
import { OCEAN_STATE } from "../collectors/ocean";
import { WARNINGS_STATE } from "../collectors/warnings";
import type { StateStore } from "../core/store/types";
import { packItems } from "../core/warnings/archive";
import { zoneTablesFromAnnex, type AnnexTables } from "./zones";

// publisher 테스트 공용 입력. 실제 data/beaches 파일과 별표 구역표를 씀
// 시각: NOW = KST 2026-10-23 11:30. 특보 발표 KST 11:00, 확인 KST 11:20

const root = new URL("../../../", import.meta.url);
const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(new URL(path, root), "utf8")) as T;

export const NOW = "2026-10-23T02:30:00Z";
export const CONFIRMED = "2026-10-23T02:20:00Z";
export const OBSERVED = "2026-10-23T02:00:00Z";

export const ZONES = zoneTablesFromAnnex(
  readJson<AnnexTables>("tools/beaches/annex-tables.json"),
);

// b0001 강문(강원중부앞바다 S1151200·강릉평지 L1022510), b0002 경포, b0003은 숨긴 해변으로 바꿔 씀
export const BEACHES: Beach[] = [
  readJson<Beach>("data/beaches/b0001.json"),
  readJson<Beach>("data/beaches/b0002.json"),
  { ...readJson<Beach>("data/beaches/b0003.json"), hidden: true },
];

// getPwnCd 원본 행(수집기가 저장하는 모양). 시각은 KST yyyymmddHHMM
export function pwnRow(fields: {
  areaCode: string;
  warnVar: string;
  warnStress?: string;
  command?: string;
  tmFc?: string;
}) {
  const tmFc = fields.tmFc ?? "202610231100";
  return {
    stnId: "108",
    tmFc,
    tmSeq: "1",
    areaCode: fields.areaCode,
    areaName: "",
    warnVar: fields.warnVar,
    warnStress: fields.warnStress ?? "0",
    command: fields.command ?? "1",
    cancel: "0",
    startTime: tmFc,
    endTime: "0",
    allEndTime: "0",
  };
}

export const WIND_WAVE_ROW = pwnRow({ areaCode: "S1151200", warnVar: "6" }); // 풍랑주의보 강원중부앞바다
export const HEAVY_RAIN_ROW = pwnRow({ areaCode: "L1022510", warnVar: "2" }); // 호우주의보 강릉평지(주변 특보)

export async function seedWarnings(
  state: StateStore,
  pwnRows: unknown[],
  options: { tsunamiRows?: unknown[]; confirmedAt?: string } = {},
) {
  const confirmedAt = options.confirmedAt ?? CONFIRMED;
  for (const [source, rows] of [
    ["pwncd", pwnRows],
    ["tsunami", options.tsunamiRows ?? []],
  ] as const) {
    const packed = packItems(rows);
    if (packed.status !== "ok") throw new Error(packed.reason);
    const { pk, sk } = WARNINGS_STATE[source];
    await state.putState(
      pk,
      sk,
      {
        archive: packed.archive,
        rowCount: rows.length,
        lastConfirmedAt: confirmedAt,
      },
      Date.parse(confirmedAt),
    );
  }
}

// 해변 세 곳의 파고 측정소에 정상값
export async function seedReadings(
  state: StateStore,
  value: unknown = 0.5,
  observedAt = OBSERVED,
) {
  const readings: Record<string, unknown> = {};
  for (const beach of BEACHES) {
    const station = beach.stations.waveHeight;
    if (station) readings[station.id] = { waveHeight: { value, observedAt } };
  }
  const { pk, sk } = OCEAN_STATE.readings;
  await state.putState(
    pk,
    sk,
    { readings, receivedAt: {} } as never,
    Date.parse(observedAt),
  );
}

// collect-catalog 사진 확인 기록(BRD-58). url을 주지 않으면 그 해변의 지금 사진 주소로 넣음
export async function seedPhotoChecks(
  state: StateStore,
  checks: Record<string, { status: string; url?: string }>,
) {
  const beaches: Record<string, unknown> = {};
  for (const [beachId, check] of Object.entries(checks)) {
    const beach = BEACHES.find((b) => b.id === beachId);
    beaches[beachId] = {
      status: check.status,
      url: check.url ?? beach?.photo?.url ?? "",
      checkedAt: CONFIRMED,
    };
  }
  await state.putState("catalog", "photos", { beaches } as never, 1);
}
