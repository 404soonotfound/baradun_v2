import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Notice } from "@baradun/contracts";
import {
  checkNoticePhrases,
  graphemeLength,
  NOTICE_DRAFT_TEXT_MAX,
  NOTICE_TEXT_MAX,
} from "@baradun/contracts/notice-rules";
import { NOTICE_PK, noticeKey } from "./keys";
import type { Sender } from "./writes";

// 공지 (BRD-151, 결정 기록 D16-B3·D1~D4, 아키텍처 18.4, 화면 설계서 6장 ADM-NTC)
// 저장: Ops admin#notice / {공지 ID}. 한 파티션이라 목록·publisher 모두 Query 한 번으로 읽음
// - draft: 편집 권한이 저장한 문구(화면 말 '대기'). 한·영 빈칸·글자 수 초과도 저장은 됨(D16-D1 초안 허용)
// - live: 노출 변경 권한이 '노출'로 확정한 사본. publisher는 이것만 게시본에 실음(D16-C4 확정한 공지만)
//   draft와 live가 다르면 '수정 대기'(D16-D4). 저장·노출 성공은 공개 반영이 아님(다음 게시 때 반영)
// - 삭제는 deletedAt만 남김(D16-D3 이력 보존). 노출 중이면 먼저 노출을 끝내야 지움
// - 시각은 UTC(Z)만 받음(KST·UTC를 섞지 않음, 구현 제안 I09)
// - 공지는 판단 상태·maintenance.active를 바꾸지 않음(D15-6·D16-B3)

export type NoticeKind = Notice["kind"];
export type NoticeContent = Omit<Notice, "id">;

export const NOTICE_KINDS: readonly NoticeKind[] = [
  "maintenance_notice",
  "general",
];

// 글자 수 상한(D16-D2)·표현 검사 목록(D17-8)은 운영자 화면과 같은 값을 쓰도록 계약 패키지 한 곳에 둠
export { graphemeLength, NOTICE_DRAFT_TEXT_MAX, NOTICE_TEXT_MAX };

export interface NoticeRecord {
  readonly id: string;
  readonly version: number;
  readonly draft: NoticeContent;
  readonly live: NoticeContent | null;
  // 마지막으로 노출을 확정한 시각(UTC). 게시 시각이 아님
  readonly exposedAt: string | null;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

// draft: 노출본 없음 · scheduled: 노출본 시작 전 · live: 노출 구간 안 · ended: 노출본 끝남
export type NoticeState = "draft" | "scheduled" | "live" | "ended";

export interface NoticeView extends Omit<NoticeRecord, "deletedAt"> {
  readonly state: NoticeState;
  // 저장한 문구가 노출본과 다름(D16-D4 '수정 대기')
  readonly pendingEdit: boolean;
  // 노출 구간 안이지만 한 자리 규칙에서 밀림(D16-D4 '가려짐')
  readonly hidden: boolean;
}

const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const NOTICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    UTC_ISO.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((k) => keys.includes(k));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNoticeId(value: string): boolean {
  return NOTICE_ID.test(value);
}

// ---- 요청 본문 ----

type Check<T> =
  ({ readonly ok: true } & T) | { readonly ok: false; readonly field: string };

function readText(
  value: unknown,
  name: "title" | "body",
): Check<{ text: NoticeContent["title"] }> {
  if (!isObject(value) || !hasOnlyKeys(value, ["ko", "en"])) {
    return { ok: false, field: name };
  }
  for (const lang of ["ko", "en"] as const) {
    const text = value[lang];
    if (typeof text !== "string" || text.length > NOTICE_DRAFT_TEXT_MAX) {
      return { ok: false, field: `${name}.${lang}` };
    }
  }
  return {
    ok: true,
    text: { ko: value.ko as string, en: value.en as string },
  };
}

// 만들기(POST)는 version 없이, 고치기(PUT)는 읽을 때 받은 version과 함께 보냄
// { version?, kind, title: {ko, en}, body: {ko, en}, startsAt, endsAt }
export function parseNoticeInput(
  value: unknown,
  mode: "create" | "update",
): Check<{ version: number; content: NoticeContent }> {
  const fields = ["kind", "title", "body", "startsAt", "endsAt"];
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, mode === "update" ? ["version", ...fields] : fields)
  ) {
    return { ok: false, field: "body" };
  }
  let version = 0;
  if (mode === "update") {
    if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
      return { ok: false, field: "version" };
    }
    version = value.version as number;
  }
  if (!(NOTICE_KINDS as readonly unknown[]).includes(value.kind)) {
    return { ok: false, field: "kind" };
  }
  const title = readText(value.title, "title");
  if (!title.ok) return title;
  const body = readText(value.body, "body");
  if (!body.ok) return body;
  if (!isUtc(value.startsAt)) return { ok: false, field: "startsAt" };
  if (value.endsAt !== null && !isUtc(value.endsAt)) {
    return { ok: false, field: "endsAt" };
  }
  return {
    ok: true,
    version,
    content: {
      kind: value.kind as NoticeKind,
      title: title.text,
      body: body.text,
      startsAt: value.startsAt,
      endsAt: value.endsAt as string | null,
    },
  };
}

