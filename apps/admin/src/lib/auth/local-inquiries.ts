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
  status: Status;
  version: number;
  readonly legacy: boolean;
  message: string;
  memo: string | null;
  rejectReason: string | null;
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

// 처리 저장을 해 볼 수 있게 이 탭 메모리에서 바뀜(새로고침하면 처음으로)
const EXAMPLES: Example[] = Array.from({ length: 26 }, (_, i) => {
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
    version: 1,
    legacy: i === 20,
    // 개인정보 가리기를 해 볼 수 있게 몇 개에는 예시 이름·번호를 넣음(실제 사람 아님)
    message: `(로컬 예시 ${i + 1}) 현장에 입수 금지 깃발이 걸려 있어요. 15:10에 봤어요.${i % 4 === 0 ? "\n제 이름은 김바다, 번호는 010-0000-0000이에요." : ""}`,
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
    version: e.version,
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

// 처리 저장(PATCH). 서버처럼 version이 다르면 409, 반려는 이유가 필요함
export function localSaveInquiry<T>(id: string, body: unknown): OpsResult<T> {
  const e = EXAMPLES.find((x) => x.inquiryId === id);
  if (!e) return { ok: false, status: 404, code: "not_found", requestId: null };
  const patch = body as {
    version: number;
    status?: Status;
    memo?: string | null;
    rejectReason?: string;
    redactions?: { start: number; end: number; text: string }[];
  };
  if (patch.version !== e.version) {
    return {
      ok: false,
      status: 409,
      code: "conflict",
      requestId: null,
      reason: "version",
    };
  }
  if (patch.status === "rejected" && !patch.rejectReason?.trim()) {
    return {
      ok: false,
      status: 400,
      code: "invalid_request",
      requestId: null,
      field: "rejectReason",
    };
  }
  // 서버처럼 그 자리 글이 맞을 때만 가림(아무것도 바꾸기 전에 확인)
  if (
    patch.redactions &&
    !patch.redactions.every((r) => e.message.slice(r.start, r.end) === r.text)
  ) {
    return {
      ok: false,
      status: 400,
      code: "invalid_request",
      requestId: null,
      field: "redactions",
    };
  }
  if (patch.status) {
    e.status = patch.status;
    e.rejectReason = patch.status === "rejected" ? patch.rejectReason! : null;
  }
  if (patch.memo !== undefined) e.memo = patch.memo;
  if (patch.redactions) {
    // 뒤에서부터 바꿈(앞 위치가 밀리지 않게)
    for (const r of [...patch.redactions].reverse()) {
      e.message =
        e.message.slice(0, r.start) + "[가림]" + e.message.slice(r.end);
    }
  }
  e.version += 1;
  return {
    ok: true,
    status: 200,
    body: { inquiryId: id, version: e.version } as T,
  };
}
