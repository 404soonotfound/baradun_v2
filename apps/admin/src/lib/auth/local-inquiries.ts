import type { OpsResult } from "./ops-fetch";

// 로컬 테스트 로그인용 예시 문의 (BRD-153). local-dev.ts가 불러와 개발 서버에서만 씀(배포 빌드에서 빠짐)
// 쪽 넘기기를 볼 수 있게 한 쪽(20)보다 많이 둠. 시각은 요청 시각 기준으로 만듦

const STATUSES = ["received", "in_progress", "resolved", "rejected"] as const;
type Status = (typeof STATUSES)[number];

interface Example {
  readonly inquiryId: string;
  readonly type: string;
  readonly beachId?: string;
  readonly activity?: string;
  readonly hoursAgo: number;
  readonly status: Status;
  readonly legacy: boolean;
  readonly message: string;
  readonly memo: string | null;
  readonly rejectReason: string | null;
}

const TYPES = [
  "data_error",
  "beach_request",
  "data_question",
  "data_suggestion",
];
const BEACHES: readonly (readonly [string | undefined, string | undefined])[] =
  [
    ["b0001", "swimming"],
    ["b0002", "surfing"],
    [undefined, undefined],
    ["b0003", "swimming"],
    ["b9999", "scuba"], // 해변 목록에 없는 ID(이름표에 없을 때 화면 확인용)
  ];

const EXAMPLES: readonly Example[] = Array.from({ length: 26 }, (_, i) => {
  const status: Status =
    i < 9
      ? "received"
      : i < 13
        ? "in_progress"
        : i < 22
          ? "resolved"
          : "rejected";
  const [beachId, activity] = BEACHES[i % BEACHES.length]!;
  return {
    inquiryId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    type: TYPES[i % TYPES.length]!,
    ...(beachId ? { beachId } : {}),
    ...(activity ? { activity } : {}),
    hoursAgo: 2 + i * 7,
    status,
    legacy: i === 20,
    message: `(로컬 예시 ${i + 1}) 현장에 입수 금지 깃발이 걸려 있어요. 15:10에 봤어요.`,
    memo: i % 3 === 0 ? "출입 통제는 출시에 판단하지 않음(G2)." : null,
    rejectReason: status === "rejected" ? "내용을 알아볼 수 없어요." : null,
  };
});

function summary(e: Example, now: number) {
  return {
    inquiryId: e.inquiryId,
    type: e.type,
    ...(e.beachId ? { beachId: e.beachId } : {}),
    ...(e.activity ? { activity: e.activity } : {}),
    receivedAt: new Date(now - e.hoursAgo * 3_600_000).toISOString(),
    status: e.status,
    version: 1,
    legacy: e.legacy,
  };
}

// cursor는 '몇 번째부터'만 담음(로컬 예시라 서버 cursor 모양을 흉내 내지 않음)
export function localInquiryPage<T>(query: URLSearchParams): OpsResult<T> {
  const now = Date.now();
  const status = query.get("status");
  const limit = Number(query.get("limit") ?? 20);
  const start = Number(query.get("cursor") ?? 0);
  const rows = EXAMPLES.filter((e) => !status || e.status === status);
  const page = rows.slice(start, start + limit);
  const counts = Object.fromEntries(
    STATUSES.map((s) => [s, EXAMPLES.filter((e) => e.status === s).length]),
  );
  return {
    ok: true,
    status: 200,
    body: {
      items: page.map((e) => summary(e, now)),
      nextCursor: start + limit < rows.length ? String(start + limit) : null,
      ...(query.get("cursor") ? {} : { counts }),
    } as T,
  };
}

export function localInquiry<T>(id: string): OpsResult<T> {
  const e = EXAMPLES.find((x) => x.inquiryId === id);
  if (!e) {
    return { ok: false, status: 404, code: "not_found", requestId: null };
  }
  return {
    ok: true,
    status: 200,
    body: {
      ...summary(e, Date.now()),
      restricted: false,
      message: e.message,
      memo: e.memo,
      rejectReason: e.rejectReason,
      emailCollected: false,
      photosCollected: false,
    } as T,
  };
}
