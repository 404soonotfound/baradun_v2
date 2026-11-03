import { describe, expect, it } from "vitest";
import { SAMPLE_CONFIG_KEY } from "./keys";
import { parseSamplePolicy, readSamplePolicy } from "./sample";

// 샘플 계정 허용 설정 (BRD-146, D16-A8)

const valid = {
  subs: ["abc"],
  allowedFrom: "2026-11-03T00:00:00Z",
  allowedUntil: "2026-11-04T00:00:00+09:00",
};

describe("샘플 설정 읽기", () => {
  it("정상 설정을 읽는다", () => {
    expect(parseSamplePolicy(valid)).toEqual({
      subs: ["abc"],
      allowedFrom: new Date("2026-11-03T00:00:00Z"),
      allowedUntil: new Date("2026-11-03T15:00:00Z"),
    });
  });

  it.each([
    ["항목 없음", undefined],
    ["sub 목록이 비어 있음", { ...valid, subs: [] }],
    ["sub가 문자열이 아님", { ...valid, subs: [1] }],
    ["시간대 없는 시각", { ...valid, allowedFrom: "2026-11-03T00:00:00" }],
    ["날짜만", { ...valid, allowedUntil: "2026-11-04" }],
    ["시작이 끝보다 늦음", { ...valid, allowedFrom: "2026-11-05T00:00:00Z" }],
    ["시작과 끝이 같음", { ...valid, allowedUntil: "2026-11-03T00:00:00Z" }],
  ])("%s이면 null(샘플 모두 거부)", (_, item) => {
    expect(parseSamplePolicy(item)).toBeNull();
  });

  it("admin#config/sample을 강한 일관성으로 읽는다", async () => {
    const sent: unknown[] = [];
    const client = {
      send: async (command: { input: unknown }) => {
        sent.push(command.input);
        return { Item: valid };
      },
    };
    const policy = await readSamplePolicy(client as never, "Ops");
    expect(policy?.subs).toEqual(["abc"]);
    expect(sent).toEqual([
      { TableName: "Ops", Key: SAMPLE_CONFIG_KEY, ConsistentRead: true },
    ]);
  });
});
