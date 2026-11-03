import { describe, expect, it, vi } from "vitest";
import { CognitoError, callCognito, refreshTokens } from "./cognito-api";
import { poolConfigFrom } from "./config";
import { opsFetch } from "./ops-fetch";
import { COGNITO_ENDPOINT } from "./policy";

// Cognito 호출·운영 API 호출·풀 설정 (BRD-148)

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

describe("callCognito", () => {
  it("서명 없이 대상 이름 헤더로 부르고, 오류는 __type의 마지막 이름으로 돌려준다", async () => {
    const fetcher = vi.fn(async () =>
      json(400, {
        __type: "com.amazonaws#NotAuthorizedException",
        message: "x",
      }),
    );
    await expect(
      callCognito("ForgotPassword", {}, fetcher as never),
    ).rejects.toMatchObject({
      code: "NotAuthorizedException",
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(COGNITO_ENDPOINT);
    expect((init.headers as Record<string, string>)["x-amz-target"]).toBe(
      "AWSCognitoIdentityProviderService.ForgotPassword",
    );
  });

  it("네트워크 실패는 NetworkError", async () => {
    await expect(
      callCognito("X", {}, (async () => {
        throw new TypeError("offline");
      }) as never),
    ).rejects.toEqual(new CognitoError("NetworkError", "network"));
  });

  it("갱신 응답에 토큰이 없으면 실패로 본다", async () => {
    await expect(
      refreshTokens("client", "r", (async () => json(200, {})) as never),
    ).rejects.toMatchObject({ code: "InvalidResponse" });
  });
});

describe("opsFetch", () => {
  it("전용 헤더로 토큰을 보내고, 본문이 있으면 SHA-256과 멱등 키를 붙인다", async () => {
    const fetcher = vi.fn(async () => json(200, { ok: 1 }));
    const result = await opsFetch(
      "/ops/notices",
      async () => "access",
      {
        method: "POST",
        body: { a: 1 },
        idempotencyKey: "k",
      },
      fetcher as never,
    );
    expect(result).toEqual({ ok: true, status: 200, body: { ok: 1 } });
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-baradun-access-token"]).toBe("access");
    expect(headers.authorization).toBeUndefined();
    // sha256('{"a":1}')
    expect(headers["x-amz-content-sha256"]).toBe(
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
    expect(headers["x-idempotency-key"]).toBe("k");
  });

  it("토큰이 없으면 부르지 않고, 오류 응답은 code·requestId를 돌려준다", async () => {
    const fetcher = vi.fn(async () =>
      json(403, { error: { code: "forbidden", requestId: "req-12345678" } }),
    );
    expect(
      await opsFetch("/ops/me", async () => null, {}, fetcher as never),
    ).toEqual({
      ok: false,
      status: 0,
      code: "reauth",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await opsFetch("/ops/me", async () => "t", {}, fetcher as never),
    ).toEqual({
      ok: false,
      status: 403,
      code: "forbidden",
      requestId: "req-12345678",
    });
  });
});

describe("poolConfigFrom", () => {
  const good = {
    operatorPool: "ap-northeast-2_TestOperator",
    operatorClient: "testoperatorclient0000000001",
    demoPool: "ap-northeast-2_TestDemo",
    demoClient: "testdemoclient00000000000001",
  };
  it("네 값이 모두 맞을 때만 설정을 만든다(하나라도 비면 화면이 '설정 오류')", () => {
    expect(poolConfigFrom(good)?.demo.clientId).toBe(good.demoClient);
    expect(poolConfigFrom({ ...good, demoClient: undefined })).toBeNull();
    expect(
      poolConfigFrom({ ...good, operatorPool: "us-east-1_abc" }),
    ).toBeNull();
  });
});
