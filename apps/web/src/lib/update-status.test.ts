import { describe, expect, it } from "vitest";

import { updateStatus } from "@/lib/update-status";

describe("updateStatus", () => {
  const base = { time: "14:30", online: true, live: true, delayed: 0 };

  it("게시 시각을 모르면 숨김(불러오는 중·처음부터 못 받음)", () => {
    expect(updateStatus({ ...base, time: null })).toEqual({ kind: "hidden" });
  });

  it("새로 받은 정보면 시각과 관측 지연 수", () => {
    expect(updateStatus(base)).toEqual({
      kind: "live",
      time: "14:30",
      delayed: 0,
    });
    expect(updateStatus({ ...base, delayed: 2 })).toEqual({
      kind: "live",
      time: "14:30",
      delayed: 2,
    });
  });

  it("오프라인·불러오기 실패면 지난 정보라고만(관측 지연 수를 지금처럼 보이지 않음)", () => {
    expect(updateStatus({ ...base, online: false, delayed: 3 })).toEqual({
      kind: "stale",
      time: "14:30",
    });
    expect(updateStatus({ ...base, live: false })).toEqual({
      kind: "stale",
      time: "14:30",
    });
  });
});
