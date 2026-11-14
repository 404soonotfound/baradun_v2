import { describe, expect, it, vi } from "vitest";
import { lookupActorEmails } from "./actor-emails";
import { nextCollectionAt } from "./collection";
import { readPublishLast24h, pendingNoticesOf } from "./publish-reads";

const NOW = new Date("2026-11-14T15:00:00.000Z");
const FROM = "2026-11-13T15:00:00.000Z";

describe("운영 화면 보강 필드", () => {
  it("이메일 조회 실패는 기록 자체를 숨기거나 sub를 표시값으로 바꾸지 않음", async () => {
    const findEmailBySub = vi.fn(async () => {
      throw new Error("lookup failed");
    });
    expect(
      await lookupActorEmails(["one-sub", "one-sub"], { findEmailBySub }),
    ).toEqual(new Map());
    expect(findEmailBySub).toHaveBeenCalledTimes(1);
  });

  it("예정 시각은 정책 슬롯과 이안류 시즌 경계를 따름", () => {
    expect(
      nextCollectionAt("collect-warnings", Date.parse("2026-11-14T01:03:00Z")),
    ).toBe("2026-11-14T01:18:00.000Z");
    expect(
      nextCollectionAt("collect-catalog", Date.parse("2026-11-14T20:00:00Z")),
    ).toBe("2026-11-15T19:20:00.000Z");
    expect(
      nextCollectionAt("collect-rip", Date.parse("2026-11-14T01:00:00Z")),
    ).toBe("2026-11-14T19:12:00.000Z");
    expect(
      nextCollectionAt("collect-rip", Date.parse("2026-05-31T14:00:00Z")),
    ).toBe("2026-05-31T15:12:00.000Z");
  });

  it("대기 중인 공지 수정의 이전 내용은 실제 게시본에서 가져옴", () => {
    const current = {
      id: "test",
      kind: "general" as const,
      title: { ko: "이전", en: "Before" },
      body: { ko: "본문", en: "Body" },
      startsAt: FROM,
      endsAt: null,
    };
    const draft = { ...current, title: { ko: "수정", en: "After" } };
    expect(
      pendingNoticesOf(
        [
          {
            id: "test",
            version: 2,
            draft,
            live: draft,
            deletedAt: null,
            updatedAt: FROM,
            exposedAt: FROM,
          },
        ],
        null,
        [current],
        NOW.getTime(),
      ),
    ).toEqual([
      expect.objectContaining({
        id: "test",
        change: "update",
        title: "수정",
        before: current,
      }),
    ]);
  });

  it("24시간 창은 시작 경계를 제외하고 끝 경계를 포함함", async () => {
    const run = (at: string, result: string) => ({
      at,
      sk: "run#" + at,
      result,
    });
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [run(FROM, "published")] })
      .mockResolvedValueOnce({
        Items: [
          run(FROM, "published"),
          run("2026-11-13T15:00:00.001Z", "failed"),
          run(NOW.toISOString(), "unchanged"),
        ],
      });
    expect(await readPublishLast24h({ send }, "Ops", NOW)).toEqual({
      runs: 2,
      succeeded: 0,
      failed: 1,
      skipped: 1,
    });
  });

  it("24시간 이전 기록이 없거나 결과가 잘리면 정상 건수로 표시하지 않음", async () => {
    await expect(
      readPublishLast24h(
        { send: vi.fn().mockResolvedValue({ Items: [] }) },
        "Ops",
        NOW,
      ),
    ).rejects.toThrow("24시간 실행 기록 없음");
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [{ at: FROM }] })
      .mockResolvedValue({ Items: [], LastEvaluatedKey: { sk: "x" } });
    await expect(readPublishLast24h({ send }, "Ops", NOW)).rejects.toThrow(
      "조회 상한",
    );
  });
});
