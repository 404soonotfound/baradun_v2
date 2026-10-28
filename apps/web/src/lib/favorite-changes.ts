import type { WarningLevel, WarningType } from "@baradun/contracts";
import { useSyncExternalStore } from "react";

import { DEVICE_KEYS } from "@/lib/device-keys";
import { CLOCK_TOLERANCE_MS, isExpired } from "@/lib/snapshot/clock";
import { deriveDetail } from "@/lib/snapshot/detail";
import {
  hidesLastValues,
  includes,
  isRecord,
  WARNING_CONFIRM_VALID_MS,
  WARNING_LEVELS,
  WARNING_TYPES,
  type BeachView,
  type ViewSource,
} from "@/lib/snapshot/view";

// 즐겨찾기 변경 표시 (BRD-35 · 노션 2장 FAV, 5장 '즐겨찾기 변경 표시는 지난 방문과 지금이 모두 확인된 값일 때만')
// 비교하는 것: 해변에 발효 중인 특보(종류·단계). publisher가 게시한 특보 항목을 읽기만 함(분류 계산 아님, G1)
//   지난 방문·지금 모두 확인됨 + 지금 새 특보가 있음 → "● 지난 방문 뒤 풍랑주의보 발표 · 14:05"
//   한쪽이라도 확인 못 함 → "변경 판단 안 함"
//   지난 방문 기록이 없음(처음 봄) → 표시 없음
// 지난 방문 기록은 기기에만 둠(서버로 보내지 않음). 기기 데이터 초기화로 지움

type WarningKey = `${WarningType}:${WarningLevel}`;

// 확인된 특보 사실. null = 확인 못 함(오프라인·만료·모르는 사유·읽을 수 없는 항목·불러오는 중)
export type WarningFact =
  | { state: "none" }
  | {
      state: "active";
      items: { type: WarningType; level: WarningLevel; publishedAt: string }[];
    };

// 기기에 남기는 지난 방문 기록. null = 그때 확인 못 함
export type SeenRecord =
  { state: "none" } | { state: "active"; keys: readonly WarningKey[] } | null;
export type SeenMap = Readonly<Record<string, SeenRecord>>;

export type ChangeNote =
  | {
      kind: "issued";
      type: WarningType;
      level: WarningLevel;
      publishedAt: string;
    }
  | { kind: "unknown" }
  | null;

const keyOf = (item: { type: WarningType; level: WarningLevel }): WarningKey =>
  `${item.type}:${item.level}`;

// [1] 지금 받은 정보에서 확인된 특보 사실. 판단하지 않고 게시된 칸을 읽기만 함
export function warningFact(
  beachId: string,
  view: BeachView,
  source: ViewSource,
): WarningFact | null {
  if (view.kind !== "ready" || view.stale) return null;
  const detail = deriveDetail(beachId, view, source);
  // '없음'은 상세 '확인한 것'과 같은 조건(state none·항목 없음·기관·45분 안 확인)
  if (detail.warningConfirmedNone) return { state: "none" };
  // '발효'는 이용불가 사유가 특보(+관측 지연)뿐이고, 항목을 모두 읽을 수 있고, 특보 확인이 45분 안일 때만
  // 모르는 사유('이용 제한')·읽지 못한 특보·항목이 있으면 무엇이 바뀌었는지 말할 수 없어 확인 못 함
  if (
    view.category === "unavailable" &&
    view.reasons.some((reason) => reason.kind === "warning") &&
    view.reasons.every(
      (reason) =>
        reason.kind === "warning" || reason.kind === "observation_delayed",
    ) &&
    detail.warnings.length > 0 &&
    detail.unreadableWarnings === 0 &&
    confirmedRecently(view.confirmedAt, source)
  ) {
    return {
      state: "active",
      items: detail.warnings.map(({ type, level, publishedAt }) => ({
        type,
        level,
        publishedAt,
      })),
    };
  }
  return null;
}

function confirmedRecently(
  confirmedAt: string | null,
  source: ViewSource,
): boolean {
  if (confirmedAt === null) return false;
  const ms = Date.parse(confirmedAt);
  return (
    ms <= source.nowMs + CLOCK_TOLERANCE_MS &&
    !isExpired(
      new Date(ms + WARNING_CONFIRM_VALID_MS).toISOString(),
      source.nowMs,
      source.clock,
    )
  );
}

// 이번 방문을 기록해도 되는 때. 불러오는 중·오프라인·불러오기 실패(저장값 B5)·점검·강제 업데이트·지원 밖 형식이면
// 모든 해변이 '확인 못 함'이라 확인된 지난 방문 기록을 덮게 됨 → 이번 조회가 성공했고 값을 보여 줄 때만
export function canRecordSeen(
  source: Pick<ViewSource, "phase" | "live">,
): boolean {
  return (
    source.phase !== "loading" && source.live && !hidesLastValues(source.phase)
  );
}

// [2] 사실 → 기기 기록(종류·단계만 남김)
export function toSeen(fact: WarningFact | null): SeenRecord {
  if (fact === null) return null;
  if (fact.state === "none") return { state: "none" };
  return { state: "active", keys: [...new Set(fact.items.map(keyOf))].sort() };
}

// [3] 지난 방문 기록과 지금을 비교. previous가 undefined = 지난 방문 기록 없음
// 새로 생긴 특보(지난 방문에 없던 종류·단계)만 알림. 여럿이면 가장 늦게 발표된 것
export function changeNote(
  previous: SeenRecord | undefined,
  current: WarningFact | null,
): ChangeNote {
  if (previous === undefined) return null;
  if (previous === null || current === null) return { kind: "unknown" };
  if (current.state === "none") return null;
  const before = new Set(previous.state === "active" ? previous.keys : []);
  const added = current.items
    .filter((item) => !before.has(keyOf(item)))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const latest = added[0];
  return latest ? { kind: "issued", ...latest } : null;
}

