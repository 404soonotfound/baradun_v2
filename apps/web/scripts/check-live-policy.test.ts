import { describe, expect, it } from "vitest";

import { checkLivePolicy } from "./check-live-policy.mts";

// 웹 배포 전 판단 정책 버전 확인 (D20-6·7)
describe("checkLivePolicy", () => {
  const supported = ["warnings-1+observations-1"];

  it("운영 게시본의 정책을 이 빌드가 읽으면 통과", () => {
    expect(
      checkLivePolicy(
        { policyVersion: "warnings-1+observations-1" },
        supported,
      ),
    ).toMatchObject({ ok: true });
  });

  it("이 빌드가 모르는 정책이면 멈추고 publisher를 먼저 배포하라고 알림", () => {
    const result = checkLivePolicy(
      { policyVersion: "warnings-1+observations-0" },
      supported,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("npm run deploy:infra");
  });

  it("policyVersion을 읽지 못하면 확인 못 한 채 올리지 않음", () => {
    for (const manifest of [{}, { policyVersion: 1 }, "<html>", 3]) {
      expect(checkLivePolicy(manifest, supported).ok).toBe(false);
    }
  });

  it("게시본이 없으면(404, 주소가 틀렸을 수도 있음) 확인 못 한 채 올리지 않음", () => {
    expect(checkLivePolicy(null, supported).ok).toBe(false);
  });
});
