import type { BeachStatus } from "@baradun/contracts";
import { parseUtcIso } from "../core/warnings/time";

// 운영 기간 (info.season, 결정 기록 11장 '운영 기간 데이터 확정(10/23)', BRD-20·BRD-61)
// 원본은 data/beach-meta.json(공개 계약 밖, 해변 id로 연결). 게시 시각의 한국 날짜와 올해 일정을 비교함
// 정보 배지일 뿐 분류에 쓰지 않음(B3)
// null(배지 숨김): 올해 일정 없음·미연결·미개장(closed, 10/23 A안)·날짜를 읽지 못함
// 지난해 일정으로 추정하지 않음(10/21 ⑥)

export type Season = BeachStatus["info"]["season"];

// 해변 하나의 한 해 일정. beach-meta.json의 season["2026"] 모양
export interface SeasonEntry {
  readonly status: "open" | "closed";
  readonly openDate: string | null;
  readonly closeDate: string | null;
}

// 해변 id → 연도("2026") → 일정(미연결이면 null)
export type SeasonTable = Readonly<
  Record<string, Readonly<Record<string, SeasonEntry | null>>>
>;

export interface ParsedBeachMeta {
  readonly seasons: SeasonTable;
  // 모양이 틀려 버린 해변 id. 그 해변은 배지를 숨김(로그로 알림)
  readonly invalid: readonly string[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR = /^\d{4}$/;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 달력에 있는 날짜(YYYY-MM-DD)인지
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  return parseUtcIso(`${value}T00:00:00Z`) !== null;
}

function parseEntry(value: unknown): SeasonEntry | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const { status, openDate, closeDate } = value;
  if (status !== "open" && status !== "closed") return undefined;
  const dateOrNull = (d: unknown) => d === null || isCalendarDate(d);
  if (!dateOrNull(openDate) || !dateOrNull(closeDate)) return undefined;
  return {
    status,
    openDate: openDate as string | null,
    closeDate: closeDate as string | null,
  };
}

// beach-meta.json → 운영 기간 표. 해변 하나의 모양이 틀리면 그 해변만 빼고 invalid에 적음
// 파일 전체 모양(beaches 칸)이 틀리면 던짐(빈 표로 바꾸지 않음)
export function parseBeachMeta(json: unknown): ParsedBeachMeta {
  const beaches = isObject(json) ? json.beaches : undefined;
  if (!isObject(beaches)) {
    throw new RangeError("beach-meta.json: beaches 칸이 없음");
  }
  const seasons: Record<string, Record<string, SeasonEntry | null>> = {};
  const invalid: string[] = [];
  for (const [id, meta] of Object.entries(beaches)) {
    if (!isObject(meta)) {
      invalid.push(id);
      continue;
    }
    if (meta.season === undefined || meta.season === null) continue;
    if (!isObject(meta.season)) {
      invalid.push(id);
      continue;
    }
    const years: Record<string, SeasonEntry | null> = {};
    let ok = true;
    for (const [year, raw] of Object.entries(meta.season)) {
      const entry = parseEntry(raw);
      if (!YEAR.test(year) || entry === undefined) {
        ok = false;
        break;
      }
      years[year] = entry;
    }
    if (ok) seasons[id] = years;
    else invalid.push(id);
  }
  return { seasons, invalid };
}

// UTC ISO 시각 → 한국 날짜 YYYY-MM-DD
export function kstDate(nowIso: string): string {
  const ms = parseUtcIso(nowIso);
  if (ms === null) throw new RangeError(`기준 시각 형식 오류: ${nowIso}`);
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// 게시할 info.season. 올해(한국 날짜 기준) 개장 일정이 온전할 때만 값이 있음
// 시작일 ≤ 오늘 ≤ 종료일이면 inSeason true(종료일 당일 포함)
export function seasonInfo(
  table: SeasonTable,
  beachId: string,
  nowIso: string,
): Season {
  const today = kstDate(nowIso);
  const entry = table[beachId]?.[today.slice(0, 4)];
  if (!entry || entry.status !== "open") return null;
  const { openDate, closeDate } = entry;
  if (openDate === null || closeDate === null || openDate > closeDate) {
    return null;
  }
  return {
    openFrom: openDate,
    openUntil: closeDate,
    inSeason: openDate <= today && today <= closeDate,
  };
}
