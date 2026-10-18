import { describe, expect, it } from "vitest";
import { rewriteIndexCode } from "../lib/site/rewrite-index";

// CloudFront에 올릴 코드 문자열을 그대로 실행해서 확인해요(올리기 전에 로컬에서 검사).
const handler = new Function(
  `${rewriteIndexCode}\nreturn handler;`,
)() as (event: { request: { uri: string } }) => { uri: string };

const rewrite = (uri: string) => handler({ request: { uri } }).uri;

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
