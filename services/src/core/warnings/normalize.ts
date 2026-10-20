import type { WarningLevel } from "@baradun/contracts";
import {
  pwnAction,
  warningKind,
  warningLevel,
  type PwnAction,
  type WarningKind,
} from "./codes";
import { parseKstTime } from "./time";

// getPwnCd 원본 행. 값은 모두 문자열(BRD-16 픽스처)
// stnId(발표 관서)는 응답에 있을 때만 옴 → 선택 항목
export type PwnCdRow = {
  tmFc: string;
  tmSeq: string;
  areaCode: string;
  areaName: string;
  warnVar: string;
  warnStress: string;
  command: string;
  cancel: string;
  startTime: string;
  endTime: string;
  allEndTime: string;
  stnId?: string;
};

// 구역: S1… 바다, L1… 육상(아키텍처 4장). 그 밖의 코드는 원문만 보관
export type Zone =
  | { kind: "code"; code: string; scope: "sea" | "land" }
  | { kind: "unknown"; raw: string };

// 정규화된 특보 이벤트. 해석하지 못한 항목은 null + unknownReasons("항목:원문")에 남김
export type PwnEvent = {
  source: "getPwnCd";
  agency: "기상청";
  stationId: string | null;
  publishedAt: string | null; // tmFc
  seq: number | null; // tmSeq. 달마다 1부터 다시 시작
  action: PwnAction | null;
  cancelled: boolean; // cancel "1" = 취소된 발표(지역 전체 해제와 다름)
  kind: WarningKind;
  level: WarningLevel | null;
  zone: Zone;
  effectiveFrom: string | null; // 발표류 startTime, 해제류 endTime
  unknownReasons: string[];
  raw: PwnCdRow; // allEndTime 등 해석하지 않는 값은 여기에만 둠
};

const ZONE_PATTERN = /^(S1|L1)\d+$/;

export function parseZone(areaCode: string): Zone {
  const match = ZONE_PATTERN.exec(areaCode);
  if (!match) return { kind: "unknown", raw: areaCode };
  return {
    kind: "code",
    code: areaCode,
    scope: match[1] === "S1" ? "sea" : "land",
  };
}

// 해제 이벤트는 endTime, 그 밖(발표·연장·변경발표)은 startTime이 발효 시각
// 정정(6)은 대상이 불명 → 시각을 해석하지 않음(원문은 raw에 있음)
function effectiveField(action: PwnAction): "startTime" | "endTime" | null {
  if (action === "release" || action === "change_release") return "endTime";
  if (action === "correct") return null;
  return "startTime";
}

export function normalizePwnCdRow(row: PwnCdRow): PwnEvent {
  const reasons: string[] = [];

  const published = parseKstTime(row.tmFc);
  const publishedAt = published.kind === "time" ? published.iso : null;
  if (!publishedAt) reasons.push(`tmFc:${row.tmFc}`);

  const seq = /^\d+$/.test(row.tmSeq) ? Number(row.tmSeq) : null;
  if (seq === null) reasons.push(`tmSeq:${row.tmSeq}`);

  const action = pwnAction(row.command);
  if (!action) reasons.push(`command:${row.command}`);

  if (row.cancel !== "0" && row.cancel !== "1") {
    reasons.push(`cancel:${row.cancel}`);
  }

  const kind = warningKind(row.warnVar);
  if (kind.group === "unknown") reasons.push(`warnVar:${row.warnVar}`);

  const level = warningLevel(row.warnStress);
  if (!level) reasons.push(`warnStress:${row.warnStress}`);

  const zone = parseZone(row.areaCode);
  if (zone.kind === "unknown") reasons.push(`zone:${row.areaCode}`);

  // 발효 시각이 필요한 동작인데 값이 없거나 잘못되면 사유로 남김
  let effectiveFrom: string | null = null;
  const field = action && effectiveField(action);
  if (field) {
    const parsed = parseKstTime(row[field]);
    if (parsed.kind === "time") effectiveFrom = parsed.iso;
    else reasons.push(`${field}:${row[field]}`);
  }

  return {
    source: "getPwnCd",
    agency: "기상청",
    stationId: row.stnId || null, // 없거나 빈 값이면 null
    publishedAt,
    seq,
    action,
    cancelled: row.cancel === "1",
    kind,
    level,
    zone,
    effectiveFrom,
    unknownReasons: reasons,
    raw: row,
  };
}
