import type { SSMClient } from "@aws-sdk/client-ssm";
import { describe, expect, it } from "vitest";
import { ApiKeyMissingError } from "./api-keys";
import { SsmApiKeys, SsmApiKeyTags } from "./ssm";

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

describe("SsmApiKeyTags", () => {
  function tagClient(reply: unknown[] | Error) {
    const seen: { input: unknown; options: unknown }[] = [];
    const client = {
      send: async (command: { input: unknown }, options: unknown) => {
        seen.push({ input: command.input, options });
        if (reply instanceof Error) throw reply;
        return { TagList: reply };
      },
    } as unknown as Pick<SSMClient, "send">;
    return { client, seen };
  }

  it("키 파라미터 이름 규칙대로 태그만 읽고 취소 신호를 넘김(값을 읽는 GetParameter가 아님)", async () => {
    const { client, seen } = tagClient([
      { Key: "expires", Value: "2027-03-31" },
    ]);
    const signal = new AbortController().signal;
    const tags = await new SsmApiKeyTags(client).tags("kma-apihub", signal);
    expect(tags).toEqual([{ Key: "expires", Value: "2027-03-31" }]);
    expect(seen[0]!.input).toEqual({
      ResourceType: "Parameter",
      ResourceId: "/baradun/v2/api-keys/kma-apihub",
    });
    expect(seen[0]!.options).toEqual({ abortSignal: signal });
  });

  it("파라미터가 없으면(InvalidResourceId) ApiKeyMissingError, 그 밖의 오류는 그대로", async () => {
    const missing = Object.assign(new Error("x"), {
      name: "InvalidResourceId",
    });
    await expect(
      new SsmApiKeyTags(tagClient(missing).client).tags("data-go-kr"),
    ).rejects.toBeInstanceOf(ApiKeyMissingError);
    const denied = Object.assign(new Error("x"), {
      name: "AccessDeniedException",
    });
    const error = await new SsmApiKeyTags(tagClient(denied).client)
      .tags("data-go-kr")
      .catch((e: unknown) => e);
    expect(error).toBe(denied);
    expect(error).not.toBeInstanceOf(ApiKeyMissingError);
  });

  it("태그가 없으면 빈 배열", async () => {
    const client = {
      send: async () => ({}),
    } as unknown as Pick<SSMClient, "send">;
    expect(await new SsmApiKeyTags(client).tags("data-go-kr")).toEqual([]);
  });
});
