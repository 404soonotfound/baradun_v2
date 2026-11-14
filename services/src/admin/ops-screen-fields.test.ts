import { inquiryCountDetails, INQUIRY_METRICS_TIMEOUT_MS } from "./inquiries";
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

  it("문의 집계 조회가 멈추면 제한 시간에 응답하고 실패 결과를 캐시하지 않음", async () => {
    vi.useFakeTimers();
    try {
      const send = vi
        .fn()
        .mockImplementation(() => new Promise(() => undefined));
      const client = { send };
      const pending = inquiryCountDetails(client, "Inquiry", "Ops", NOW);
      await vi.advanceTimersByTimeAsync(INQUIRY_METRICS_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({
        receivedLast7d: null,
        resolvedLast7d: null,
        oldestUnprocessedAt: null,
      });
      expect(
        send.mock.calls.every(([, options]) => options.abortSignal.aborted),
      ).toBe(true);
      send.mockResolvedValue({ Count: 0, Items: [] });
      const next = await inquiryCountDetails(client, "Inquiry", "Ops", NOW);
      expect(next).toMatchObject({ receivedLast7d: 0, resolvedLast7d: 0 });
      const calls = send.mock.calls.length;
      expect(await inquiryCountDetails(client, "Inquiry", "Ops", NOW)).toEqual(
        next,
      );
      expect(send).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  const head = (sequence: number) => ({
    Item: { sequence, startedAtMs: NOW.getTime() },
  });
  const run = (sequence: number, at: string, result: string) => ({
    at,
    sk: "run#" + at,
    result,
    sequence,
  });

  it("24시간 창은 시작 경계를 제외하고 끝 경계를 포함함", async () => {
    const boundary = run(1, FROM, "published");
    const send = vi
      .fn()
      .mockResolvedValueOnce(head(3))
      .mockResolvedValueOnce({ Items: [boundary] })
      .mockResolvedValueOnce({
        Items: [
          boundary,
          run(2, "2026-11-13T15:00:00.001Z", "failed"),
          run(3, NOW.toISOString(), "unchanged"),
        ],
      })
      .mockResolvedValueOnce(head(3));
    expect(await readPublishLast24h({ send }, "Ops", NOW)).toEqual({
      runs: 2,
      succeeded: 0,
      failed: 1,
      skipped: 1,
    });
  });

  const runningHead = (expiresAt = NOW.getTime() + 1) => ({
    Item: { ...head(3).Item, owner: "running-owner", expiresAt },
  });

  it("진행 중인 마지막 실행의 결과를 기다리는 동안 완료 건수를 표시함", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(runningHead())
      .mockResolvedValueOnce({ Items: [run(1, FROM, "published")] })
      .mockResolvedValueOnce({
        Items: [run(2, "2026-11-14T14:59:00.000Z", "failed")],
      })
      .mockResolvedValueOnce(runningHead());
    await expect(readPublishLast24h({ send }, "Ops", NOW)).resolves.toEqual({
      runs: 1,
      succeeded: 0,
      failed: 1,
      skipped: 0,
    });
  });

  it.each([
    {
      latest: head(3),
      items: [run(2, "2026-11-14T14:59:00.000Z", "published")],
    },
    {
      latest: runningHead(NOW.getTime()),
      items: [run(2, "2026-11-14T14:59:00.000Z", "published")],
    },
    { latest: runningHead(), items: [] },
    { latest: runningHead(), items: [run(3, NOW.toISOString(), "published")] },
  ])(
    "유효한 잠금이 없거나 중간 순번이 빠지면 집계를 숨김",
    ({ latest, items }) => {
      const send = vi
        .fn()
        .mockResolvedValueOnce(runningHead())
        .mockResolvedValueOnce({ Items: [run(1, FROM, "published")] })
        .mockResolvedValueOnce({ Items: items })
        .mockResolvedValueOnce(latest);
      return expect(readPublishLast24h({ send }, "Ops", NOW)).rejects.toThrow(
        "게시 실행 집계 순번 누락",
      );
    },
  );

  it("24시간 이전 기록이 없거나 결과가 잘리면 정상 건수로 표시하지 않음", async () => {
    const noBaseline = vi
      .fn()
      .mockResolvedValueOnce(head(3))
      .mockResolvedValue({ Items: [] });
    await expect(
      readPublishLast24h({ send: noBaseline }, "Ops", NOW),
    ).rejects.toThrow("24시간 실행 기록 없음");
    const send = vi
      .fn()
      .mockResolvedValueOnce(head(3))
      .mockResolvedValueOnce({ Items: [run(1, FROM, "published")] })
      .mockResolvedValue({ Items: [], LastEvaluatedKey: { sk: "x" } });
    await expect(readPublishLast24h({ send }, "Ops", NOW)).rejects.toThrow(
      "조회 상한",
    );
  });
});
