import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

// 고정 해시를 아직 넣지 않은 원자료(받기 전 읍면동 경계)는 파일이 있어도 통과시키지 않음
const content = Buffer.from("downloaded boundary fixture");
const hash = createHash("sha256").update(content).digest("hex");
const entry = (role: string, path: string, sha256: string | null) => ({ name: role, role, path, sha256, encoding: "cp949" });
const state = vi.hoisted(() => ({ pinned: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn((path) => {
      if (String(path).endsWith("/data-sources.json"))
        return JSON.stringify({
          files: [
            entry("emd_boundary_shp", "$BARADUN_GIS_DIR/legal_area/EMD.shp", state.pinned),
            entry("emd_boundary_dbf", "$BARADUN_GIS_DIR/legal_area/EMD.dbf", state.pinned),
          ],
        });
      return content;
    }),
  };
});

it("고정 해시가 비어 있으면 '고정 해시 없음'으로 생성 중단", async () => {
  vi.resetModules();
  state.pinned = null;
  const { verifyPinnedSources, emdSource } = await import("../regions.mjs");
  expect(emdSource().label).toBe("$BARADUN_GIS_DIR/legal_area/EMD.shp");
  expect(emdSource().dbfLabel).toBe("$BARADUN_GIS_DIR/legal_area/EMD.dbf");
  expect(() => verifyPinnedSources("/fixture/input")).toThrow(/EMD\.shp\(고정 해시 없음\).*EMD\.dbf\(고정 해시 없음\)/);
});

it("고정 해시가 지금 파일과 같으면 통과", async () => {
  vi.resetModules();
  state.pinned = hash;
  const { verifyPinnedSources } = await import("../regions.mjs");
  expect(() => verifyPinnedSources("/fixture/input")).not.toThrow();
});
