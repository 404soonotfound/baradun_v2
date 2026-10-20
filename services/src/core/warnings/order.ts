import type { PwnCdRow, PwnEvent } from "./normalize";

// getPwnCd 이벤트 정렬·중복 제거
// 순서: publishedAt(tmFc) → seq(tmSeq). tmSeq는 달마다 1부터 다시 시작 → 시각을 먼저 봄
// 받은 순서와 상관없이 결과가 같아야 함(T05) → 비교가 끝까지 같으면 원문 글자 → 구역명 순으로 정함

// 구역은 코드로만 구분. 같은 코드를 구역명만 바꿔 두 행으로 보내는 경우가 있음
// (실데이터: L1031200 "당진군"·"당진시") → 같은지 비교할 때 areaName은 뺌, raw에는 원문 그대로 둠
// 화면 표시 이름은 공식 특보구역 목록 이름(예: '당진')을 씀 → BRD-18 범위
const COMPARED_FIELDS = [
  "tmFc",
  "tmSeq",
  "areaCode",
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

// 구역명을 뺀 원문을 정해진 항목 순서로 이은 글자. 객체 key 순서에 흔들리지 않음
function rawText(raw: PwnCdRow): string {
  return COMPARED_FIELDS.map((field) => raw[field] ?? "").join("|");
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
    compareNullable(rawText(a.raw), rawText(b.raw)) ||
    compareNullable(a.raw.areaName, b.raw.areaName)
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

    // 구역명 말고 모두 같음 → 같은 이벤트, 하나만 남김
    // 구역명 말고도 다른 값(단계·시각·취소 등)이 있음 → 어느 쪽이 맞는지 모름 → 충돌 사유
    // 받은 순서와 상관없게 비교가 작은 쪽을 남김. 충돌은 앞서 붙은 사유도 이어받음
    const reason = `conflict:${key}`;
    const conflict =
      rawText(seen.raw) !== rawText(event.raw) ||
      seen.unknownReasons.includes(reason);
    const kept = comparePwnEvents(seen, event) <= 0 ? seen : event;
    byIdentity.set(
      key,
      conflict && !kept.unknownReasons.includes(reason)
        ? { ...kept, unknownReasons: [...kept.unknownReasons, reason] }
        : kept,
    );
  }
  // sort는 배열을 제자리에서 바꿈 → Map에서 새로 만든 배열이라 입력은 그대로
  return [...byIdentity.values()].sort(comparePwnEvents);
}
