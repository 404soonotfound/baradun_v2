import type {
  BeachId,
  NearbyWarningItem,
  WarningItem,
  WarningLevel,
  WarningType,
} from "@baradun/contracts";
import { checkConfirmation } from "./confirmation";
import type { PwnEvent } from "./normalize";
import { applyZoneStates, type ZoneWarningState } from "./zone-state";

// getPwnCd 구역별 상태 → 해변별 특보 상태 (아키텍처 2.1·2.2, 결정 기록 11장 10/22 ②③④)
// 지진해일(getTsunamiMsg)은 tsunami-match에서 따로 붙임. 분류(이용불가·판단불가)는 BRD-21

// 해변 입력. 스쿠버 포인트는 육상 구역이 없을 수 있음(계약 SeaWarningZones)
export type BeachZones = {
  id: BeachId;
  warningZones: { sea: string; land?: string };
};

// 공식 구역표: 코드 → 공식 이름. 별표5 앞바다 S1, 별표9 육상 L1
// 화면 구역 이름은 응답 areaName이 아니라 이 표 기준(아키텍처 4장 10/20)
export type ZoneTables = {
  sea: Readonly<Record<string, string>>;
  land: Readonly<Record<string, string>>;
};

// 해변 하나의 특보 상태. active가 있으면 다른 사유가 있어도 active(이용불가가 이김)
export type BeachWarning = {
  state: "active" | "none" | "unknown";
  items: WarningItem[]; // 발효 중인 5종
  nearby: NearbyWarningItem[]; // 발효 중인 주변 특보. 분류에 영향 없음
  reasons: string[]; // '없음'을 확인하지 못한 사유. active여도 남김
};

export type BeachWarningsResult = {
  beaches: Record<BeachId, BeachWarning>;
  unknownZones: string[]; // S1·L1 형식이 아닌 코드(원문)
  // 형식은 맞지만 구역표에 없는 코드. name은 응답 areaName
  unmappedZones: { code: string; scope: "sea" | "land"; name: string }[];
  // 표에 없는 특보 종류(warnVar 원문). 해변 구역이 아니어도 숨기지 않고 기록
  unknownKinds: string[];
};

// 종류별로 잇는 구역(B3): 풍랑은 앞바다, 강풍은 육상, 태풍·폭풍해일은 둘 다
const LINKS: Record<WarningType, readonly ("sea" | "land")[]> = {
  wind_wave: ["sea"],
  strong_wind: ["land"],
  typhoon: ["sea", "land"],
  storm_surge: ["sea", "land"],
  tsunami: [], // getPwnCd에 없음
};

// 단계 높은 순 → 같은 단계는 발표 이른 순(아키텍처 6.3 10/21)
const LEVEL_RANK: Record<WarningLevel, number> = {
  severe_warning: 0,
  warning: 1,
  advisory: 2,
};
type Ranked = { level: WarningLevel; publishedAt: string };
function byLevelThenTime(a: Ranked, b: Ranked): number {
  return (
    LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
    Date.parse(a.publishedAt) - Date.parse(b.publishedAt)
  );
}

// 구역표에 없는 S1 중 '먼바다'가 아니면 앞바다 개편일 수 있음 → 전국 확인 못 함(③)
// 해제된 상태는 지금 발효가 아니라 제외
function blocksNationwide(state: ZoneWarningState, name: string): boolean {
  if (state.zone.kind !== "code" || state.zone.scope !== "sea") return false;
  if (name.includes("먼바다")) return false;
  if (state.kind.group === "nearby") return false;
  return state.status.state !== "cleared";
}

