import { KST_OFFSET_MS, formatUtcIso, parseKstTime } from "../warnings/time";

// 기상청 날씨 예보 응답 해석 (BRD-181, 결정 기록 18장 D18-1·D18-8·D18-9, 데이터 출처 문서 14장)
// 단기예보 getVilageFcst · 초단기실황 getUltraSrtNcst · 중기예보 getMidLandFcst·getMidTa (공공데이터포털, dataType JSON)
// 날씨는 참고 정보. 분류·관측 지연·대안 해변에 쓰지 않음(G1)
// 받지 못한 값·범위 밖 값은 null로 남김. 0·맑음·빈 배열로 채우지 않음
// 응답이 요청과 다른 발표 시각·격자·구역이면 실패(다른 곳 값을 이 곳 값으로 쓰지 않음)
// 단기예보의 파고 예보(WAV)·강수량(PCP)·적설(SNO)·습도(REH)·바람 성분(UUU·VVV)은 받지 않음(D18-8 ④, 화면에 쓰지 않음)

export type Parsed<T> =
  { status: "ok"; value: T } | { status: "failed"; reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// 응답 껍데기 → 행 목록. resultCode 00이고 행이 있어야 정상. 받은 행이 totalCount보다 적으면 잘린 응답
export function parseEnvelope(body: string): Parsed<unknown[]> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    // 키 오류 등은 XML로 옴
    return { status: "failed", reason: "not_json" };
  }
  const response = isObject(json) ? json.response : undefined;
  const header = isObject(response) ? response.header : undefined;
  const code = isObject(header) ? header.resultCode : undefined;
  if (code !== "00") {
    return {
      status: "failed",
      reason: `result:${typeof code === "string" ? code : "missing"}`,
    };
  }
  const resBody = isObject(response) ? response.body : undefined;
  const items = isObject(resBody) ? resBody.items : undefined;
  const raw = isObject(items) ? items.item : undefined;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  if (list.length === 0) return { status: "failed", reason: "no_rows" };
  const total = isObject(resBody) ? Number(resBody.totalCount) : NaN;
  if (Number.isFinite(total) && total > list.length) {
    return { status: "failed", reason: `truncated:${list.length}/${total}` };
  }
  return { status: "ok", value: list };
}

// 같은 실행 안에서 한 번 더 받아 볼 실패(BRD-186). 기상청 쪽 일시 오류와 실황 기온 없음만
// 01 응용·02 DB·04 HTTP·05 서비스 시간 초과·99 알 수 없음(활용가이드 오류 코드)
// 03(자료 없음 = 아직 발표 전)·10~12(요청 값 오류)·20~22(권한·하루 한도)·30~33(키 오류)는 다시 받아도 같거나 한도만 씀
// not_json은 넣지 않음: 키 미등록·호출 한도 초과가 XML로 옴(다시 받으면 모든 곳이 한 번씩 더 한도를 씀)
// 잘린 응답(truncated)도 넣지 않음: 행 수 설정(numOfRows)이 모자라면 늘 같게 잘림
// 전송 실패(시간 초과·http:5xx)는 HTTP 층이 이미 다시 받았으므로 넣지 않음(Lambda 60초 안)
// 2026-11-05 11:15 첫 정기 실행: 약 280건 중 01 하나(가계해수욕장 49,58 단기, 12:15에는 정상)
// no_t1h(기온 항목 없음·결측 표기 아닌 범위 밖 값)는 응답 일부가 빠진 경우 대비로 넣음. 일시적이라는 실측 근거는 아직 없음
// 그날 본 'T1H 없음'은 삼척해수욕장 98,126의 상시 결측(-999)이었고 parseNow가 t1h_missing으로 따로 나눔(다시 받지 않음)
const TRANSIENT_REASONS = new Set([
  "result:01",
  "result:02",
  "result:04",
  "result:05",
  "result:99",
  "no_t1h",
]);

export function isTransientReason(reason: string): boolean {
  return TRANSIENT_REASONS.has(reason);
}

// KST 날짜(yyyymmdd)·시각(HHMM) → UTC ms. 형식이 틀리거나 달력에 없으면 null(특보 시각 변환과 같은 함수)
export function kstToMs(date: string, time = "0000"): number | null {
  const parsed = parseKstTime(`${date}${time}`);
  return parsed.kind === "time" ? Date.parse(parsed.iso) : null;
}

