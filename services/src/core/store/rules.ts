import {
  SLOT_RECORD_RETENTION_MS,
  type StateRecord,
  type StateValue,
} from "./types";

// 메모리·DynamoDB 구현이 같이 쓰는 순수 규칙

// 게시 버전 형식 (packages/contracts 스키마 snapshotVersion pattern과 같음)
// 자릿수가 고정 → 글자 비교 순서 = 시각 순서
const SNAPSHOT_VERSION = /^[0-9]{8}T[0-9]{6}Z$/;

export function assertSnapshotVersion(version: string): void {
  if (!SNAPSHOT_VERSION.test(version)) {
    throw new Error(`invalid snapshotVersion: ${version}`);
  }
}

// DynamoDB TTL은 epoch 초 숫자를 읽음 (ms 아님)
export function slotRecordTtl(now: number): number {
  return Math.floor((now + SLOT_RECORD_RETENTION_MS) / 1000);
}

// 객체 key 순서와 상관없는 비교용 글자. DynamoDB map은 key 순서를 보장하지 않음
function canonical(value: StateValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as { [key: string]: StateValue })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(",")}}`;
}

export function sameStateValue(a: StateValue, b: StateValue): boolean {
  return canonical(a) === canonical(b);
}

export type StateWriteDecision =
  | { readonly kind: "stale" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "conflict" }
  // expectedVersion: 읽은 recordVersion(기록 없음 → null). 쓸 때 이 값과 같아야 함
  | {
      readonly kind: "write";
      readonly record: StateRecord;
      readonly expectedVersion: number | null;
    };

// 저장 규칙 (7장): 오래된 값 거부, 같은 orderAt·같은 값은 바뀐 것 없음, 그 밖은 recordVersion +1
// 같은 orderAt인데 값이 다름 → 정정으로 보고 씀
// 더 새 orderAt에 같은 값 → orderAt이 신선도에 쓰이므로 씀
// expectedVersion: 부르는 쪽이 먼저 읽은 recordVersion(기록 없음 → null). 주면 지금 값과 다를 때 conflict
// → 읽고 합친 뒤 쓰는 쪽이 그 사이의 다른 쓰기를 덮지 않음
export function decideStateWrite(
  current: StateRecord | null,
  pk: string,
  sk: string,
  value: StateValue,
  orderAt: number,
  expectedVersion?: number | null,
): StateWriteDecision {
  if (
    expectedVersion !== undefined &&
    (current?.recordVersion ?? null) !== expectedVersion
  ) {
    return { kind: "conflict" };
  }
  if (current) {
    if (orderAt < current.orderAt) return { kind: "stale" };
    if (orderAt === current.orderAt && sameStateValue(current.value, value)) {
      return { kind: "unchanged" };
    }
  }
  return {
    kind: "write",
    record: {
      pk,
      sk,
      value,
      orderAt,
      recordVersion: (current?.recordVersion ?? 0) + 1,
    },
    expectedVersion: current?.recordVersion ?? null,
  };
}
