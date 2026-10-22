import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annex9Lookup, zoneOf } from "../annex.mjs";
import { seaEvidenceFor, zoneProofVerified } from "../zone-proof.mjs";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
const checkedAt = "2026-10-22T10:00:00+09:00";
const sourceText = "sido_nm,gugun_nm,sta_nm\n강원,강릉시,강문\n";
const context = { sourceSha: createHash("sha256").update(sourceText).digest("hex"), collectedAt: "2026-10-16T10:55:24+09:00", checkedAt };
const src = (sigungu: string, sido = "강원") => ({ sido_nm: sido, gugun_nm: sigungu, sta_nm: "고정 해변" });
const coord = { result: "VERIFIED", emd: { emd_nm: "강문동" } };

describe("강원도 전국과 같은 별표 경로로 판정", () => {
  it.each([
    ["고성군", "거진읍", "S1151100", "L1022210"],
    ["속초시", "대포동", "S1151100", "L1022110"],
    ["양양군", "손양면", "S1151100", "L1022310"],
    ["강릉시", "강문동", "S1151200", "L1022510"],
    ["동해시", "망상동", "S1151300", "L1021910"],
    ["삼척시", "근덕면", "S1151300", "L1022010"],
  ])("%s의 해상·육상 코드를 유지하고 같은 경로의 근거를 검증함", (sigungu, emd, sea, land) => {
    const root = mkdtempSync(join(tmpdir(), "brd80-zones-")); roots.push(root);
    mkdirSync(join(root, "out")); writeFileSync(join(root, "out/beaches.csv"), sourceText);
    const source = src(sigungu);
    const evidence = { key: `${sigungu}|${source.sta_nm}`, sido: "강원", ...seaEvidenceFor(source, coord, null, context) };
    expect(zoneOf("강원", sigungu)).toBe(sea);
    expect(evidence).toMatchObject({ sea_status: "VERIFIED", sea_zone: sea });
    expect(zoneProofVerified(evidence, "sea", sigungu, root)).toBe(true);
    expect(zoneProofVerified({ ...evidence, sea_zone: "S1251100" }, "sea", sigungu, root)).toBe(false);
    expect(annex9Lookup("강원", sigungu, emd, new Set([`강원|${sigungu}|${emd}`])).map((r) => r.code)).toEqual([land]);
  });
  it("강원도 좌표가 시군 밖이거나 없으면 기존 VERIFIED를 재사용하지 않음", () => {
    for (const result of ["EXCLUDED_SIGUNGU_MISMATCH", "EXCLUDED_OVER_100M"])
      expect(seaEvidenceFor(src("강릉시"), { result }, null, context)).toMatchObject({ sea_status: "UNVERIFIED", sea_zone: "" });
    expect(seaEvidenceFor(src("강릉시"), undefined, null, context)).toMatchObject({ sea_status: "UNVERIFIED", sea_zone: "" });
  });
  it("알 수 없는 시군·읍면 분할의 모호한 구역은 강원 코드로 대체하지 않음", () => {
    expect(seaEvidenceFor(src("없는군"), coord, null, context)).toMatchObject({ sea_status: "UNVERIFIED", sea_zone: "" });
    expect(seaEvidenceFor(src("거제시", "경남"), { ...coord, emd: { emd_nm: "동부면" } }, { locality_status: "VERIFIED_LOCALITY", locality: "동부면" }, context)).toMatchObject({ sea_status: "UNVERIFIED", sea_zone: "" });
  });
});
