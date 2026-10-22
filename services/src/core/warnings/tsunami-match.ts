import type { BeachId, WarningItem } from "@baradun/contracts";
import { parseUtcIso } from "./time";
import type { TsunamiEvent, TsunamiResult } from "./tsunami";

// 지진해일 reg 글 → 해변 (결정 기록 11장 10/20 ⑥·10/22 ⑤, 아키텍처 4장)
// 못 읽은 조각은 unreadable로 돌려줌 → 전국 '특보 확인 못 함' + 원문은 BRD-21
// 읽힌 조각의 해변에는 발표를 그대로 적용. 확인된 위험은 숨기지 않음(아키텍처 3장 6항)

// 해변 입력. 해안 구분·시도·시군은 data/beaches 값
export type BeachRegion = {
  id: BeachId;
  coast: "east" | "south" | "west" | "jeju";
  region: { sido: { ko: string }; sigungu: { ko: string } };
};

// (a) 해안 구분 글 → coast 값
const COASTS: Record<string, BeachRegion["coast"]> = {
  동해안: "east",
  남해안: "south",
  서해안: "west",
  제주: "jeju",
  제주도: "jeju",
};

export type RegionMatch = {
  beachIds: BeachId[]; // 읽힌 조각의 해변
  unreadable: string[]; // 못 읽은 조각 원문. 비어 있으면 전체를 읽음
};

// 조각 하나 → 해변 id 목록. 못 읽으면 null
function matchPart(
  part: string,
  beaches: readonly BeachRegion[],
): BeachId[] | null {
  const words = part.split(/\s+/);
  const ids = (keep: (b: BeachRegion) => boolean) => {
    const found = beaches.filter(keep).map((b) => b.id);
    return found.length > 0 ? found : null; // 해변이 없으면 읽은 것으로 보지 않음
  };

  if (words.length === 2) {
    // (b) 시도 + 시군. 예: "경북 울진군"
    const [sido, sigungu] = words;
    return ids(
      (b) => b.region.sido.ko === sido && b.region.sigungu.ko === sigungu,
    );
  }
  if (words.length !== 1) return null;

  const coast = Object.hasOwn(COASTS, part) ? COASTS[part] : undefined;
  if (coast) return ids((b) => b.coast === coast);

  // (c) 시군 이름만. 시도가 다른 같은 이름(중구·고성군 등)이 있으면 못 읽음
  const sidos = new Set(
    beaches
      .filter((b) => b.region.sigungu.ko === part)
      .map((b) => b.region.sido.ko),
  );
  if (sidos.size !== 1) return null;
  return ids((b) => b.region.sigungu.ko === part);
}

// reg 전체. 쉼표·가운뎃점으로 나눈 조각마다 읽음. 일부만 읽혀도 읽힌 해변은 돌려줌
export function matchTsunamiRegion(
  reg: string,
  beaches: readonly BeachRegion[],
): RegionMatch {
  const parts = reg.split(/[,·]/).map((p) => p.trim());
  const ids = new Set<BeachId>();
  const unreadable: string[] = [];
  for (const part of parts) {
    const found = part === "" ? null : matchPart(part, beaches);
    if (found) found.forEach((id) => ids.add(id));
    else unreadable.push(part);
  }
  return { beachIds: [...ids].sort(), unreadable };
}

// 같은 행인지 가르는 값: 동작·단계·발표 시각·발효 시각·지역 글·못 읽은 사유
// 사유까지 넣어 서로 다른 못 읽은 값(fcTp 등)이 하나로 합쳐져 사유가 사라지지 않게 함
const eventKey = (e: TsunamiEvent) =>
  JSON.stringify([
    e.action,
    e.level,
    e.publishedAt,
    e.effectiveFrom,
    e.zone.raw,
    e.unknownReasons,
  ]);

export type TsunamiBeach = {
  items: WarningItem[]; // 발효 중인 지진해일(zoneCode null, zoneName = reg 원문)
  reasons: string[]; // 이 해변의 지진해일을 확인하지 못한 사유
};