// UTC ms → KST 날짜 글자(yyyy-mm-dd, 계약의 날짜 형식)
export function kstDate(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// KST 날짜 글자에 n일 더함
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

// 숫자 글자 → 숫자. 범위 밖(기상청 결측 표기 -999·900 이상 포함)·숫자 아님 → null
function num(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= min && v <= max ? v : null;
}

// 기상청 결측 표기(-998.9·-999 같은 -900 이하, 900 이상). 범위 밖 값과 달리 '값 없음'을 기상청이 알린 것
const isMissingMarker = (raw: unknown) => {
  const v = num(raw, -Infinity, Infinity);
  return v !== null && (v <= -900 || v >= 900);
};

// 항목별 허용 범위. 하늘(SKY) 1 맑음·3 구름많음·4 흐림, 강수형태(PTY) 0 없음·1 비·2 비/눈·3 눈·4 소나기
const temperature = (raw: unknown) => num(raw, -50, 50);
const codeIn = (raw: unknown, allowed: readonly number[]) => {
  const v = num(raw, -1e9, 1e9);
  return v !== null && allowed.includes(v) ? v : null;
};
const VALUE = {
  TMP: temperature,
  SKY: (raw: unknown) => codeIn(raw, [1, 3, 4]),
  PTY: (raw: unknown) => codeIn(raw, [0, 1, 2, 3, 4]),
  POP: (raw: unknown) => {
    const v = num(raw, 0, 100);
    return v !== null && Number.isInteger(v) ? v : null;
  },
  VEC: (raw: unknown) => num(raw, 0, 360),
  WSD: (raw: unknown) => num(raw, 0, 70),
} as const;
type HourCategory = keyof typeof VALUE;
// 저장하는 시간별 칸 순서. [시각(초), TMP, SKY, PTY, POP, VEC, WSD]
export const HOUR_FIELDS = ["TMP", "SKY", "PTY", "POP", "VEC", "WSD"] as const;
export type HourRow = [number, ...(number | null)[]];

// 날짜별 최저(TMN)·최고(TMX) 기온과 그 값을 준 발표 시각
export interface Extreme {
  readonly v: number | null;
  readonly issuedAt: string;
}
export interface DayExtremes {
  readonly tmn?: Extreme;
  readonly tmx?: Extreme;
}

export interface ShortForecast {
  readonly issuedAt: string; // 발표 시각(UTC ISO)
  readonly hours: HourRow[]; // 시각 순
  readonly extremes: Record<string, DayExtremes>; // KST 날짜 → 최저·최고
}

export interface Grid {
  readonly nx: number;
  readonly ny: number;
}

// 단기예보 한 격자. base: 요청한 발표 날짜·시각(KST)
export function parseShortForecast(
  body: string,
  base: { date: string; time: string },
  grid: Grid,
): Parsed<ShortForecast> {
  const env = parseEnvelope(body);
  if (env.status === "failed") return env;
  const issuedMs = kstToMs(base.date, base.time);
  if (issuedMs === null) return { status: "failed", reason: "base_format" };
  const issuedAt = formatUtcIso(issuedMs);
  const hours = new Map<number, (number | null)[]>();
  const extremes: Record<string, { tmn?: Extreme; tmx?: Extreme }> = {};
  for (const item of env.value) {
    if (!isObject(item)) return { status: "failed", reason: "item_format" };
    if (item.baseDate !== base.date || item.baseTime !== base.time) {
      return { status: "failed", reason: "base_mismatch" };
    }
    if (Number(item.nx) !== grid.nx || Number(item.ny) !== grid.ny) {
      return { status: "failed", reason: "grid_mismatch" };
    }
    const at = kstToMs(String(item.fcstDate), String(item.fcstTime));
    if (at === null) return { status: "failed", reason: "time_format" };
    const category = String(item.category);
    if (category === "TMN" || category === "TMX") {
      const day = (extremes[kstDate(at)] ??= {});
      const key = category === "TMN" ? "tmn" : "tmx";
      day[key] = { v: temperature(item.fcstValue), issuedAt };
      continue;
    }
    const index = HOUR_FIELDS.indexOf(category as HourCategory);
    if (index < 0) continue;
    const row =
      hours.get(at) ?? (HOUR_FIELDS.map(() => null) as (number | null)[]);
    row[index] = VALUE[category as HourCategory](item.fcstValue);
    hours.set(at, row);
  }
  if (hours.size === 0) return { status: "failed", reason: "no_hours" };
  const rows = [...hours.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ms, values]): HourRow => [ms / 1000, ...values]);
  return { status: "ok", value: { issuedAt, hours: rows, extremes } };
}

export interface NowObservation {
  readonly observedAt: string; // 실황 기준 시각(UTC ISO)
  readonly temperature: number;
}