// 노출·끝내기·지우기 본문: { version }
export function parseVersionBody(value: unknown): Check<{ version: number }> {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["version"]) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1
  ) {
    return { ok: false, field: "version" };
  }
  return { ok: true, version: value.version as number };
}

// 노출해도 되는지(D16-D1·D2·B3·D4). 한·영 모두 있고, 글자 수 안이고, 차단 표현이 없고,
// 끝이 시작 뒤이며 아직 지나지 않아야 함. 경고 표현은 막지 않음(화면이 알림)
export function exposeProblem(
  content: NoticeContent,
  now: Date,
): {
  field: string;
  reason: "required" | "too_long" | "blocked_phrase" | "order";
} | null {
  for (const name of ["title", "body"] as const) {
    for (const lang of ["ko", "en"] as const) {
      const text = content[name][lang];
      if (text.trim() === "") {
        return { field: `${name}.${lang}`, reason: "required" };
      }
      if (graphemeLength(text) > NOTICE_TEXT_MAX[name][lang]) {
        return { field: `${name}.${lang}`, reason: "too_long" };
      }
      if (checkNoticePhrases(text).blocked.length > 0) {
        return { field: `${name}.${lang}`, reason: "blocked_phrase" };
      }
    }
  }
  if (
    content.endsAt !== null &&
    (Date.parse(content.endsAt) <= Date.parse(content.startsAt) ||
      Date.parse(content.endsAt) <= now.getTime())
  ) {
    return { field: "endsAt", reason: "order" };
  }
  return null;
}

// ---- 저장된 항목 ----

function toContent(value: unknown): NoticeContent {
  if (
    !isObject(value) ||
    !(NOTICE_KINDS as readonly unknown[]).includes(value.kind) ||
    !isObject(value.title) ||
    !isObject(value.body) ||
    !["ko", "en"].every(
      (lang) =>
        typeof (value.title as Record<string, unknown>)[lang] === "string" &&
        typeof (value.body as Record<string, unknown>)[lang] === "string",
    ) ||
    !isUtc(value.startsAt) ||
    (value.endsAt !== null && !isUtc(value.endsAt))
  ) {
    throw new Error("공지 항목 모양이 틀림");
  }
  const title = value.title as Record<string, string>;
  const body = value.body as Record<string, string>;
  return {
    kind: value.kind as NoticeKind,
    title: { ko: title.ko!, en: title.en! },
    body: { ko: body.ko!, en: body.en! },
    startsAt: value.startsAt,
    endsAt: value.endsAt as string | null,
  };
}

// 저장된 모양이 틀리면 조용히 빼지 않고 던짐(500) → 데이터 문제를 숨기지 않음
export function toRecord(item: Record<string, unknown>): NoticeRecord {
  if (
    item.pk !== NOTICE_PK ||
    typeof item.sk !== "string" ||
    item.id !== item.sk ||
    typeof item.version !== "number" ||
    typeof item.updatedAt !== "string" ||
    (item.exposedAt !== null && !isUtc(item.exposedAt)) ||
    (item.deletedAt !== null && !isUtc(item.deletedAt))
  ) {
    throw new Error("공지 항목 모양이 틀림");
  }
  return {
    id: item.sk,
    version: item.version,
    draft: toContent(item.draft),
    live: item.live === null ? null : toContent(item.live),
    exposedAt: item.exposedAt as string | null,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt as string | null,
  };
}