export type TsunamiBeachesResult = {
  beaches: Record<BeachId, TsunamiBeach>;
  // 못 읽은 조각이 있는 발표. 하나라도 있으면 전국 확인 못 함(BRD-21)
  // 읽힌 조각의 해변에는 이미 적용됨 → 발효 중이면 이용불가가 이김
  unreadable: { reg: string; parts: string[]; announcement: string | null }[];
};

const ms = (iso: string) => Date.parse(iso);

export function judgeTsunamiBeaches(input: {
  result: TsunamiResult;
  now: string;
  beaches: readonly BeachRegion[];
}): TsunamiBeachesResult {
  const { result, now, beaches } = input;
  // 시간대 없는 값은 Date.parse가 실행 환경 시간대로 읽음 → UTC ISO만 받음
  const nowMs = parseUtcIso(now);
  if (nowMs === null) throw new RangeError(`기준 시각 형식 오류: ${now}`);

  const out: Record<BeachId, TsunamiBeach> = {};
  for (const beach of beaches) out[beach.id] = { items: [], reasons: [] };
  const unreadable: TsunamiBeachesResult["unreadable"] = [];

  // 조회 실패 → 모든 해변 확인 못 함. 03(발표 없음 확인)은 그대로 둠
  if (result.status === "failed") {
    for (const beach of beaches) {
      out[beach.id]!.reasons.push(`tsunami:${result.reason}`);
    }
    return { beaches: out, unreadable };
  }
  if (result.status === "none") return { beaches: out, unreadable };

  // 해변마다 이 해변에 해당하는 발표 모음
  const perBeach = new Map<BeachId, TsunamiEvent[]>();
  for (const event of result.events) {
    // 기준 시각보다 늦게 발표된 것은 아직 모르는 것으로 봄(zone-state와 같음)
    if (event.publishedAt !== null && ms(event.publishedAt) > nowMs) continue;

    const match = matchTsunamiRegion(event.zone.raw, beaches);
    if (match.unreadable.length > 0) {
      unreadable.push({
        reg: event.zone.raw,
        parts: match.unreadable,
        announcement: event.announcement,
      });
    }
    for (const id of match.beachIds) {
      const list = perBeach.get(id);
      if (list) list.push(event);
      else perBeach.set(id, [event]);
    }
  }

  for (const [id, all] of perBeach) {
    const beach = out[id]!;
    // 완전히 같은 행(응답에 두 번 온 행)은 하나로. 순서를 따질 필요가 없음
    const events = [
      ...new Map(all.map((e) => [eventKey(e), e] as const)).values(),
    ];
    // 시각·종류를 못 읽은 발표가 있으면 이 해변 상태를 정할 수 없음
    const broken = events.filter((e) => e.unknownReasons.length > 0);
    if (broken.length > 0) {
      beach.reasons.push(
        ...broken.flatMap((e) => e.unknownReasons.map((r) => `tsunami:${r}`)),
      );
      continue;
    }

    // 여기부터는 사유 없는 발표만 → normalize가 시각을 모두 채움. 그래서 !(null 아님)를 씀
    // 발표 시각 순. 같은 시각에 내용이 다른 발표가 있으면 순서를 알 수 없음
    const sorted = [...events].sort(
      (a, b) => ms(a.publishedAt!) - ms(b.publishedAt!),
    );
    const tie = sorted.find(
      (e, i) => i > 0 && e.publishedAt === sorted[i - 1]!.publishedAt,
    );
    if (tie) {
      beach.reasons.push(`tsunami:order:${tie.publishedAt}`);
      continue;
    }

    // 이미 발효된 마지막 발표가 지금 상태. 해제면 없음, 발표면 발효 중
    const current = sorted.filter((e) => ms(e.effectiveFrom!) <= nowMs).at(-1);
    if (current?.action === "issue" && current.level !== null) {
      beach.items.push({
        type: "tsunami",
        level: current.level,
        zoneCode: null,
        zoneName: current.zone.raw,
        publishedAt: current.publishedAt!,
        effectiveFrom: current.effectiveFrom!,
      });
    }
  }

  // 사유 중복 제거
  for (const beach of Object.values(out)) {
    beach.reasons = [...new Set(beach.reasons)];
  }
  return { beaches: out, unreadable };
}
