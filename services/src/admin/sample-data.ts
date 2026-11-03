import { INQUIRY_STATUSES, type InquiryStatus } from "../inquiry/policy";
import type { InquiryDetail, InquiryPage, InquirySummary } from "./inquiries";

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
  return { items, nextCursor: null };
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
