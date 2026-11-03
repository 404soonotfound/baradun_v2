import type { Notice } from "@baradun/contracts";

import { isTime, type Clock } from "./clock";
import { isRecord } from "./view";

// 운영자 공지 (BRD-151 · 결정 기록 D15-6·D16-B3·D16-D4, 구현 제안 I09)
// manifest의 선택 칸 notices를 공지마다 따로 검사해 깨진 공지만 뺌(manifest 전체를 못 읽은 것으로 바꾸지 않음).
// 공지는 판단 상태·배지·maintenance에 영향이 없음. 배너 자리 하나에 하나만 보임

// 계약 Notice 모양(contract.schema.json). 브라우저에서 ajv를 돌리지 않고 같은 조건만 확인함
const NOTICE_KEYS = ["id", "kind", "title", "body", "startsAt", "endsAt"];
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KINDS: readonly string[] = ["maintenance_notice", "general"];

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isLocalized(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["ko", "en"]) &&
    typeof value.ko === "string" &&
    value.ko.length > 0 &&
    typeof value.en === "string" &&
    value.en.length > 0
  );
}

// UTC(Z)만. +09:00 같은 시간대 값은 계약 위반이라 뺌(KST·UTC 섞임 방지)
function isUtc(value: unknown): value is string {
  return isTime(value) && value.endsWith("Z");
}

function isNotice(value: unknown): value is Notice {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, NOTICE_KEYS) &&
    typeof value.id === "string" &&
    ID_PATTERN.test(value.id) &&
    typeof value.kind === "string" &&
    KINDS.includes(value.kind) &&
    isLocalized(value.title) &&
    isLocalized(value.body) &&
    isUtc(value.startsAt) &&
    // 칸이 없으면(undefined) 계약 위반. 끝을 정하지 않은 공지는 null로 옴
    (value.endsAt === null || isUtc(value.endsAt))
  );
}

// 읽을 수 있는 공지만 남김. 칸이 없거나 배열이 아니면 공지 없음
export function readNotices(value: unknown): Notice[] {
  return Array.isArray(value) ? value.filter(isNotice) : [];
}

// 지금 보이는 공지인지: 시작 포함·끝 제외(UTC 비교)
function isShown(notice: Notice, nowMs: number): boolean {
  return (
    Date.parse(notice.startsAt) <= nowMs &&
    (notice.endsAt === null || nowMs < Date.parse(notice.endsAt))
  );
}

// 한 번에 하나: 점검 예고 > 일반, 같은 종류는 startsAt이 늦은 것, 같으면 id 오름차순
function compare(a: Notice, b: Notice): number {
  const kind =
    Number(b.kind === "maintenance_notice") -
    Number(a.kind === "maintenance_notice");
  if (kind !== 0) return kind;
  const start = Date.parse(b.startsAt) - Date.parse(a.startsAt);
  if (start !== 0) return start;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// 지금 보일 공지 하나. 서버 시각을 모르면(기기 시계만) 새로 보이지도 계속 보이지도 않음(I09):
// 틀린 기기 시계로 끝난 공지가 남거나 예약 전 공지가 먼저 보이지 않게
// 새로 받은 manifest인지(live)는 보지 않음: 화면은 pickSituation을 거쳐야 함(저장된 지난 manifest의 공지를 숨김)
export function activeNotice(
  notices: readonly Notice[] | undefined,
  nowMs: number,
  clock: Clock,
): Notice | null {
  if (!notices || !clock.trusted || !Number.isFinite(nowMs)) return null;
  const shown = notices.filter((notice) => isShown(notice, nowMs));
  return shown.sort(compare)[0] ?? null;
}

// 공지가 보이기 시작하거나 끝나는 시각(보정된 시각, ms). 이 시각에 화면을 다시 계산함
export function noticeDeadlines(notices: readonly Notice[] | undefined) {
  const times: number[] = [];
  for (const notice of notices ?? []) {
    times.push(Date.parse(notice.startsAt));
    if (notice.endsAt !== null) times.push(Date.parse(notice.endsAt));
  }
  return times;
}
