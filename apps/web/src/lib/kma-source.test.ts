import { describe, expect, it } from "vitest";

import { showsKmaSource } from "./kma-source";

// 기상청 출처를 둘지 (BRD-113): 받은 실제 상태가 있을 때만, 개발용 예시는 숨김
describe("showsKmaSource", () => {
  const received = { statuses: {} } as Parameters<typeof showsKmaSource>[0];
  const none = { statuses: null };

  it("받은(또는 기기에 저장된) 실제 상태가 있으면 둠", () => {
    expect(showsKmaSource(received, false)).toBe(true);
  });

  it("불러오는 중·처음부터 못 받음(상태 없음)이면 두지 않음", () => {
    expect(showsKmaSource(none, false)).toBe(false);
  });

  it("개발용 예시 스냅샷이면 받은 상태가 있어도 두지 않음", () => {
    expect(showsKmaSource(received, true)).toBe(false);
    expect(showsKmaSource(none, true)).toBe(false);
  });
});
