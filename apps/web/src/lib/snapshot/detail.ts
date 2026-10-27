import type {
  NearbyWarningItem,
  NearbyWarningType,
  WarningItem,
} from "@baradun/contracts";

import { CLOCK_TOLERANCE_MS, isExpired, isTime } from "./clock";
import {
  hidesLastValues,
  includes,
  isRecord,
  WARNING_LEVELS,
  WARNING_TYPES,
  WARNING_CONFIRM_VALID_MS,
  type BeachView,
  type ViewSource,
} from "./view";

// 장소 상세에만 쓰는 값 (BRD-32 · 노션 2장 DET, 계약 6.3). 분류는 deriveBeachView 결과를 그대로 씀(G1).
// 여기서는 게시된 칸을 읽을 수 있는지 확인해서 꺼내기만 함. 읽을 수 없는 항목은 지어내지 않고 뺌

export const NEARBY_WARNING_TYPES = [
  "heavy_rain",
  "heat_wave",
  "cold_wave",
  "heavy_snow",
  "dry",
  "yellow_dust",
  "tropical_night",
] as const satisfies readonly NearbyWarningType[];

// 근거 한 줄(범위 → 기관 → 시각). 계약 Reason의 scope·source·at
export type Basis = {
  code: "warning" | "warning_unknown" | "observation_delayed";
  scope: string | null;
  source: string | null;
  at: string | null;
};

export type DetailInfo = {
  // 발효 중 특보(이용불가일 때만). 판단 카드 결론·사유 상자·특보 상세 시트에 씀
  warnings: WarningItem[];
  // 읽을 수 없는(모르는 종류·형식) 발효 특보 수. 숨기지 않고 '내용을 읽지 못했어요'로 보임(9.1 모르는 데이터)
  unreadableWarnings: number;
  // 지금 받은 정보의 사유 근거. B5(stale)면 비움 → 'HH:MM 확인 · 이후 확인 못 함'만
  basis: Basis[];
  // 특보 확인 기관(예: 기상청). '특보 없음' 근거 줄에 씀
  warningSource: string | null;
  // '확인한 것'의 특보 칸을 '없음'으로 보일 수 있는지: 지금 받은 정보에서 state none·항목 없음·기관·
  // 확인 시각이 있고 45분 안. 관측 지연(판단불가) 해변도 특보는 확인됐을 수 있어 따로 봄. 아니면 '확인 못 함'
  warningConfirmedNone: boolean;
  // 운영 기간 아님 배지: true면 보임, 일정이 없거나 읽을 수 없으면 null(숨김, N4)
  offSeason: { openFrom: string; openUntil: string } | null;
  // 이안류(정보만, D5). null = 제공 해변·기간 아님(게시된 null),
  // "unknown" = 받지 못함·읽을 수 없음 → '제공 기간 아님'으로 보이지 않게 "–"
  ripCurrent: RipCurrent | null | "unknown";
  // 주변 특보(정보만, B3). 모르는 종류도 숨기지 않음(type: null → 일반 단어)
  nearbyWarnings: (Omit<NearbyWarningItem, "type"> & {
    type: NearbyWarningType | null;
  })[];
  // 읽을 수 없는 주변 특보 수(모르는 단계·형식). "all" = 목록 자체를 읽을 수 없음.
  // 버리면 '주변 특보 없음'과 같아 보여서 숨기지 않고 화면에 알림(9.1 모르는 데이터)
  unreadableNearby: number | "all";
};

export type RipCurrent = { label: string; publishedAt: string; source: string };

