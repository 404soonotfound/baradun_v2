import type { ManifestFile, Notice } from "@baradun/contracts";
import { checkNoticePhrases } from "@baradun/contracts/notice-rules";
import type { Logger } from "../core/collect/log";
import type { HeldNotice, NoticeHold } from "../core/store/types";
import { contractErrors } from "./validate";

// 게시본에 실을 공지 고르기와 manifest 읽기 (BRD-151·D20-2, #331)
// publisher(publish.ts)와 운영 API 게시 현황(admin/publish-reads.ts)이 같은 함수를 씀 → 대기 공지를 다시 판단하지 않음
// 분류·스냅샷 조립 코드를 가져오지 않아 운영 API 번들이 커지지 않게 따로 둠

export const MANIFEST_PATH = "data/manifest.json";

// 게시본에 실을 공지(D16-B3·D4, 구현 제안 I09)
// - 시작 시각이 지난 것만(예약 전 문구는 공개 게시본에 넣지 않음), 끝 시각이 지난 것은 뺌
// - 계약에 맞지 않거나 끝이 시작보다 이르면 그 공지만 빼고 알림(공지 하나 때문에 특보·관측 게시를 멈추지 않음)
// - 차단 표현(D16-D1·D17-8)이 든 노출본도 그것만 빼고 알림. 노출(expose) 검사 전에 확정한 노출본이나
//   다른 쓰기 경로로 들어온 문구가 게시되지 않게 함(게시 차단은 서버도 검사)
// - ID 순으로 정렬해 같은 공지면 같은 manifest가 되게 함(바뀐 게 없으면 게시 생략)
export function publishableNotices(
  candidates: readonly unknown[],
  nowMs: number,
  log: Logger,
): Notice[] {
  return started(currentNotices(candidates, nowMs, log), nowMs);
}

export function started(notices: readonly Notice[], nowMs: number): Notice[] {
  return notices.filter((notice) => Date.parse(notice.startsAt) <= nowMs);
}

// 지금 공지 상태: 검사를 통과하고 끝나지 않은 노출본 전부(예약 전 포함). ID 순
// 게시할 때마다 Ops에 남겨 되돌리기의 기준으로 쓰고(D20-2), 여기서 시작한 것만 골라 게시본에 실음
export function currentNotices(
  candidates: readonly unknown[],
  nowMs: number,
  log: Logger,
): Notice[] {
  const valid: Notice[] = [];
  for (const candidate of candidates) {
    const notice = candidate as Notice;
    if (
      contractErrors("Notice", candidate).length > 0 ||
      (notice.endsAt !== null &&
        Date.parse(notice.endsAt) <= Date.parse(notice.startsAt))
    ) {
      log("error", "publish_notice_invalid", {
        noticeId: typeof notice?.id === "string" ? notice.id : "?",
      });
      continue;
    }
    if (
      [notice.title.ko, notice.title.en, notice.body.ko, notice.body.en].some(
        (text) => checkNoticePhrases(text).blocked.length > 0,
      )
    ) {
      log("error", "publish_notice_blocked_phrase", { noticeId: notice.id });
      continue;
    }
    if (notice.endsAt !== null && Date.parse(notice.endsAt) <= nowMs) continue;
    // 칸 순서를 고정함. 운영 DB의 맵은 칸 순서를 지키지 않아 같은 공지가 다른 manifest로 보이면 매번 새로 게시됨
    valid.push({
      id: notice.id,
      kind: notice.kind,
      title: { ko: notice.title.ko, en: notice.title.en },
      body: { ko: notice.body.ko, en: notice.body.en },
      startsAt: notice.startsAt,
      endsAt: notice.endsAt,
    });
  }
  return valid.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// 되돌림 반영(D20-2·D16-C3): 포인터에 있는 공지는 운영 DB 노출본 대신 그때 노출본을 씀(null이면 뺌)
// 운영 DB에는 노출본이 없어졌지만 포인터에 그때 노출본이 있는 공지도 그 값으로 실음
// 포인터가 없거나 비어 있으면 운영 DB 노출본 그대로
export function applyNoticeHold(
  candidates: readonly unknown[],
  hold: NoticeHold | null,
): unknown[] {
  const held = hold?.notices ?? {};
  const idOf = (candidate: unknown) =>
    typeof (candidate as { id?: unknown } | null)?.id === "string"
      ? (candidate as { id: string }).id
      : null;
  return [
    ...candidates.filter((candidate) => {
      const id = idOf(candidate);
      return id === null || !Object.hasOwn(held, id);
    }),
    ...Object.values(held).flatMap((entry) => (entry.live ? [entry.live] : [])),
  ];
}

export function parseManifest(body: string | null): ManifestFile | null {
  if (body === null) return null;
  try {
    const value: unknown = JSON.parse(body);
    return contractErrors("ManifestFile", value).length === 0
      ? (value as ManifestFile)
      : null;
  } catch {
    return null;
  }
}

// 되돌리기의 새 포인터: 고른 게시본 때 공지 상태(then)와 지금 운영 DB 노출본(live)을 공지별로 견줘
// 다른 공지만 '되돌림'으로 표시함. 같은 공지는 표시하지 않음(앞 되돌리기의 표시도 이 계산으로 새로 정해짐)
export function noticeHoldFor(
  then: readonly Notice[],
  live: readonly Notice[],
  target: string,
  at: string,
): Record<string, HeldNotice> {
  const before = new Map(then.map((notice) => [notice.id, notice]));
  const now = new Map(live.map((notice) => [notice.id, notice]));
  const held: Record<string, HeldNotice> = {};
  for (const id of [...new Set([...before.keys(), ...now.keys()])].sort()) {
    const was = before.get(id) ?? null;
    if (JSON.stringify(was) === JSON.stringify(now.get(id) ?? null)) continue;
    held[id] = { target, at, live: was };
  }
  return held;
}
