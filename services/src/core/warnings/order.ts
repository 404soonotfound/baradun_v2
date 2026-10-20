import type { PwnCdRow, PwnEvent } from "./normalize";

// getPwnCd 이벤트 정렬·중복 제거
// 순서: publishedAt(tmFc) → seq(tmSeq). tmSeq는 달마다 1부터 다시 시작 → 시각을 먼저 봄
// 받은 순서와 상관없이 결과가 같아야 함(T05) → 비교가 끝까지 같으면 원문 글자로 정함

const RAW_FIELDS = [
  "tmFc",
  "tmSeq",
  "areaCode",
  "areaName",
  "warnVar",
  "warnStress",
  "command",
  "cancel",
  "startTime",
  "endTime",
  "allEndTime",
  "stnId",
] as const satisfies readonly (keyof PwnCdRow)[];

// 같은 이벤트인지 가르는 값: 발표 시각·발표번호·구역·종류·발표코드
function identity(raw: PwnCdRow): string {
  return [raw.tmFc, raw.tmSeq, raw.areaCode, raw.warnVar, raw.command].join(
    "|",
  );
}

// 원문 전체를 정해진 항목 순서로 이은 글자. 객체 key 순서에 흔들리지 않음
function rawText(raw: PwnCdRow): string {
  return RAW_FIELDS.map((field) => raw[field] ?? "").join("|");
}

// 값 없음(null)은 뒤로
function compareNullable<T extends string | number>(
  a: T | null,
  b: T | null,
): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

export function comparePwnEvents(a: PwnEvent, b: PwnEvent): number {
  return (
    compareNullable(a.publishedAt, b.publishedAt) ||
    compareNullable(a.seq, b.seq) ||
    compareNullable(rawText(a.raw), rawText(b.raw))
  );
}

export function orderPwnEvents(events: readonly PwnEvent[]): PwnEvent[] {
  const byIdentity = new Map<string, PwnEvent>();
  for (const event of events) {
    const key = identity(event.raw);
    const seen = byIdentity.get(key);
    if (!seen) {
      byIdentity.set(key, event);
      continue;
    }
    if (rawText(seen.raw) === rawText(event.raw)) continue; // 완전히 같은 이벤트 → 하나만

    // 같은 이벤트인데 나머지 값(단계·시각·취소 등)이 다름 → 어느 쪽이 맞는지 모름
    // 받은 순서와 상관없게 원문 글자가 작은 쪽을 남기고 사유를 붙임
    const kept = comparePwnEvents(seen, event) <= 0 ? seen : event;
    const reason = `conflict:${key}`;
    byIdentity.set(key, {
      ...kept,
      unknownReasons: kept.unknownReasons.includes(reason)
        ? kept.unknownReasons
        : [...kept.unknownReasons, reason],
    });
  }
  // sort는 배열을 제자리에서 바꿈 → Map에서 새로 만든 배열이라 입력은 그대로
  return [...byIdentity.values()].sort(comparePwnEvents);
}