export function judgeBeachWarnings(input: {
  events: readonly PwnEvent[];
  now: string;
  lastConfirmedAt: string | null;
  beaches: readonly BeachZones[];
  zones: ZoneTables;
}): BeachWarningsResult {
  const { events, now, lastConfirmedAt, beaches, zones } = input;
  const states = applyZoneStates(events, now);

  // 응답 이름: 구역표에 없는 코드를 기록하고 '먼바다'를 가를 때만 씀
  const responseNames = new Map<string, string>();
  for (const event of events) {
    if (!responseNames.has(event.raw.areaCode)) {
      responseNames.set(event.raw.areaCode, event.raw.areaName);
    }
  }

  // 1단계: 해변과 이을 수 없는 구역 → 기록, 필요하면 전국 사유
  const nationwide: string[] = [];
  const unknownZones = new Set<string>();
  const unknownKinds = new Set<string>();
  // 구역 코드 → 그 구역의 상태들. 해변마다 전체 상태를 훑지 않게 함
  const byCode = new Map<string, ZoneWarningState[]>();
  const unmapped = new Map<
    string,
    BeachWarningsResult["unmappedZones"][number]
  >();
  for (const state of states) {
    if (state.kind.group === "unknown") unknownKinds.add(state.kind.raw);
    if (state.zone.kind === "unknown") {
      unknownZones.add(state.zone.raw);
      // 주변 특보 종류만 기록. 5종이거나 모르는 종류면 전국 확인 못 함(③)
      if (state.kind.group !== "nearby") {
        nationwide.push(`zone:${state.zone.raw}`);
      }
      continue;
    }
    const { code, scope } = state.zone;
    if (zones[scope][code] !== undefined) {
      const list = byCode.get(code);
      if (list) list.push(state);
      else byCode.set(code, [state]);
      continue;
    }
    const name = responseNames.get(code) ?? "";
    unmapped.set(code, { code, scope, name });
    if (blocksNationwide(state, name)) nationwide.push(`unmapped:${code}`);
  }

  // '없음'을 믿을 수 있는지(45분). 활성 특보 유지에는 쓰지 않음
  const confirmation = checkConfirmation(lastConfirmedAt, now);

  // 2단계: 해변마다
  const result: Record<BeachId, BeachWarning> = {};
  for (const beach of beaches) {
    const reasons: string[] = [...nationwide];
    if (!confirmation.confirmed) {
      reasons.push(`confirmation:${confirmation.reason}`);
    }

    // 해변의 구역이 구역표에 없으면 대응 미검증 → 확인 못 함(완료 조건 1)
    const { sea, land } = beach.warningZones;
    if (zones.sea[sea] === undefined) reasons.push(`zone_unverified:${sea}`);
    if (land !== undefined && zones.land[land] === undefined) {
      reasons.push(`zone_unverified:${land}`);
    }

    const items: WarningItem[] = [];
    const nearby: NearbyWarningItem[] = [];
    // byCode에는 구역표에 있는 코드만 있음. 없는 코드는 위에서 zone_unverified로 남김
    const linked = [
      ...(byCode.get(sea) ?? []),
      ...(land !== undefined ? (byCode.get(land) ?? []) : []),
    ];
    for (const state of linked) {
      if (state.zone.kind !== "code") continue;
      const { code, scope } = state.zone;
      // 앞바다 칸에 L1, 육상 칸에 S1이 들어온 경우는 잇지 않음
      if (code !== (scope === "sea" ? sea : land)) continue;
      const zoneName = zones[scope][code]!;

      const { kind, status } = state;
      if (kind.group === "unknown") {
        // 모르는 종류(warnVar)가 이 해변 구역에 옴 → 5종일 수도 있음
        reasons.push(`${code}:warnVar:${kind.raw}`);
        continue;
      }
      if (kind.group === "judged" && !LINKS[kind.type].includes(scope)) {
        continue; // 예: 앞바다 구역의 강풍은 이 해변 강풍이 아님
      }
      if (status.state === "unknown") {
        // 주변 특보 상태를 모르는 건 분류에 영향 없음
        if (kind.group === "judged") {
          reasons.push(...status.reasons.map((r) => `${code}:${r}`));
        }
        continue;
      }
      if (status.state !== "active") continue; // 예고·해제는 발효가 아님

      const item = {
        level: status.level,
        zoneCode: code,
        zoneName,
        publishedAt: status.publishedAt,
        effectiveFrom: status.effectiveFrom,
      };
      if (kind.group === "judged") items.push({ type: kind.type, ...item });
      else nearby.push({ type: kind.type, ...item });
    }

    items.sort(byLevelThenTime);
    nearby.sort(byLevelThenTime);
    const uniqueReasons = [...new Set(reasons)];
    const state =
      items.length > 0
        ? "active"
        : uniqueReasons.length > 0
          ? "unknown"
          : "none";
    result[beach.id] = { state, items, nearby, reasons: uniqueReasons };
  }

  return {
    beaches: result,
    unknownZones: [...unknownZones].sort(),
    unmappedZones: [...unmapped.values()].sort((a, b) =>
      a.code.localeCompare(b.code),
    ),
    unknownKinds: [...unknownKinds].sort(),
  };
}
