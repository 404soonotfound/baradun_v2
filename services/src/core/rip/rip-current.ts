import type { BeachStatus } from "@baradun/contracts";
import {
  formatUtcIso,
  KST_OFFSET_MS,
  parseKstTime,
  parseUtcIso,
} from "../warnings/time";

// 이안류 지수 (아키텍처 5장 collect-rip, 결정 기록 D5·10장, BRD-57 2026-10-26 사용자 결정)
// 출처: 국립해양조사원_이안류 지수 조회(data.go.kr 15156028) GetRipCurrentApiService
// 정보 표시만. 해변 분류(이용불가·판단불가)에 쓰지 않음(G1)
// 모르는 값·형식은 숨김: 틀린 정보를 보여주느니 안 보여줌

export const RIP_SOURCE = "국립해양조사원";
// 공식 4단계(활용가이드: 관심·주의·경계·위험). 이 밖의 문구는 게시하지 않음
export const RIP_LABELS = ["관심", "주의", "경계", "위험"] as const;
// 제공 기간(활용가이드: 매년 6~9월, 10~5월은 서비스 없음). 한국 시각 기준 달
export const RIP_SEASON_MONTHS = [6, 7, 8, 9] as const;

// 공개 계약 status.info.ripCurrent의 값(null 아님)
export type RipCurrent = NonNullable<BeachStatus["info"]["ripCurrent"]>;

// 해변 하나의 마지막 정상 관측(State에 그대로 넣는 모양)
export interface RipReading {
  readonly code: string; // API 해수욕장 코드(obsvtrId)
  readonly label: string; // lastScrCn 원문. 4단계가 아니어도 저장하고 게시 때 거름
  readonly observedAt: string; // UTC ISO
}