// [4] 다음 방문에 쓸 기록. 지금 즐겨찾기에 있는 해변만 남김.
// 화면에 없는 해변(노출 끔)은 지난 기록을 그대로 둠: 다시 켜지면 그때와 비교
export function nextSeen(
  stored: SeenMap,
  favoriteIds: readonly string[],
  current: ReadonlyMap<string, SeenRecord>,
): SeenMap {
  const next: Record<string, SeenRecord> = {};
  for (const id of favoriteIds) {
    if (current.has(id)) next[id] = current.get(id) ?? null;
    else if (id in stored) next[id] = stored[id] ?? null;
  }
  return next;
}

// [5] 저장 글자 → 기록. 깨진 항목은 '확인 못 함'(null)으로 읽음: 모르는 값을 '변경 없음'으로 보이지 않게
export function parseSeen(raw: string | null): SeenMap {
  if (raw === null) return EMPTY;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (!isRecord(value)) return EMPTY;
  const out: Record<string, SeenRecord> = {};
  for (const [id, entry] of Object.entries(value)) {
    out[id] = readRecord(entry);
  }
  return out;
}

function readRecord(entry: unknown): SeenRecord {
  if (!isRecord(entry)) return null;
  if (entry.state === "none") return { state: "none" };
  if (entry.state !== "active" || !Array.isArray(entry.keys)) return null;
  const keys = entry.keys.filter(isWarningKey);
  return keys.length === entry.keys.length && keys.length > 0
    ? { state: "active", keys }
    : null;
}

function isWarningKey(value: unknown): value is WarningKey {
  if (typeof value !== "string") return false;
  const [type, level, extra] = value.split(":");
  return (
    extra === undefined &&
    includes(WARNING_TYPES, type) &&
    includes(WARNING_LEVELS, level)
  );
}

// ── 기기 저장 (lib/device-list.ts와 같은 틀: 모든 접근 try/catch, 쓰기 실패 뒤에는 memory) ──
// 화면에 들어올 때 지난 기록을 한 번 읽어 고정(baseline)하고, 머무는 동안 지금 상태를 계속 기록함.
// 그래서 다음 방문은 이번 방문 마지막 상태와 비교함
const EMPTY: SeenMap = {};

export type SeenStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// 테스트에서 저장소를 바꿔 끼울 수 있게 만드는 함수로 둠(lib/onboarding.ts와 같은 방식)
export function createSeenStore(
  storageKey: string,
  storage: () => SeenStorage | null,
) {
  let memory: SeenMap = EMPTY;
  let writeFailed = false;
  let baseline: SeenMap | null = null;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  function readStored(): SeenMap {
    if (writeFailed) return memory; // 저장소의 옛 값이 방금 기록한 값을 덮지 않게
    try {
      return parseSeen(storage()?.getItem(storageKey) ?? null);
    } catch {
      return memory;
    }
  }

  return {
    subscribe(onChange: () => void) {
      // 개발 모드 두 번 붙이기(해제 → 바로 다시 구독)에서 방금 쓴 기록을 지난 방문으로 다시 읽지 않게 해제를 미룸
      if (resetTimer !== null) {
        clearTimeout(resetTimer);
        resetTimer = null;
      }
      listeners.add(onChange);
      if (baseline === null) {
        baseline = readStored();
        onChange();
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size > 0) return;
        resetTimer = setTimeout(() => {
          baseline = null; // 화면을 떠나면 다음에 들어올 때 다시 읽음
          resetTimer = null;
        }, 0);
      };
    },
    // 지난 방문 기록. null = 아직 읽지 않음
    getBaseline: (): SeenMap | null => baseline,
    // 지금 상태를 다음 방문용으로 기록. 지난 기록을 읽기 전에는 쓰지 않음(비교할 값을 잃지 않게)
    record(
      favoriteIds: readonly string[],
      current: ReadonlyMap<string, SeenRecord>,
    ) {
      if (baseline === null) return;
      const next = nextSeen(readStored(), favoriteIds, current);
      const raw = JSON.stringify(next);
      memory = next;
      if (writeFailed) return;
      try {
        const target = storage();
        if (target === null) throw new Error("no storage");
        // 시각만 바뀌어 다시 부를 때(같은 기록) 저장소에 또 쓰지 않음
        if (target.getItem(storageKey) === raw) return;
        target.setItem(storageKey, raw);
      } catch {
        writeFailed = true; // 이번 방문 동안은 memory로 이어감
      }
    },
    // 기기 데이터 초기화(BRD-36). 보고 있는 화면의 지난 기록도 비움
    clear() {
      memory = EMPTY;
      try {
        storage()?.removeItem(storageKey);
      } catch {
        writeFailed = true;
      }
      if (baseline !== null) {
        baseline = EMPTY;
        listeners.forEach((listener) => listener());
      }
    },
  };
}

// 브라우저 저장소. 사생활 보호 모드 등에서는 꺼내기만 해도 오류가 남 → null
function browserStorage(): SeenStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const seen = createSeenStore(DEVICE_KEYS.favoriteSeen, browserStorage);

// 정적 HTML·첫 그리기에서는 null → 변경 표시를 하지 않음
export function useSeenBaseline(): SeenMap | null {
  return useSyncExternalStore(seen.subscribe, seen.getBaseline, () => null);
}

export const recordSeen = seen.record;
export const clearSeen = seen.clear;
