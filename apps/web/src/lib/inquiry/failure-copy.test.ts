import { describe, expect, it } from "vitest";

import { failureCopy } from "./failure-copy";

// 문의 실패 안내 문구 고르기 (BRD-111 · 결정 27): 무슨 일 → 영향 → 다음 행동
const message = { stage: "message", photos: 0 } as const;
const uncertain = { stage: "message", photos: 0, uncertain: true } as const;

describe("failureCopy", () => {
  it("문의 요청 뒤 응답을 못 받으면 접수 여부를 모른다고 알리고 같은 내용으로 다시 보내라고 함", () => {
    expect(failureCopy({ failure: "network", stop: message })).toEqual({
      unknown: true,
      title: "titleUnknown",
      cause: "network",
      impact: { key: "stopUnknown" },
      next: "next.unknown",
    });
  });

  it("앞 시도가 불확실한 채 재시도가 429면 '이번 재시도'를 받지 못했다고 하고 몇 분 뒤 다시 보내라고 함", () => {
    expect(
      failureCopy({ failure: "rateLimited", stop: uncertain }),
    ).toMatchObject({
      unknown: true,
      cause: "rateLimitedRetry",
      impact: { key: "stopUnknown" },
      next: "next.unknownLater",
    });
  });

  it("앞 시도가 불확실한 채 연결이 없으면 연결 확인을 다음 행동에 넣음", () => {
    expect(failureCopy({ failure: "offline", stop: uncertain })).toMatchObject({
      unknown: true,
      cause: "offline",
      next: "next.unknownOffline",
    });
  });

  it("처음부터 429·400·연결 없음·그 밖의 4xx면 접수되지 않았다고 하고 원인별 다음 행동", () => {
    for (const [failure, next] of [
      ["rateLimited", "next.rateLimited"],
      ["rejected", "next.rejected"],
      ["offline", "next.offline"],
      ["refused", "next.later"],
    ] as const) {
      expect(failureCopy({ failure, stop: message }), failure).toEqual({
        unknown: false,
        title: "title",
        cause: failure,
        impact: { key: "stopMessage" },
        next,
      });
    }
  });

  it("사진을 일부만 올리고 멈추면 장수를 알리고, 사진을 모두 올린 뒤 거절되면 올린 장수와 함께 접수 안 됨", () => {
    expect(
      failureCopy({
        failure: "unavailable",
        stop: { stage: "photos", uploaded: 1, total: 3 },
      }),
    ).toMatchObject({
      unknown: false,
      impact: { key: "stopPhotos", values: { uploaded: 1, total: 3 } },
      next: "next.later",
    });
    expect(
      failureCopy({
        failure: "offline",
        stop: { stage: "photos", uploaded: 0, total: 2 },
      }).impact,
    ).toEqual({ key: "stopMessage" });
    expect(
      failureCopy({
        failure: "rateLimited",
        stop: { stage: "message", photos: 2 },
      }).impact,
    ).toEqual({ key: "stopMessageAfterPhotos", values: { count: 2 } });
  });
});