const EMPTY: DetailInfo = {
  warnings: [],
  unreadableWarnings: 0,
  basis: [],
  warningSource: null,
  warningConfirmedNone: false,
  offSeason: null,
  ripCurrent: "unknown",
  nearbyWarnings: [],
  unreadableNearby: 0,
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// 특보 항목 하나. 지진해일만 구역 코드 null 허용(10/22)
function readWarningItem(value: unknown): WarningItem | null {
  if (
    !isRecord(value) ||
    !includes(WARNING_TYPES, value.type) ||
    !includes(WARNING_LEVELS, value.level) ||
    text(value.zoneName) === null ||
    !(
      typeof value.zoneCode === "string" ||
      (value.zoneCode === null && value.type === "tsunami")
    ) ||
    !isTime(value.publishedAt) ||
    !isTime(value.effectiveFrom)
  ) {
    return null;
  }
  return value as unknown as WarningItem;
}

function readNearby(
  value: unknown,
): DetailInfo["nearbyWarnings"][number] | null {
  if (
    !isRecord(value) ||
    !includes(WARNING_LEVELS, value.level) ||
    text(value.zoneName) === null ||
    typeof value.zoneCode !== "string" ||
    !isTime(value.publishedAt) ||
    !isTime(value.effectiveFrom)
  ) {
    return null;
  }
  return {
    type: includes(NEARBY_WARNING_TYPES, value.type) ? value.type : null,
    level: value.level,
    zoneCode: value.zoneCode,
    zoneName: value.zoneName as string,
    publishedAt: value.publishedAt,
    effectiveFrom: value.effectiveFrom,
  };
}

function readBasis(value: unknown, nowMs: number): Basis | null {
  if (!isRecord(value)) return null;
  const code = value.code;
  if (
    code !== "warning" &&
    code !== "warning_unknown" &&
    code !== "observation_delayed"
  ) {
    return null;
  }
  // 미래 시각은 근거로 쓰지 않음(view.ts isFuture와 같은 2분 여유)
  const at =
    isTime(value.at) && Date.parse(value.at) <= nowMs + CLOCK_TOLERANCE_MS
      ? value.at
      : null;
  return { code, scope: text(value.scope), source: text(value.source), at };
}

// 해변 특보 확인 기관(status warning.source). 대안 해변 근거 줄처럼 기관만 필요할 때 상세 전체를 계산하지 않게
export function warningSourceOf(
  beachId: string,
  source: Pick<ViewSource, "statuses">,
): string | null {
  const status = source.statuses?.[beachId];
  return isRecord(status) && isRecord(status.warning)
    ? text(status.warning.source)
    : null;
}

export function deriveDetail(
  beachId: string,
  view: BeachView,
  source: ViewSource,
): DetailInfo {
  if (view.kind !== "ready" || hidesLastValues(source.phase)) return EMPTY;
  const status = source.statuses?.[beachId];
  if (!isRecord(status)) return EMPTY;
  const warning = isRecord(status.warning) ? status.warning : {};
  const info = isRecord(status.info) ? status.info : {};

  // 이용불가로 보일 때만 특보 항목(B5로 유지된 배지 포함). 읽을 수 없는 항목은 이름을 지어내지 않고
  // 개수만 남김 → 사유 상자에 '내용을 읽지 못했어요'. 결론 문장은 배지(첫 사유)를 씀
  // 목록 자체를 읽을 수 없으면 읽지 못한 항목 하나로 셈(사유 상자가 비어 특보가 사라지지 않게)
  const items =
    view.category !== "unavailable"
      ? []
      : Array.isArray(warning.items)
        ? warning.items.map(readWarningItem)
        : [null];
  const warnings = items.filter((item) => item !== null);
  const unreadableWarnings = items.length - warnings.length;

  const basis =
    !view.stale && view.category !== "clear" && Array.isArray(status.reasons)
      ? status.reasons.flatMap((reason) => {
          const read = readBasis(reason, source.nowMs);
          return read ? [read] : [];
        })
      : [];

  const season = isRecord(info.season) ? info.season : null;
  const offSeason =
    season &&
    season.inSeason === false &&
    typeof season.openFrom === "string" &&
    DATE.test(season.openFrom) &&
    typeof season.openUntil === "string" &&
    DATE.test(season.openUntil)
      ? { openFrom: season.openFrom, openUntil: season.openUntil }
      : null;

  const rip = isRecord(info.ripCurrent) ? info.ripCurrent : null;
  const ripLabel = text(rip?.label);
  const ripSource = text(rip?.source);
  const ripCurrent: DetailInfo["ripCurrent"] =
    info.ripCurrent === null
      ? null
      : rip && ripLabel && ripSource && isTime(rip.publishedAt)
        ? { label: ripLabel, publishedAt: rip.publishedAt, source: ripSource }
        : "unknown";

  const nearbyRead = Array.isArray(info.nearbyWarnings)
    ? info.nearbyWarnings.map(readNearby)
    : null;
  const nearbyWarnings = (nearbyRead ?? []).filter((item) => item !== null);
  const unreadableNearby =
    nearbyRead === null ? "all" : nearbyRead.length - nearbyWarnings.length;

  const confirmedAt = isTime(warning.lastConfirmedAt)
    ? Date.parse(warning.lastConfirmedAt)
    : NaN;
  const warningConfirmedNone =
    !view.stale &&
    view.category !== "unavailable" &&
    // 판단불가는 사유가 모두 관측 지연일 때만(모르는 사유는 특보 확인 실패일 수 있어 '없음'으로 보이지 않게)
    (view.category === "clear" ||
      view.reasons.every((reason) => reason.kind === "observation_delayed")) &&
    warning.state === "none" &&
    Array.isArray(warning.items) &&
    warning.items.length === 0 &&
    text(warning.source) !== null &&
    confirmedAt <= source.nowMs + CLOCK_TOLERANCE_MS &&
    !isExpired(
      new Date(confirmedAt + WARNING_CONFIRM_VALID_MS).toISOString(),
      source.nowMs,
      source.clock,
    );

  return {
    warnings,
    unreadableWarnings,
    basis,
    warningSource: text(warning.source),
    warningConfirmedNone,
    offSeason,
    ripCurrent,
    nearbyWarnings,
    unreadableNearby,
  };
}
