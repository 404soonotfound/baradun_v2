import type { SSMClient } from "@aws-sdk/client-ssm";
import { describe, expect, it } from "vitest";
import { SsmApiKeys } from "./ssm";

// SSM 키 읽기 (BRD-56: API 키는 SSM에서 읽음). 실제 AWS 호출 없이 가짜 클라이언트로 확인
function fakeClient(values: (string | undefined | Error)[]) {
  const names: string[] = [];
  let calls = 0;
  const client = {
    send: async (command: {
      input: { Name?: string; WithDecryption?: boolean };
    }) => {
      names.push(`${command.input.Name}:${command.input.WithDecryption}`);
      const value = values[Math.min(calls, values.length - 1)];
      calls += 1;
      if (value instanceof Error) throw value;
      return { Parameter: value === undefined ? undefined : { Value: value } };
    },
  } as unknown as Pick<SSMClient, "send">;
  return { client, names, calls: () => calls };
}

describe("SsmApiKeys", () => {
  it("이름 규칙대로 복호화해 읽고, 같은 키는 한 번만 읽음", async () => {
    const { client, names, calls } = fakeClient(["  key-1 "]);
    const keys = new SsmApiKeys(client);
    expect(await keys.get("kma-apihub")).toBe("key-1");
    expect(await keys.get("kma-apihub")).toBe("key-1");
    expect(names).toEqual(["/baradun/v2/api-keys/kma-apihub:true"]);
    expect(calls()).toBe(1);
  });

  it.each([undefined, "", "   "])(
    "값이 없으면 오류(키 없이 호출하지 않음): %j",
    async (value) => {
      const { client } = fakeClient([value]);
      await expect(new SsmApiKeys(client).get("data-go-kr")).rejects.toThrow(
        "API 키 없음: data-go-kr",
      );
    },
  );

  it("실패한 읽기는 남기지 않고 다음에 다시 읽음", async () => {
    const { client, calls } = fakeClient([new Error("throttled"), "key-2"]);
    const keys = new SsmApiKeys(client);
    await expect(keys.get("data-go-kr")).rejects.toThrow("throttled");
    expect(await keys.get("data-go-kr")).toBe("key-2");
    expect(calls()).toBe(2);
  });
});
