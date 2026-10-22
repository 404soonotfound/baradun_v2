import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const state = vi.hoisted(() => ({ exists: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    existsSync: vi.fn(() => state.exists),
    readFileSync: vi.fn((path, encoding) => {
      // 이 파일 외에는 실제 디스크의 원자료를 읽지 않음.
      if (String(path).endsWith("/data-sources.json")) return fs.readFileSync(path, encoding);
      return Buffer.from("fixed source fixture");
    }),
  };
});
import { existsSync } from "node:fs";
import { sha256, verifyPinnedSources } from "../regions.mjs";

it("--input-dir의 수집본을 해시 검사하고 재실행 시 이전 해시 캐시를 버림", () => {
  state.exists = false;
  expect(sha256("/fixture/changed")).toBe(null);
  expect(() => verifyPinnedSources("/fixture/input")).toThrow(/원자료/);
  expect(vi.mocked(existsSync).mock.calls.map(([path]) => path)).toContain("/fixture/input/out/beaches.csv");
  expect(vi.mocked(existsSync).mock.calls.map(([path]) => path)).toContain("/fixture/input/responses/metric-matrix.json");
  state.exists = true;
  expect(() => verifyPinnedSources("/fixture/input")).toThrow(/해시 다름/);
  expect(sha256("/fixture/changed")).toBe(createHash("sha256").update("fixed source fixture").digest("hex"));
});
