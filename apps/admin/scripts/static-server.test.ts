import { describe, expect, it } from "vitest";

import {
  buildOpsProxyTarget,
  proxyLocation,
  validateOpsProxyOrigin,
} from "../e2e/static-server.mjs";

describe("운영 API 로컬 프록시", () => {
  it("고정한 upstream origin에 /ops 경로와 쿼리만 붙인다", () => {
    expect(
      buildOpsProxyTarget(
        "/ops/inquiries/inq-1?cursor=next",
        "https://admin.example.test",
      )?.href,
    ).toBe("https://admin.example.test/ops/inquiries/inq-1?cursor=next");
  });

  it.each([
    "https://evil.example/ops/inquiries",
    "//evil.example/ops/inquiries",
  ])("absolute-form 요청도 호스트를 바꾸지 못함: %s", (requestUrl) => {
    const target = buildOpsProxyTarget(
      requestUrl,
      "https://admin.example.test",
    );
    expect(target?.origin).toBe("https://admin.example.test");
    expect(target?.pathname).toBe("/ops/inquiries");
  });

  it.each([
    "/not-ops/inquiries",
    "/ops",
    "/ops/",
    "/opsx/inquiries",
    "/ops/../internal",
    "/ops/%2e%2e/internal",
    "/ops/inquiries%2Fsecret",
  ])("/ops 밖이거나 인코딩된 경로를 거부함: %s", (requestUrl) => {
    expect(
      buildOpsProxyTarget(requestUrl, "https://admin.example.test"),
    ).toBeNull();
  });

  it("프록시 설정은 경로 없는 http(s) origin만 허용함", () => {
    expect(validateOpsProxyOrigin("http://127.0.0.1:4100")).toBe(
      "http://127.0.0.1:4100",
    );
    expect(() => validateOpsProxyOrigin("file:///tmp/ops")).toThrow(/http/);
    expect(() =>
      validateOpsProxyOrigin("https://admin.example.test/base"),
    ).toThrow(/origin/);
  });

  it("OPS_PROXY로 가는 Location은 이 서버 기준 경로로 바꾸고, 다른 출처는 그대로 둠", () => {
    const origin = "https://admin.example.test";
    expect(proxyLocation(`${origin}/ops/me?x=1`, origin)).toBe("/ops/me?x=1");
    expect(proxyLocation("/ops/me", origin)).toBe("/ops/me");
    expect(proxyLocation("https://idp.example/login", origin)).toBe(
      "https://idp.example/login",
    );
    expect(proxyLocation(null, origin)).toBeNull();
  });
});