// ok: 쓸 수 있는 관측이 있음. none: 정상 응답인데 자료 없음(비수기 등). failed: 응답을 믿을 수 없음
// skippedRows: 시각·코드를 읽지 못해 버린 줄 수(운영 알림용)
export type RipResponse =
  | { status: "ok"; latest: RipReading; skippedRows: number }
  | { status: "none" }
  | { status: "failed"; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// "2026-08-15 00:05" → UTC ISO. 응답에 시간대 표기가 없어 KST로 추정함(BRD-57 결정, 2027 시즌 실응답으로 확인 예정)
// 형식이 다르거나 달력에 없는 시각이면 null
export function ripObservedAt(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const time = parseKstTime(match.slice(1).join(""));
  return time.kind === "time" ? time.iso : null;
}

// 응답 본문 읽기. 실응답(2026-10-26 확인) 모양: 최상위 { header, body: { items: { item: [...] }, totalCount } }
// 활용가이드 XML 예시의 <response> 감싸개는 JSON 응답에 없음 → 감싸개가 있거나 header·body가 없으면 형식 오류
// 200인데 이 모양이 아니면 '자료 없음'이 아니라 실패(빈 응답을 정상으로 보지 않음)
// 자료 없음은 resultCode 03(공공데이터포털 NODATA) 또는 00 + totalCount 0일 때만
// 줄마다 코드가 요청한 해변과 같고 시각을 읽을 수 있어야 씀. 미래 관측은 버림(허용 오차 없음)
// 요청한 날(reqDate, yyyymmdd)이 아닌 줄도 버림: 다른 날 자료를 오늘 자료로 보지 않음
// totalCount가 numOfRows보다 크면 한 쪽에 다 받지 못해 마지막 관측이 빠졌을 수 있음 → 실패
export function parseRipResponse(
  text: string,
  code: string,
  now: string,
  reqDate: string,
): RipResponse {
  const nowMs = parseUtcIso(now);
  if (nowMs === null) throw new RangeError(`기준 시각 형식 오류: ${now}`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { status: "failed", reason: "format:json" };
  }
  if (!isObject(json) || !isObject(json.header) || !isObject(json.body)) {
    return { status: "failed", reason: "format:shape" };
  }
  const resultCode = json.header.resultCode;
  if (resultCode === "03") return { status: "none" };
  if (resultCode !== "00") {
    return { status: "failed", reason: `result:${String(resultCode)}` };
  }
  const { items, totalCount, numOfRows } = json.body;
  if (totalCount === 0 && (items === "" || items === undefined)) {
    return { status: "none" };
  }
  if (
    typeof totalCount === "number" &&
    typeof numOfRows === "number" &&
    totalCount > numOfRows
  ) {
    return { status: "failed", reason: `truncated:${totalCount}` };
  }
  const day = `${reqDate.slice(0, 4)}-${reqDate.slice(4, 6)}-${reqDate.slice(6, 8)} `;
  const item = isObject(items) ? items.item : undefined;
  const rows = Array.isArray(item) ? item : isObject(item) ? [item] : null;
  if (rows === null || rows.length === 0) {
    return { status: "failed", reason: "format:items" };
  }

  let latest: RipReading | null = null;
  let latestMs = -Infinity;
  let skippedRows = 0;
  for (const row of rows) {
    const observedAt = isObject(row) ? ripObservedAt(row.obsrvnDt) : null;
    const observedMs = observedAt === null ? null : parseUtcIso(observedAt);
    if (
      !isObject(row) ||
      row.obsvtrId !== code ||
      typeof row.lastScrCn !== "string" ||
      observedMs === null ||
      !(row.obsrvnDt as string).startsWith(day) ||
      observedMs > nowMs
    ) {
      skippedRows += 1;
      continue;
    }
    if (observedMs > latestMs) {
      latestMs = observedMs;
      latest = { code, label: row.lastScrCn.trim(), observedAt: observedAt! };
    }
  }
  // 줄은 있는데 쓸 줄이 하나도 없음 → 형식이 바뀐 응답일 수 있어 정상으로 치지 않음
  if (latest === null) {
    return { status: "failed", reason: `no_rows:skipped=${skippedRows}` };
  }
  return { status: "ok", latest, skippedRows };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// UTC ms → KST 날짜 번호(1970-01-01부터 센 날 수). 날짜 차이 계산용
function kstDayNumber(ms: number): number {
  return Math.floor((ms + KST_OFFSET_MS) / DAY_MS);
}

// 한국 시각 기준 달이 제공 기간(6~9월)인지. collect-rip 호출 일정과 게시 규칙이 같이 씀
export function inRipSeason(ms: number): boolean {
  const month = new Date(ms + KST_OFFSET_MS).getUTCMonth() + 1;
  return (RIP_SEASON_MONTHS as readonly number[]).includes(month);
}

// 게시하지 않는 이유. unknown_label·bad_time은 운영 알림(warn) 대상, 나머지는 정상적인 숨김
export type RipHidden =
  "no_reading" | "unknown_label" | "bad_time" | "off_season" | "old";

// 게시할 이안류 정보. 만료 기준은 정하지 않음(갱신 간격이 문서에 없어 임계값을 지어내지 않음, BRD-57 후속 이슈에서 확정)
// 대신 관측일 기준으로 거름: 관측일(KST)이 제공 기간(6~9월) 밖이거나, 게시일(KST)의 오늘·어제가 아니면 숨김
// (API가 지난 날짜도 돌려주므로 오래된 값이 '지금 값'처럼 보이지 않게 함)
// 문구 검사는 시각 검사 뒤: 지난 시즌에 남은 모르는 문구가 비수기 내내 게시마다 운영 알림을 내지 않게 함
export function ripCurrentInfo(
  reading: RipReading | undefined,
  now: string,
): { info: RipCurrent | null; hidden: RipHidden | null } {
  const nowMs = parseUtcIso(now);
  if (nowMs === null) throw new RangeError(`기준 시각 형식 오류: ${now}`);
  if (reading === undefined) return { info: null, hidden: "no_reading" };
  const observedMs = parseUtcIso(reading.observedAt);
  if (observedMs === null || observedMs > nowMs) {
    return { info: null, hidden: "bad_time" };
  }
  if (!inRipSeason(observedMs)) {
    return { info: null, hidden: "off_season" };
  }
  if (kstDayNumber(nowMs) - kstDayNumber(observedMs) > 1) {
    return { info: null, hidden: "old" };
  }
  if (!(RIP_LABELS as readonly string[]).includes(reading.label)) {
    return { info: null, hidden: "unknown_label" };
  }
  return {
    info: {
      label: reading.label,
      publishedAt: formatUtcIso(observedMs),
      source: RIP_SOURCE,
    },
    hidden: null,
  };
}

// 저장된 값 → 해변별 관측. 모양이 틀린 해변 하나는 그 해변만 버림(게시 때 null)
export function readRipReadings(value: unknown): Record<string, RipReading> {
  const beaches = isObject(value) ? value.beaches : undefined;
  if (!isObject(beaches)) return {};
  const readings: Record<string, RipReading> = {};
  for (const [beachId, entry] of Object.entries(beaches)) {
    if (
      isObject(entry) &&
      typeof entry.code === "string" &&
      typeof entry.label === "string" &&
      typeof entry.observedAt === "string"
    ) {
      readings[beachId] = {
        code: entry.code,
        label: entry.label,
        observedAt: entry.observedAt,
      };
    }
  }
  return readings;
}
