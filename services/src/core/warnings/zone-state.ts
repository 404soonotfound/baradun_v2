import type { WarningLevel } from "@baradun/contracts";
import type { WarningKind } from "./codes";
import type { PwnEvent, Zone } from "./normalize";
import { orderPwnEvents } from "./order";

// 구역·종류별 특보 상태 (아키텍처 4장·결정 기록 11장)
// '없음 확인'은 여기서 만들지 않음 → 정상 전체 조회 여부·lastConfirmedAt은 BRD-18·56
export type ZoneStatus =
  | {
      state: "active"; // 발효 중
      level: WarningLevel;
      publishedAt: string;
      effectiveFrom: string;
    }
  | {
      state: "pending"; // 발효 예고(발표됐지만 startTime 전)
      level: WarningLevel;
      publishedAt: string;
      effectiveFrom: string;
    }
  | { state: "cleared"; at: string } // 해제 발효
  | { state: "unknown"; reasons: string[] };

export type ZoneWarningState = {
  zone: Zone;
  kind: WarningKind;
  status: ZoneStatus;
};

// 사유 없이 해석된 이벤트. 아래 clean()을 통과한 것만 상태 계산에 씀
type CleanEvent = PwnEvent & {
  action: "issue" | "extend" | "change_issue" | "release";
  publishedAt: string;
  effectiveFrom: string;
  level: WarningLevel;
};

function zoneKey(zone: Zone): string {
  return zone.kind === "code" ? zone.code : zone.raw;
}

function kindKey(kind: WarningKind): string {
  return kind.group === "unknown" ? `unknown:${kind.raw}` : kind.type;
}

// 이 이벤트만으로 상태를 정할 수 없는 사유. 빈 배열이면 깨끗함
// 정정(6)·변경해제(8)·취소는 실데이터 0건이라 명세만으로 대상을 알 수 없음 → unknown(결정 기록 11장)
function blockingReasons(event: PwnEvent): string[] {
  const reasons = [...event.unknownReasons];
  if (event.action === "correct") reasons.push("command:6");
  if (event.action === "change_release") reasons.push("command:8");
  if (event.cancelled) reasons.push("cancel:1");
  return reasons;
}

// 사유가 없으면 normalize가 시각·단계·동작을 모두 채움 → 타입만 좁혀 줌
// "event is CleanEvent": true를 돌려주면 그 뒤로 event를 CleanEvent로 다룬다는 TypeScript 타입 가드
function isClean(event: PwnEvent): event is CleanEvent {
  return (
    blockingReasons(event).length === 0 &&
    event.action !== null &&
    event.publishedAt !== null &&
    event.effectiveFrom !== null &&
    event.level !== null
  );
}

const isRelease = (event: CleanEvent) => event.action === "release";

// 이벤트 하나가 발효된 뒤의 상태. 발표·연장·변경발표는 발효 중, 해제는 해제
function effectiveStatus(event: CleanEvent): ZoneStatus {
  if (isRelease(event)) return { state: "cleared", at: event.effectiveFrom };
  return {
    state: "active",
    level: event.level,
    publishedAt: event.publishedAt,
    effectiveFrom: event.effectiveFrom,
  };
}

// ISO 문자열 → 밀리초. 글자 비교는 ".000Z"처럼 표기가 다르면 틀림 → 숫자로 비교
const ms = (iso: string) => Date.parse(iso);

// 한 구역·종류의 정렬된 이벤트 → 기준 시각(밀리초)의 상태
function statusOf(events: PwnEvent[], now: number): ZoneStatus {
  const reasons = events.flatMap(blockingReasons);
  // 발표 시각·발표번호가 같은데 다른 이벤트 → 순서를 알 수 없음
  for (let i = 1; i < events.length; i++) {
    const [a, b] = [events[i - 1]!, events[i]!];
    if (a.publishedAt === b.publishedAt && a.seq === b.seq) {
      reasons.push(`order:${a.raw.tmFc}#${a.raw.tmSeq}`);
    }
  }
  const clean = events.filter(isClean);
  if (reasons.length > 0 || clean.length !== events.length) {
    // Set으로 같은 사유를 한 번만 남김(처음 나온 순서 유지)
    return { state: "unknown", reasons: [...new Set(reasons)] };
  }

  // 나중에 발표된 이벤트가 앞선 것을 대신함. 그중 이미 발효된 마지막 이벤트가 지금 상태
  // (findLastIndex는 ES2023이라 대상 ES2022에선 못 씀 → 뒤에서부터 반복)
  let lastEffective = -1;
  for (let i = clean.length - 1; i >= 0; i--) {
    if (ms(clean[i]!.effectiveFrom) <= now) {
      lastEffective = i;
      break;
    }
  }
  const current =
    lastEffective >= 0 ? effectiveStatus(clean[lastEffective]!) : null;

  // 발효 중이면 예고된 변경·해제가 발효될 때까지 유지
  if (current?.state === "active") return current;

  // 그 뒤 이벤트는 모두 발효 전(예고). 발효 중이 아니고 예고된 발표가 있으면 발효 예고
  const upcoming = clean
    .slice(lastEffective + 1)
    .filter((e) => !isRelease(e))
    .at(-1); // at(-1): 마지막 요소, 없으면 undefined
  if (upcoming) {
    return {
      state: "pending",
      level: upcoming.level,
      publishedAt: upcoming.publishedAt,
      effectiveFrom: upcoming.effectiveFrom,
    };
  }
  if (current) return current;
  // 예고된 해제만 있고 앞선 발표가 안 보임 → 발효 중인 단계·시각을 모름
  return { state: "unknown", reasons: ["release_without_issue"] };
}

// 입력: 정규화된 getPwnCd 이벤트(순서·중복 상관없음) + 기준 시각(UTC ISO)
// 기준 시각보다 늦게 발표된 이벤트는 아직 모르는 것으로 봄
// 출력: 구역·종류마다 하나, 구역·종류 순으로 정렬
export function applyZoneStates(
  events: readonly PwnEvent[],
  now: string,
): ZoneWarningState[] {
  const nowMs = ms(now);
  if (Number.isNaN(nowMs)) throw new RangeError(`기준 시각 형식 오류: ${now}`);

  const groups = new Map<string, PwnEvent[]>();
  for (const event of orderPwnEvents(events)) {
    // 발표 시각을 못 읽은 이벤트는 걸러낼 수 없어 남김 → 그 구역·종류는 unknown
    if (event.publishedAt !== null && ms(event.publishedAt) > nowMs) continue;
    const key = `${zoneKey(event.zone)}|${kindKey(event.kind)}`;
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }

  return [...groups.keys()].sort().map((key) => {
    const group = groups.get(key)!;
    const { zone, kind } = group[0]!;
    return { zone, kind, status: statusOf(group, nowMs) };
  });
}
