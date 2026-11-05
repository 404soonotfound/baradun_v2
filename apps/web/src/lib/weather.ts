import type {
  MidLandForecast,
  MidTaForecast,
  WeatherPoint,
  WeatherShort,
} from "@baradun/contracts";

// 상세 날씨 카드 모델 (BRD-185 · 결정 기록 18장 D18-1·D18-2·D18-9, 노션 3장 WeatherCard)
// 받은 값을 칸으로 나누기만 함. 하루 한 칸 고르기·오래된 값 거르기는 publisher가 이미 함(다시 계산하지 않음)
// 값이 없는 칸은 null 그대로 둠: 화면이 '–'로 그리고 0·맑음으로 바꾸지 않음

const KST_OFFSET_MS = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

// ms → 한국 날짜(YYYY-MM-DD)·시(0~23)
export function kstDay(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}
function kstHour(ms: number): number {
  return new Date(ms + KST_OFFSET_MS).getUTCHours();
}
// 두 한국 날짜 사이 날 수(b − a)
function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS,
  );
}
// '11/7' (앞 0 없음, 한국어·영어 같은 꼴)
export function monthDay(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

// 하늘 그림. 강수가 있으면 강수 그림, 없으면 하늘. 밤(18~05시)에는 해 대신 달
// 모르는 값·값 없음은 unknown(맑음으로 그리지 않음)
export type SkyIcon =
  | "sun"
  | "moon"
  | "cloudSun"
  | "cloudMoon"
  | "cloud"
  | "rain"
  | "shower"
  | "snow"
  | "rainSnow"
  | "unknown";

// 문구 키(weather.sky.*)와 같은 이름
export type SkyWord =
  "clear" | "mostlyCloudy" | "cloudy" | "rain" | "shower" | "snow" | "rainSnow";

const PRECIP = new Set(["rain", "shower", "snow", "rainSnow"]);
const SKY = new Set(["clear", "mostlyCloudy", "cloudy"]);

export function skyWord(
  sky: string | null,
  precip: string | null,
): SkyWord | null {
  if (precip !== null && PRECIP.has(precip)) return precip as SkyWord;
  // 강수 값이 없거나(null) 모르는 글자면 하늘로 대신하지 않음(비가 오는데 맑음으로 보일 수 있음)
  // publisher는 PTY가 빠지면 precip null로 게시함 → '강수 없음'이 확인된 칸만 하늘 값을 씀
  if (precip !== "none") return null;
  return sky !== null && SKY.has(sky) ? (sky as SkyWord) : null;
}

export function skyIcon(word: SkyWord | null, night: boolean): SkyIcon {
  switch (word) {
    case "clear":
      return night ? "moon" : "sun";
    case "mostlyCloudy":
      return night ? "cloudMoon" : "cloudSun";
    case "cloudy":
      return "cloud";
    case null:
      return "unknown";
    default:
      return word;
  }
}

export interface HourCell {
  at: string;
  hour: number; // 한국 시(0~21, 3시간 간격)
  day: 0 | 1 | 2; // 오늘·내일·모레
  dayStart: boolean; // 날이 시작되는 칸(첫 칸 포함) → 날 이름·세로 줄
  date: string; // YYYY-MM-DD (한국)
  word: SkyWord | null;
  icon: SkyIcon;
  temperature: number | null;
  pop: number | null;
  windTo: number | null; // 바람이 불어가는 쪽(도) = 불어오는 쪽 + 180°
  windSpeed: number | null;
}

// 시간 줄: 지금 다음 칸부터 모레 21시까지(계약 points는 오늘~모레 3시간 간격)
export function hourCells(
  points: readonly WeatherPoint[],
  nowMs: number,
): HourCell[] {
  const today = kstDay(nowMs);
  const cells: HourCell[] = [];
  for (const point of points) {
    const atMs = Date.parse(point.at);
    if (!Number.isFinite(atMs) || atMs <= nowMs) continue;
    const date = kstDay(atMs);
    const day = daysBetween(today, date);
    if (day < 0 || day > 2) continue;
    const hour = kstHour(atMs);
    const word = skyWord(point.sky, point.precip);
    cells.push({
      at: point.at,
      hour,
      day: day as 0 | 1 | 2,
      dayStart: cells.length === 0 || cells.at(-1)!.date !== date,
      date,
      word,
      icon: skyIcon(word, hour >= 18 || hour < 6),
      temperature: point.temperature,
      pop: point.pop,
      windTo: point.windFrom === null ? null : (point.windFrom + 180) % 360,
      windSpeed: point.windSpeed,
    });
  }
  return cells;
}

export interface DayCell {
  date: string;
  source: "short" | "mid";
  word: SkyWord | null;
  icon: SkyIcon;
  pop: number | null;
  min: number | null;
  max: number | null;
}

// 펼친 곳: 글피(단기예보 하루 한 칸) + 중기예보(그 뒤 3일). 모두 합쳐 최대 4일
// midFailed: 중기 구역·기온 지점 값이 없거나, 단기 다음 날짜 칸에 받은 값이 하나도 없음 → '이후 날씨를 확인하지 못했어요'
export function laterDays(
  short: WeatherShort,
  midLand: MidLandForecast | null,
  midTa: MidTaForecast | null,
  nowMs: number,
): { days: DayCell[]; midFailed: boolean } {
  const today = kstDay(nowMs);
  const days: DayCell[] = short.days
    .filter((d) => daysBetween(today, d.date) > 2)
    .slice(0, 1)
    .map((d) => {
      const word = skyWord(d.sky, d.precip);
      return {
        date: d.date,
        source: "short" as const,
        word,
        icon: skyIcon(word, false),
        pop: d.pop,
        min: d.min,
        max: d.max,
      };
    });
  const after = days.at(-1)?.date ?? today;
  const ta = new Map((midTa?.days ?? []).map((d) => [d.date, d]));
  const mid: DayCell[] = (midLand?.days ?? [])
    .filter((d) => d.date > after && daysBetween(today, d.date) > 2)
    .map((d) => {
      const word = skyWord(d.sky, d.precip);
      const t = ta.get(d.date);
      return {
        date: d.date,
        source: "mid" as const,
        word,
        icon: skyIcon(word, false),
        pop: d.pop,
        min: t?.min ?? null,
        max: t?.max ?? null,
      };
    });
  // 구역(하늘·강수확률)과 기온 지점(최저·최고)을 따로 봄. 둘 중 하나라도 받은 날이 없으면 중기예보를 못 받은 것
  // publisher는 기온 수집만 실패해도 날짜별 값이 모두 null인 기온 지점을 게시함(그 경우도 안내)
  const landReceived = mid.some((d) => d.word !== null || d.pop !== null);
  const taReceived = mid.some((d) => d.min !== null || d.max !== null);
  const midFailed =
    midLand === null || midTa === null || !landReceived || !taReceived;
  return {
    days: [...days, ...(midFailed ? [] : mid)].slice(0, 4),
    midFailed,
  };
}

// 중기예보 발표 시각(받은 날 중 가장 늦은 것). 정보 출처 줄용
export function midIssuedAt(midLand: MidLandForecast | null): string | null {
  let best: string | null = null;
  for (const day of midLand?.days ?? []) {
    if (day.issuedAt && (best === null || day.issuedAt > best)) {
      best = day.issuedAt;
    }
  }
  return best;
}