// 초단기실황 한 격자의 기온(T1H, D18-8 ③). 기온이 없거나 범위 밖이면 실패
export function parseNow(
  body: string,
  base: { date: string; time: string },
  grid: Grid,
): Parsed<NowObservation> {
  const env = parseEnvelope(body);
  if (env.status === "failed") return env;
  const observedMs = kstToMs(base.date, base.time);
  if (observedMs === null) return { status: "failed", reason: "base_format" };
  for (const item of env.value) {
    if (!isObject(item)) return { status: "failed", reason: "item_format" };
    if (item.baseDate !== base.date || item.baseTime !== base.time) {
      return { status: "failed", reason: "base_mismatch" };
    }
    if (Number(item.nx) !== grid.nx || Number(item.ny) !== grid.ny) {
      return { status: "failed", reason: "grid_mismatch" };
    }
  }
  const t1h = env.value.find(
    (item) => isObject(item) && item.category === "T1H",
  ) as Record<string, unknown> | undefined;
  // 기상청이 결측으로 표시한 기온(-999·900 이상)은 받지 못한 것과 나눔: 그 격자에 실황 분석값이 없다는 뜻(BRD-186)
  // 2026-11-05 11·12시 실호출: 삼척해수욕장 격자 98,126은 모든 항목이 -998~-999, 옆 격자 97,127은 정상
  if (t1h && isMissingMarker(t1h.obsrValue)) {
    return { status: "failed", reason: "t1h_missing" };
  }
  const value = t1h ? temperature(t1h.obsrValue) : null;
  if (value === null) return { status: "failed", reason: "no_t1h" };
  return {
    status: "ok",
    value: { observedAt: formatUtcIso(observedMs), temperature: value },
  };
}

// 중기 육상 하루. 4~7일은 오전·오후, 8~10일은 하루 한 값(활용가이드). 하늘은 원문 글자 그대로(wf)
export interface MidHalf {
  readonly pop: number | null;
  readonly wf: string | null;
}
export interface MidLandDay {
  readonly issuedAt: string;
  readonly am?: MidHalf;
  readonly pm?: MidHalf;
  readonly all?: MidHalf;
}
export interface MidTaDay {
  readonly issuedAt: string;
  readonly min: number | null;
  readonly max: number | null;
}

const MID_DAYS = [4, 5, 6, 7, 8, 9, 10] as const;

function midItem(body: string, regId: string): Parsed<Record<string, unknown>> {
  const env = parseEnvelope(body);
  if (env.status === "failed") return env;
  const item = env.value.find((i) => isObject(i) && i.regId === regId);
  if (!isObject(item)) return { status: "failed", reason: "region_mismatch" };
  return { status: "ok", value: item };
}

const half = (pop: unknown, wf: unknown): MidHalf | undefined =>
  pop === undefined && wf === undefined
    ? undefined
    : {
        pop: VALUE.POP(pop),
        wf: typeof wf === "string" && wf.trim() !== "" ? wf.trim() : null,
      };

// tmFc: 요청한 발표 시각(yyyymmddHHMM, KST). 날짜 = 발표일 + n일
// 18:00 발표는 5~10일만 있음(4일 칸이 없음) → 없는 날은 넣지 않음(06:00 발표 값을 수집기가 이어 씀)
export function parseMidLand(
  body: string,
  regId: string,
  tmFc: string,
): Parsed<Record<string, MidLandDay>> {
  const item = midItem(body, regId);
  if (item.status === "failed") return item;
  const issuedMs = kstToMs(tmFc.slice(0, 8), tmFc.slice(8));
  if (issuedMs === null) return { status: "failed", reason: "tmfc_format" };
  const issuedAt = formatUtcIso(issuedMs);
  const days: Record<string, MidLandDay> = {};
  const v = item.value;
  for (const n of MID_DAYS) {
    const date = addDays(kstDate(issuedMs), n);
    // 없는 반나절은 칸을 두지 않음(저장소에 undefined를 넣지 않게)
    const halves: Partial<Record<"am" | "pm" | "all", MidHalf>> = {};
    const parts =
      n <= 7
        ? ([
            ["am", half(v[`rnSt${n}Am`], v[`wf${n}Am`])],
            ["pm", half(v[`rnSt${n}Pm`], v[`wf${n}Pm`])],
          ] as const)
        : ([["all", half(v[`rnSt${n}`], v[`wf${n}`])]] as const);
    for (const [key, value] of parts) if (value) halves[key] = value;
    if (Object.keys(halves).length === 0) continue;
    days[date] = { issuedAt, ...halves };
  }
  if (Object.keys(days).length === 0) {
    return { status: "failed", reason: "no_days" };
  }
  return { status: "ok", value: days };
}

export function parseMidTa(
  body: string,
  regId: string,
  tmFc: string,
): Parsed<Record<string, MidTaDay>> {
  const item = midItem(body, regId);
  if (item.status === "failed") return item;
  const issuedMs = kstToMs(tmFc.slice(0, 8), tmFc.slice(8));
  if (issuedMs === null) return { status: "failed", reason: "tmfc_format" };
  const issuedAt = formatUtcIso(issuedMs);
  const days: Record<string, MidTaDay> = {};
  const v = item.value;
  for (const n of MID_DAYS) {
    if (v[`taMin${n}`] === undefined && v[`taMax${n}`] === undefined) continue;
    days[addDays(kstDate(issuedMs), n)] = {
      issuedAt,
      min: temperature(v[`taMin${n}`]),
      max: temperature(v[`taMax${n}`]),
    };
  }
  if (Object.keys(days).length === 0) {
    return { status: "failed", reason: "no_days" };
  }
  return { status: "ok", value: days };
}
