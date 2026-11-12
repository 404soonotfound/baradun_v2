import {
  METRIC_EXPIRY_MS,
  OBSERVATION_POLICY_VERSION,
  POLICY_HISTORY,
  POLICY_VERSION,
  WARNING_CONFIRMATION_TTL_MS,
  WARNING_POLICY_VERSION,
} from "@baradun/contracts/judgment-policy";
import { describe, expect, it } from "vitest";
import { MANIFEST_SETTINGS, PUBLISH_POLICY } from "./policy";

// 판단 정책 버전과 최소 화면 버전(결정 기록 D20-5~7)
// 정책 값을 바꾸면 version이 바뀌고, 그 PR에서 POLICY_HISTORY 끝에 새 항목(더 큰 minWebBuild)을 더하고
// MANIFEST_SETTINGS.minWebBuild도 그 값 이상으로 올려야 이 시험이 통과함(옛 화면은 강제 업데이트 → 모르는 정책을 읽지 않음)
describe("판단 정책 버전과 minWebBuild (D20-7)", () => {
  it("게시하는 policyVersion은 계약 패키지의 지금 정책이고, 정책 이력의 마지막 항목이다", () => {
    expect(PUBLISH_POLICY.policyVersion).toBe(POLICY_VERSION);
    expect(POLICY_HISTORY.at(-1)?.policyVersion).toBe(POLICY_VERSION);
  });

  it("정책 이력은 버전이 겹치지 않고 minWebBuild가 항목마다 커진다", () => {
    const versions = POLICY_HISTORY.map((entry) => entry.policyVersion);
    expect(new Set(versions).size).toBe(versions.length);
    for (let i = 1; i < POLICY_HISTORY.length; i += 1) {
      expect(POLICY_HISTORY[i]!.minWebBuild).toBeGreaterThan(
        POLICY_HISTORY[i - 1]!.minWebBuild,
      );
    }
  });

  it("게시하는 minWebBuild는 지금 정책을 처음 읽는 화면 빌드 이상이다", () => {
    expect(MANIFEST_SETTINGS.minWebBuild).toBeGreaterThanOrEqual(
      POLICY_HISTORY.at(-1)!.minWebBuild,
    );
  });

  // 버전별 정책값 고정표. 이미 있는 항목은 고치지 않고, 값을 바꾸면 새 version 항목을 더함
  // (값만 바꾸고 version을 그대로 두면 여기서 실패 → 옛 화면이 다른 기준의 데이터를 같은 정책으로 읽지 않게)
  it("정책값을 바꾸면 version도 바뀐다", () => {
    const MINUTE = 60 * 1000;
    const warnings: Record<string, number> = { "warnings-1": 45 * MINUTE };
    const observations: Record<string, typeof METRIC_EXPIRY_MS> = {
      "observations-1": {
        waveHeight: 90 * MINUTE,
        waterTemp: 90 * MINUTE,
        wind: 90 * MINUTE,
        wavePeriod: 60 * MINUTE,
        waveDirection: 60 * MINUTE,
      },
    };
    expect(warnings[WARNING_POLICY_VERSION]).toBe(WARNING_CONFIRMATION_TTL_MS);
    expect(observations[OBSERVATION_POLICY_VERSION]).toEqual(METRIC_EXPIRY_MS);
  });
});
