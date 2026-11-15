import { describe, expect, it } from "vitest";
import {
  failureDetailsOf,
  pendingNoticeDiff,
  sequenceOf,
  type NoticeSnapshot,
  type PendingNotice,
} from "./publish";

// 게시 실패 요약·대기 공지 전체 비교 (#502, 서버 #499)
describe("failureDetailsOf", () => {
  const failed = { result: "failed", reason: "beach_ids" } as const;

  it("실패한 실행의 허용한 모양만 돌려줌", () => {
    const details = {
      kind: "beach_ids",
      where: "status",
      missingCount: 1,
      extraCount: 0,
      duplicateCount: 2,
    } as const;
    expect(failureDetailsOf({ ...failed, failureDetails: details })).toEqual(
      details,
    );
    expect(
      failureDetailsOf({
        result: "failed",
        reason: "contract",
        failureDetails: {
          kind: "contract",
          errorCount: 3,
          paths: ["StatusFile:/beaches/b0001/observation:required:metrics"],
        },
      }),
    ).toMatchObject({ kind: "contract", errorCount: 3 });
    expect(
      failureDetailsOf({
        result: "failed",
        reason: "classify",
        failureDetails: { kind: "classify", beachId: "b0094" },
      }),
    ).toEqual({ kind: "classify", beachId: "b0094" });
  });

  it("없거나·성공·사유와 종류가 다르거나·모양이 틀리면 null", () => {
    expect(failureDetailsOf(failed)).toBeNull();
    const details = {
      kind: "beach_ids",
      where: "status",
      missingCount: 1,
      extraCount: 0,
      duplicateCount: 0,
    } as const;
    expect(
      failureDetailsOf({ result: "published", failureDetails: details }),
    ).toBeNull();
    expect(
      failureDetailsOf({
        result: "failed",
        reason: "contract",
        failureDetails: details,
      }),
    ).toBeNull();
    expect(
      failureDetailsOf({
        ...failed,
        failureDetails: { ...details, missingCount: -1 },
      }),
    ).toBeNull();
    // 경로 형식은 서버가 검사함. 화면은 구조(비지 않은 문자열)만 봄
    expect(
      failureDetailsOf({
        result: "failed",
        reason: "contract",
        failureDetails: { kind: "contract", errorCount: 1, paths: [""] },
      }),
    ).toBeNull();
    expect(
      failureDetailsOf({
        result: "failed",
        reason: "contract",
        failureDetails: { kind: "contract", errorCount: 1, paths: [3] },
      } as never),
    ).toBeNull();
    expect(
      failureDetailsOf({
        result: "failed",
        reason: "contract",
        failureDetails: {
          kind: "contract",
          errorCount: 2,
          paths: Array.from(
            { length: 3 },
            () => "ManifestFile:/:required:files",
          ),
        },
      }),
    ).toBeNull();
  });
});

describe("sequenceOf", () => {
  it("1 이상 정수만 순번으로 보고, 없거나 틀리면 null", () => {
    expect(sequenceOf({ sequence: 12 })).toBe(12);
    expect(sequenceOf({})).toBeNull();
    for (const bad of [0, -1, 1.5, Number.NaN, "3"]) {
      expect(sequenceOf({ sequence: bad as number })).toBeNull();
    }
  });
});

describe("pendingNoticeDiff 전체 비교", () => {
  const fmt = (iso: string) => iso.slice(0, 16);
  const before: NoticeSnapshot = {
    id: "n-1",
    kind: "general",
    title: { ko: "주차장 공사", en: "Parking" },
    body: { ko: "일부 구역 공사", en: "Partial closure" },
    startsAt: "2026-11-12T00:00:00Z",
    endsAt: null,
  };
  const after: NoticeSnapshot = {
    ...before,
    body: { ko: "공사 연장", en: "Extended" },
  };
  const base: PendingNotice = {
    id: "n-1",
    change: "update",
    kind: "general",
    title: "주차장 공사",
    startsAt: before.startsAt,
    endsAt: null,
  };

  it("after와 before가 전체 모양이면 본문 한·영까지 비교", () => {
    const diff = pendingNoticeDiff(
      { ...base, before, after },
      "일반",
      fmt,
      "끝 없음",
    );
    expect(diff.hasBefore).toBe(true);
    expect(diff.full).toBe(true);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(2);
    expect(
      diff.lines.filter((l) => l.kind === "add").map((l) => l.text),
    ).toEqual(["body.ko: 공사 연장", "body.en: Extended"]);
  });

  it("after가 없으면(예전 서버) 4줄 비교 그대로", () => {
    const diff = pendingNoticeDiff({ ...base, before }, "일반", fmt, "끝 없음");
    expect(diff.full).toBe(false);
    expect(diff.lines.filter((l) => l.kind === "same")).toHaveLength(4);
    expect(diff.added).toBe(0);
  });

  it("추가 공지는 after 전체를 추가 줄로", () => {
    const diff = pendingNoticeDiff(
      { ...base, change: "add", after },
      "일반",
      fmt,
      "끝 없음",
    );
    expect(diff.added).toBe(7);
    expect(diff.lines.map((l) => l.text)).toContain("title.en: Parking");
  });

  it("여러 줄 본문은 줄마다 견주고, 줄 수가 달라도 바뀐 줄만 표시", () => {
    const longBefore: NoticeSnapshot = {
      ...before,
      body: { ko: "첫 문단\n둘째 문단", en: "One\nTwo" },
    };
    const longAfter: NoticeSnapshot = {
      ...before,
      body: { ko: "첫 문단\n둘째 문단 수정\n셋째 문단", en: "One\nTwo" },
    };
    const diff = pendingNoticeDiff(
      { ...base, before: longBefore, after: longAfter },
      "일반",
      fmt,
      "끝 없음",
    );
    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(2);
    expect(
      diff.lines.filter((l) => l.kind !== "same").map((l) => [l.kind, l.text]),
    ).toEqual([
      ["del", "body.ko: 둘째 문단"],
      ["add", "body.ko: 둘째 문단 수정"],
      ["add", "body.ko: 셋째 문단"],
    ]);
    // 줄 번호는 전후 따로 셈: 마지막 칸(endsAt)은 전 9번째, 후 10번째 줄
    const last = diff.lines.at(-1)!;
    expect(last).toMatchObject({ kind: "same", beforeLine: 9, afterLine: 10 });
  });
});
