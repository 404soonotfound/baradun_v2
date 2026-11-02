import { describe, expect, it } from "vitest";
import {
  CANONICAL_HOST_PLACEHOLDER,
  rewriteIndexCode,
} from "../lib/site/rewrite-index";

// CloudFront에 올릴 코드 문자열을 그대로 실행해서 확인함(올리기 전에 로컬에서 검사).
// 대표 주소 자리는 스택이 매개변수로 채움 → 여기서는 글자로 바꿔 넣음(빈 값 = 도메인 연결 전)
type QueryValue = { value: string; multiValue?: { value: string }[] };
type Request = {
  uri: string;
  headers: { host?: { value: string } };
  querystring: Record<string, QueryValue>;
};
type Redirect = {
  statusCode: number;
  headers: { location: { value: string } };
};

function handlerFor(canonicalHost: string) {
  const code = rewriteIndexCode
    .split(CANONICAL_HOST_PLACEHOLDER)
    .join(canonicalHost);
  return new Function(`${code}\nreturn handler;`)() as (event: {
    request: Request;
  }) => Request | Redirect;
}

const request = (
  uri: string,
  host = "d1gam1q4z69v8c.cloudfront.net",
  querystring: Record<string, QueryValue> = {},
): Request => ({ uri, headers: { host: { value: host } }, querystring });

describe("도메인 연결 전(대표 주소 비어 있음)", () => {
  const handler = handlerFor("");
  const rewrite = (uri: string) =>
    (handler({ request: request(uri) }) as Request).uri;

  describe("폴더 주소 → index.html", () => {
    it.each([
      ["/", "/index.html"],
      ["/en/", "/en/index.html"],
      ["/spots/gyeongpo/", "/spots/gyeongpo/index.html"],
      ["/spots/gyeongpo", "/spots/gyeongpo/index.html"],
      ["/en", "/en/index.html"],
    ])("%s → %s", (input, expected) => {
      expect(rewrite(input)).toBe(expected);
    });
  });

  describe("파일 주소는 그대로", () => {
    it.each([
      "/data/manifest.json",
      "/data/20261017T053000Z/status.json",
      "/_next/static/chunks/app.js",
      "/404.html",
      "/favicon.ico",
    ])("%s", (uri) => {
      expect(rewrite(uri)).toBe(uri);
    });
  });
});

describe("대표 주소 연결 뒤 (BRD-162)", () => {
  const handler = handlerFor("www.baradun.app");

  it("대표 주소로 온 요청은 이동하지 않고 폴더 주소만 바꿈", () => {
    expect(
      handler({ request: request("/en/", "www.baradun.app") }),
    ).toMatchObject({ uri: "/en/index.html" });
  });

  it("호스트 대소문자가 달라도 같은 주소로 봄", () => {
    expect(
      handler({ request: request("/explore/", "WWW.Baradun.App") }),
    ).toMatchObject({ uri: "/explore/index.html" });
  });

  it.each([
    ["CloudFront 기본 주소", "d1gam1q4z69v8c.cloudfront.net"],
    ["루트 주소", "baradun.app"],
    ["호스트 없음", ""],
  ])("%s로 온 요청은 같은 경로로 301 이동", (_, host) => {
    const result = handler({ request: request("/spots/gyeongpo/", host) });
    expect(result).toEqual({
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: {
        location: { value: "https://www.baradun.app/spots/gyeongpo/" },
      },
    });
  });

  it.each([
    "/data/manifest.json",
    "/data/20261017T053000Z/status.json",
    "/_next/static/chunks/app.js",
    "/sw.js",
  ])(
    "예전 주소의 파일 요청은 이동하지 않음(저장본 화면의 바다 정보·워커 갱신): %s",
    (uri) => {
      expect(handler({ request: request(uri) })).toMatchObject({ uri });
    },
  );

  it("이동할 때 쿼리를 그대로 붙임(같은 이름 여러 개·값 없는 키 포함)", () => {
    const result = handler({
      request: request("/search/", "d1gam1q4z69v8c.cloudfront.net", {
        q: { value: "%EA%B2%BD%ED%8F%AC" },
        tag: {
          value: "a",
          multiValue: [{ value: "a" }, { value: "b" }],
        },
        flag: { value: "" },
      }),
    }) as Redirect;
    expect(result.headers.location.value).toBe(
      "https://www.baradun.app/search/?q=%EA%B2%BD%ED%8F%AC&tag=a&tag=b&flag",
    );
  });
});
