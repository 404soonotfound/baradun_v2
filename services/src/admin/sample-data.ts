import { INQUIRY_STATUSES, type InquiryStatus } from "../inquiry/policy";
import type { InquiryDetail, InquiryPage, InquirySummary } from "./inquiries";
import type { NoticeView } from "./notices";
import { STATS_EVENTS, type StatsRange, type StatsResponse } from "./stats";
import { STATS_TIME_ZONE, statsDates, type StatsTrends } from "./stats-trends";

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
const SAMPLE_WEEK_HOURS = 7 * 24;

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
  // 운영 홈 문의 칸 지표(#479)도 예시 문의로 셈. 예시에는 완료 전환 기록이 없어 최근 7일 완료는 0
  const recent = EXAMPLES.filter((e) => e.hoursAgo < SAMPLE_WEEK_HOURS);
  const unprocessed = EXAMPLES.filter(
    (e) => e.status === "received" || e.status === "in_progress",
  );
  const oldestHours = Math.max(...unprocessed.map((e) => e.hoursAgo));
  return {
    items,
    nextCursor: null,
    counts: {
      ...counts,
      receivedLast7d: recent.length,
      resolvedLast7d: 0,
      oldestUnprocessedAt: unprocessed.length
        ? new Date(now.getTime() - oldestHours * 3_600_000).toISOString()
        : null,
    },
  };
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

const SAMPLE_MULTIPLIER: Record<StatsRange, number> = {
  today: 1,
  "7d": 6,
  "28d": 22,
  "60d": 44,
};

export function sampleStats(range: StatsRange, now: Date): StatsResponse {
  const m = SAMPLE_MULTIPLIER[range];
  return {
    configured: true,
    sample: true,
    fetchedAt: now.toISOString(),
    cached: false,
    range,
    realtime: {
      status: "ok",
      activeUsers: 14,
      pageViews: 32,
    },
    period: {
      status: "ok",
      activeUsers: 180 * m,
      pageViews: 420 * m,
      topBeaches: [
        { path: "/spots/haeundae", slug: "haeundae", pageViews: 85 * m },
        { path: "/spots/gwangan-ri", slug: "gwangan-ri", pageViews: 64 * m },
        { path: "/spots/gyeongpo", slug: "gyeongpo", pageViews: 47 * m },
      ],
      devices: [
        { category: "mobile", activeUsers: 132 * m },
        { category: "desktop", activeUsers: 43 * m },
        { category: "tablet", activeUsers: 5 * m },
      ],
      languages: [
        { language: "ko", activeUsers: 162 * m },
        { language: "en", activeUsers: 18 * m },
      ],
      metadata: {
        thresholding: false,
        sampling: false,
        otherRowLoss: false,
      },
    },
    events: STATS_EVENTS,
    trends: sampleTrends(range, now, m),
  };
}

const NO_LOSS = { thresholding: false, sampling: false, otherRowLoss: false };
const DAY_MS = 86_400_000;
// 하루 안 시간대별 예시 사용자 비율(합 1). 밤에 적고 낮·저녁에 많음
const HOUR_WEIGHTS = [
  1, 1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 6, 7, 7, 7, 6, 6, 6, 7, 6, 5, 4, 3, 2,
].map((w, _, all) => w / all.reduce((sum, v) => sum + v, 0));

// 예시 기간 추이(#480 응답과 같은 모양). 실제 GA4를 부르지 않고 범위·요청 시각으로 만듦
function sampleTrends(range: StatsRange, now: Date, m: number): StatsTrends {
  const dates = statsDates(range, now);
  const days: string[] = [];
  for (
    let day = Date.parse(dates.current.startDate);
    day <= Date.parse(dates.current.endDate);
    day += DAY_MS
  ) {
    days.push(new Date(day).toISOString().slice(0, 10));
  }
  const dailyUsers = (index: number) => 150 + ((index * 37) % 60);
  return {
    ...dates.current,
    ga4TimeZone: STATS_TIME_ZONE,
    timeZoneMismatch: false,
    daily: {
      rows: days.map((date, index) => ({
        date,
        activeUsers: dailyUsers(index),
        pageViews: dailyUsers(index) * 2 + 40,
      })),
      metadata: NO_LOSS,
    },
    hourly: {
      rows: HOUR_WEIGHTS.map((weight, hour) => {
        const reportedDays =
          hour < dates.currentHour ? days.length : days.length - 1;
        return {
          hour,
          averageActiveUsers: reportedDays
            ? Math.round(weight * 180 * 10) / 10
            : null,
          reportedDays,
        };
      }),
      metadata: NO_LOSS,
    },
    previous: dates.previous
      ? {
          ...dates.previous,
          activeUsers: 152 * m,
          pageViews: 371 * m,
          metadata: NO_LOSS,
        }
      : null,
    newUsers: 61 * m,
    newUsersMetadata: NO_LOSS,
    topScreens: {
      rows: [
        { path: "/", pageViews: 140 * m, other: false },
        { path: "/spots/haeundae", pageViews: 85 * m, other: false },
        { path: "/explore", pageViews: 72 * m, other: false },
        { path: "/spots/gwangan-ri", pageViews: 64 * m, other: false },
        { path: "/en/spots/gyeongpo", pageViews: 9 * m, other: false },
      ],
      metadata: NO_LOSS,
    },
    referrers: {
      rows: [
        { channel: "Organic Search", sessions: 96 * m, other: false },
        { channel: "Direct", sessions: 70 * m, other: false },
        { channel: "Organic Social", sessions: 21 * m, other: false },
        { channel: "Referral", sessions: 8 * m, other: false },
      ],
      metadata: NO_LOSS,
    },
  };
}
