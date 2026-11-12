import {
  METRIC_EXPIRY_MS,
  OBSERVATION_POLICY_VERSION,
  POLICY_HISTORY,
  POLICY_VERSION,
  WARNING_CONFIRMATION_TTL_MS,
  WARNING_POLICY_VERSION,
} from "@baradun/contracts/judgment-policy";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OBSERVATION_POLICY } from "../core/observations/policy";
import { WARNING_POLICY } from "../core/warnings/policy";
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

  // 정책 이력 고정표. 있는 줄은 고치지 않고, 정책을 바꿀 때 이 표와 POLICY_HISTORY 끝에 같은 새 항목을 더하기만 함
  // 있는 항목의 policyVersion만 새 값으로 고치면 여기서 실패 → 새 항목(더 큰 minWebBuild)을 더해야 하고,
  // 그러면 아래 시험이 MANIFEST_SETTINGS.minWebBuild도 올리게 함(정책만 바꾸고 minWebBuild를 그대로 둘 수 없음)
  // 전체를 비교함: 더한 항목을 이 표에 넣지 않으면 실패 → 나중에 그 항목을 그 자리에서 고치는 것도 잡힘
  it("이미 게시에 쓴 정책 이력 항목은 고치지 않고 끝에 더하기만 한다", () => {
    const released = [
      { policyVersion: "warnings-1+observations-1", minWebBuild: 1 },
    ];
    expect(POLICY_HISTORY).toEqual(released);
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

// 판단 정책 상수는 계약 패키지 한 곳에만 정의함(D20-5). services 쪽에 다시 적으면 웹과 값이 갈릴 수 있음
describe("판단 정책 상수는 계약 패키지 한 곳에만 정의한다 (D20-5)", () => {
  // 분류 코드는 WARNING_POLICY·OBSERVATION_POLICY로만 값을 읽음 → 이 둘이 계약 패키지 값 그대로인지 봄
  // expiryMs는 같은 객체여야 함(값만 같은 사본을 따로 두면 실패)
  it("특보·관측 정책 객체는 계약 패키지의 값을 그대로 쓴다", () => {
    expect(WARNING_POLICY.version).toBe(WARNING_POLICY_VERSION);
    expect(WARNING_POLICY.confirmationTtlMs).toBe(WARNING_CONFIRMATION_TTL_MS);
    expect(OBSERVATION_POLICY.version).toBe(OBSERVATION_POLICY_VERSION);
    expect(OBSERVATION_POLICY.expiryMs).toBe(METRIC_EXPIRY_MS);
  });

  // 원본 글자를 훑는 안전망. 식 모양이 다른 사본(예: 1.5 * HOUR)까지 잡지는 못함
  // - 정책 버전 글자(warnings-1·observations-1)는 services 어디에도 다시 적지 않음(주석·이어 붙인 글자 포함)
  // - 45분·90분을 숫자로 적은 식(곱하는 순서 둘 다)은 판단 코드 폴더(특보·관측·게시)에 두지 않음
  //   60분은 한 시간(HOUR_MS)과 같은 숫자라 글자로 가릴 수 없음 → 위 시험(같은 객체)으로 봄
  const VERSION_LITERAL = /\b(warnings|observations)-\d/;
  const MINUTE_UNIT = "(60\\s*\\*\\s*1000|60_?000|MINUTE(_MS)?)";
  const MINUTES_LITERAL = new RegExp(
    `\\b(45|90)\\s*\\*\\s*${MINUTE_UNIT}\\b|\\b${MINUTE_UNIT}\\s*\\*\\s*(45|90)\\b|\\b(2_?700_?000|5_?400_?000)\\b`,
  );
  const SRC = new URL("../", import.meta.url);
  const JUDGMENT_DIRS = ["core/warnings/", "core/observations/", "publisher/"];

  const sources = (readdirSync(SRC, { recursive: true }) as string[])
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));

  function hits(file: string, pattern: RegExp): string[] {
    return readFileSync(new URL(file, SRC), "utf8")
      .split("\n")
      .flatMap((line, i) => (pattern.test(line) ? [`${file}:${i + 1}`] : []));
  }

  it("훑는 식이 계약 패키지의 정의는 찾아낸다(빈 검사가 아님)", () => {
    const contract = readFileSync(
      new URL(
        "../../../packages/contracts/src/judgment-policy.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(VERSION_LITERAL.test(contract)).toBe(true);
    expect(MINUTES_LITERAL.test(contract)).toBe(true);
    expect(sources).toContain("core/warnings/policy.ts");
    expect(sources).toContain("core/observations/policy.ts");
  });

  it("정책 버전 글자를 services에 다시 적지 않는다", () => {
    expect(sources.flatMap((file) => hits(file, VERSION_LITERAL))).toEqual([]);
  });

  it("판단 코드 폴더에 45분·90분을 숫자로 다시 적지 않는다", () => {
    const judgment = sources.filter((file) =>
      JUDGMENT_DIRS.some((dir) => file.startsWith(dir)),
    );
    expect(judgment.length).toBeGreaterThan(0);
    expect(judgment.flatMap((file) => hits(file, MINUTES_LITERAL))).toEqual([]);
  });
});