export async function getNotice(
  client: Sender,
  opsTable: string,
  id: string,
): Promise<NoticeRecord | null> {
  const result = await client.send(
    new GetCommand({
      TableName: opsTable,
      Key: noticeKey(id),
      ConsistentRead: true,
    }),
  );
  if (!result.Item) return null;
  const record = toRecord(result.Item);
  return record.deletedAt === null ? record : null;
}

// 지운 공지도 함께 돌려줌(publisher가 거름). 강한 일관성으로 읽음(저장 직후 목록에 바로 보이게)
// 모양이 틀린 항목: onInvalid가 없으면 던짐(운영 화면 목록은 500으로 숨기지 않음)
// publisher는 onInvalid로 그 항목만 빼고 알림 → 깨진 항목 하나 때문에 나머지 공지 변경(끝내기 등)이 막히지 않음
export async function queryNotices(
  client: Sender,
  opsTable: string,
  onInvalid?: (sk: string) => void,
): Promise<NoticeRecord[]> {
  const records: NoticeRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: opsTable,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": NOTICE_PK },
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      try {
        records.push(toRecord(item));
      } catch (error) {
        if (!onInvalid) throw error;
        onInvalid(String(item.sk));
      }
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return records;
}

export function noticeState(record: NoticeRecord, now: Date): NoticeState {
  if (record.live === null) return "draft";
  const nowMs = now.getTime();
  if (Date.parse(record.live.startsAt) > nowMs) return "scheduled";
  if (record.live.endsAt !== null && Date.parse(record.live.endsAt) <= nowMs) {
    return "ended";
  }
  return "live";
}

// 한 자리 규칙(D16-D4): 점검 예고 > 일반, 같은 종류는 시작이 늦은 공지, 같으면 ID 오름차순
// 웹(apps/web/src/lib/snapshot/notice.ts)과 같은 규칙. 웹 코드를 가져오지 않으므로 여기 따로 둠
function compareForSlot(a: Notice, b: Notice): number {
  if (a.kind !== b.kind) return a.kind === "maintenance_notice" ? -1 : 1;
  // 같은 시각을 다르게 쓴 값(.000Z·Z)도 같은 시작으로 보고 ID로 가름
  const later = Date.parse(b.startsAt) - Date.parse(a.startsAt);
  if (later !== 0) return later;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sameContent(a: NoticeContent, b: NoticeContent): boolean {
  return JSON.stringify(toContent(a)) === JSON.stringify(toContent(b));
}

// 목록: 지운 공지는 빼고, 시작 시각이 늦은 순
export function noticeViews(
  records: readonly NoticeRecord[],
  now: Date,
): NoticeView[] {
  const alive = records.filter((r) => r.deletedAt === null);
  const showing = alive
    .filter((r) => noticeState(r, now) === "live")
    .map((r) => ({ id: r.id, ...r.live! }))
    .sort(compareForSlot);
  const selected = showing[0]?.id;
  return alive
    .map(({ deletedAt: _, ...record }) => {
      const state = noticeState(record as NoticeRecord, now);
      return {
        ...record,
        state,
        pendingEdit:
          record.live !== null && !sameContent(record.draft, record.live),
        hidden: state === "live" && record.id !== selected,
      };
    })
    .sort(
      (a, b) =>
        Date.parse(b.draft.startsAt) - Date.parse(a.draft.startsAt) ||
        (a.id < b.id ? -1 : 1),
    );
}

// publisher가 게시본에 싣는 공지 후보: 지우지 않았고 노출본이 있는 것(시각 판단·계약 검사는 publisher가 함)
export function liveNotices(records: readonly NoticeRecord[]): Notice[] {
  return records
    .filter((r) => r.deletedAt === null && r.live !== null)
    .map((r) => ({ id: r.id, ...r.live! }));
}

// 감사 기록의 바뀐 항목 이름(값은 넣지 않음)
export function noticeChanges(
  before: NoticeContent | null,
  after: NoticeContent,
): string[] {
  return (["kind", "title", "body", "startsAt", "endsAt"] as const).filter(
    (field) =>
      before === null ||
      JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
}
