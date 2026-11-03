import { INQUIRY_STATUSES, type InquiryStatus } from "../inquiry/policy";
import type { InquiryDetail, InquiryPage, InquirySummary } from "./inquiries";
import type { NoticeView } from "./notices";

// 샘플 계정 전용 예시 문의 (결정 기록 D15-3·D16-A8, 화면 설계서 6장 ADM-INQ '샘플 계정: 실제 문의 대신 예시 문의')
// 실제 문의 테이블을 읽지 않음. 실제 사람의 글·연락처를 넣지 않음
// 접수 시각은 요청 시각 기준으로 만들어 늘 보관 기한 안에 있는 것처럼 보이게 함

const EXAMPLES: ReadonlyArray<{
  id: string;
  type: string;
  beachId?: string;
  activity?: string;
  hoursAgo: number;
  status: InquiryStatus;
  message: string;
  memo: string | null;
  rejectReason: string | null;
}> = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    type: "data_error",
    beachId: "b0001",
    hoursAgo: 2,
    status: "received",
    message: "(예시) 앱의 파고 값이 현장과 달라 보여요.",
    memo: null,
    rejectReason: null,
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    type: "beach_request",
    activity: "surfing",
    hoursAgo: 30,
    status: "in_progress",
    message: "(예시) 서핑하는 해변을 더 넣어 주세요.",
    memo: "(예시) 출처 확인 중",
    rejectReason: null,
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    type: "other",
    hoursAgo: 80,
    status: "rejected",
    message: "(예시) 의미 없는 글",
    memo: null,
    rejectReason: "(예시) 내용이 없어 처리하지 않아요",
  },
];

const SAMPLE_IDS = new Set(EXAMPLES.map((e) => e.id));

function summaryOf(
  example: (typeof EXAMPLES)[number],
  now: Date,
): InquirySummary {
  return {
    inquiryId: example.id,
    type: example.type,
    ...(example.beachId ? { beachId: example.beachId } : {}),
    ...(example.activity ? { activity: example.activity } : {}),
    receivedAt: new Date(
      now.getTime() - example.hoursAgo * 3_600_000,
    ).toISOString(),
    status: example.status,
    version: 1,
    legacy: false,
  };
}

export function sampleInquiryPage(
  status: InquiryStatus | undefined,
  now: Date,
): InquiryPage {
  const items = EXAMPLES.filter((e) => !status || e.status === status)
    .sort(
      (a, b) =>
        INQUIRY_STATUSES.indexOf(a.status) -
          INQUIRY_STATUSES.indexOf(b.status) || a.hoursAgo - b.hoursAgo,
    )
    .map((e) => summaryOf(e, now));
  const counts = Object.fromEntries(
    INQUIRY_STATUSES.map((s) => [
      s,
      EXAMPLES.filter((e) => e.status === s).length,
    ]),
  ) as Record<InquiryStatus, number>;
  return { items, nextCursor: null, counts };
}

export function sampleInquiry(id: string, now: Date): InquiryDetail | null {
  if (!SAMPLE_IDS.has(id)) return null;
  const example = EXAMPLES.find((e) => e.id === id)!;
  return {
    ...summaryOf(example, now),
    restricted: false,
    message: example.message,
    memo: example.memo,
    rejectReason: example.rejectReason,
    emailCollected: false,
    photosCollected: false,
  };
}

// 샘플 계정 전용 예시 공지 (BRD-151). 실제 공지(공개 전 대기본·예약 문구 포함)를 읽지 않음
// 시각은 요청 시각 기준으로 만들어 노출 중·예약·대기가 늘 함께 보이게 함
export function sampleNotices(now: Date): { items: NoticeView[] } {
  const at = (hours: number) =>
    new Date(now.getTime() + hours * 3_600_000).toISOString();
  const maintenance = {
    kind: "maintenance_notice" as const,
    title: {
      ko: "(예시) 데이터 점검 예고",
      en: "(Example) Planned maintenance",
    },
    body: {
      ko: "(예시) 새벽에 갱신이 늦을 수 있어요",
      en: "(Example) Updates may be late overnight",
    },
    startsAt: at(-2),
    endsAt: at(22),
  };
  const general = {
    kind: "general" as const,
    title: { ko: "(예시) 새 해변 추가", en: "(Example) New beaches" },
    body: {
      ko: "(예시) 해변 몇 곳을 더했어요",
      en: "(Example) We added a few beaches",
    },
    startsAt: at(24),
    endsAt: null,
  };
  const base = { version: 2, updatedAt: at(-3), exposedAt: at(-3) };
  return {
    items: [
      {
        id: "sample-general",
        ...base,
        draft: general,
        live: general,
        state: "scheduled",
        pendingEdit: false,
        hidden: false,
      },
      {
        id: "sample-maintenance",
        ...base,
        draft: maintenance,
        live: maintenance,
        state: "live",
        pendingEdit: false,
        hidden: false,
      },
      {
        id: "sample-draft",
        version: 1,
        updatedAt: at(-1),
        exposedAt: null,
        draft: { ...general, startsAt: at(48) },
        live: null,
        state: "draft",
        pendingEdit: false,
        hidden: false,
      },
    ],
  };
}
