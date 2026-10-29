import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMD_COLUMNS, readEmdBoundary } from "../emd-boundary.mjs";

// 법정구역정보 읍면동(EMD) 층 모양의 작은 가짜 shp·dbf. 실제 원자료는 읽지 않음
// 구조는 브이월드 dsId=21 변동데이터 실파일(CH_D001_00_20261022(EMD), EUC-KR·PolygonZ)과 컬럼정의서 전체데이터(AL_D001)를 본뜸
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));

type Field = { name: string; type?: string; len: number };
function dbfBuffer(fields: Field[], rows: (string | Buffer)[][]) {
  const headerLen = 32 + fields.length * 32 + 1;
  const recordLen = 1 + fields.reduce((n, f) => n + f.len, 0);
  const buf = Buffer.alloc(headerLen + rows.length * recordLen + 1, 0x20);
  buf.fill(0, 0, headerLen);
  buf[0] = 0x03;
  buf.writeUInt32LE(rows.length, 4);
  buf.writeUInt16LE(headerLen, 8);
  buf.writeUInt16LE(recordLen, 10);
  fields.forEach((f, i) => {
    const o = 32 + i * 32;
    buf.write(f.name, o, "latin1");
    buf[o + 11] = (f.type ?? "C").charCodeAt(0);
    buf[o + 16] = f.len;
  });
  buf[headerLen - 1] = 0x0d;
  rows.forEach((row, r) => {
    let o = headerLen + r * recordLen + 1;
    row.forEach((v, i) => {
      (typeof v === "string" ? Buffer.from(v, "utf8") : v).copy(buf, o);
      o += fields[i].len;
    });
  });
  buf[buf.length - 1] = 0x1a;
  return buf;
}
// 정사각형 PolygonZ(유형 15) 레코드: x·y 뒤에 Z 범위·Z 값·M 범위·M 값이 붙음
function shpBuffer(squares: [number, number][]) {
  const recs = squares.map(([x, y], i) => {
    const pts = [[x, y], [x, y + 10], [x + 10, y + 10], [x + 10, y], [x, y]];
    const xyLen = 44 + 4 + pts.length * 16;
    const content = Buffer.alloc(xyLen + 2 * (16 + pts.length * 8));
    content.writeInt32LE(15, 0);
    [x, y, x + 10, y + 10].forEach((v, k) => content.writeDoubleLE(v, 4 + k * 8));
    content.writeInt32LE(1, 36);
    content.writeInt32LE(pts.length, 40);
    content.writeInt32LE(0, 44);
    pts.forEach(([px, py], k) => {
      content.writeDoubleLE(px, 48 + k * 16);
      content.writeDoubleLE(py, 56 + k * 16);
    });
    const head = Buffer.alloc(8);
    head.writeInt32BE(i + 1, 0);
    head.writeInt32BE(content.length / 2, 4);
    return Buffer.concat([head, content]);
  });
  const header = Buffer.alloc(100);
  header.writeInt32BE(9994, 0);
  header.writeInt32LE(15, 32);
  return Buffer.concat([header, ...recs]);
}

const FIELDS: Field[] = [
  { name: "A0", type: "N", len: 9 },
  { name: "A1", len: 8 },
  { name: "A2", len: 20 },
  { name: "A3", type: "D", len: 8 },
  { name: "A4", len: 5 },
];
// EUC-KR 바이트: 교동·청운동·송지면
const KO = {
  교동: Buffer.from([0xb1, 0xb3, 0xb5, 0xbf]),
  청운동: Buffer.from("C3BBBFEEB5BF", "hex"),
  송지면: Buffer.from("BCDBC1F6B8E9", "hex"),
};
const row = (cd: string, nm: string | Buffer, sgg: string) => ["1", cd, nm, "20261009", sgg];
function fixture(rows: (string | Buffer)[][], { fields = FIELDS, squares = rows.map((_, i) => [i * 20, 0] as [number, number]) } = {}) {
  const root = mkdtempSync(join(tmpdir(), "brd126-emd-"));
  roots.push(root);
  const shp = join(root, "emd.shp");
  const dbf = join(root, "emd.dbf");
  writeFileSync(shp, shpBuffer(squares));
  writeFileSync(dbf, dbfBuffer(fields, rows));
  return { shp, dbf, encoding: "euc-kr" };
}

describe("법정구역정보 읍면동 층 읽기", () => {
  it("A1·A2·A4를 판정 이름(EMD_CD·EMD_NM·COL_ADM_SE)으로 옮기고 해안 시·도만 남김", () => {
    const src = fixture([row("51150101", KO.교동, "51150"), row("11110101", KO.청운동, "11110"), row("12820250", KO.송지면, "12820")]);
    const out = readEmdBoundary(src, ["51", "12"]);
    expect(EMD_COLUMNS).toEqual({ EMD_CD: "A1", EMD_NM: "A2", COL_ADM_SE: "A4" });
    expect(out.map((e) => [e.EMD_CD, e.EMD_NM, e.COL_ADM_SE])).toEqual([
      ["51150101", "교동", "51150"],
      ["12820250", "송지면", "12820"],
    ]);
    expect(out[0].parts[0]).toHaveLength(5);
    expect(out[1].bbox).toEqual([40, 0, 50, 10]);
  });

  it("dbf 인코딩이 고정되지 않으면 읽지 않고 중단", () => {
    const src = fixture([row("51150101", KO.교동, "51150")]);
    expect(() => readEmdBoundary({ ...src, encoding: null }, ["51"])).toThrow(/인코딩/);
  });

  it("변동데이터(CH_D001: A4 변동순번·A5 입력구분·A6 시군구 코드) 형식이면 전국 판정에 쓰지 않고 중단", () => {
    const change: Field[] = [...FIELDS.slice(0, 4), { name: "A4", type: "N", len: 18 }, { name: "A5", len: 1 }, { name: "A6", len: 5 }];
    const src = fixture([["1681", "48820310", Buffer.from("BBEFBBEAB8E9", "hex"), "20261022", "117576253.00000000", "I", "48820"]], { fields: change });
    expect(() => readEmdBoundary(src, ["48"])).toThrow(/변동데이터\(CH_D001\)/);
  });

  it("컬럼정의서와 다른 컬럼이면 중단(종전 EMD_CD·COL_ADM_SE 형식 포함)", () => {
    const legacy = ["EMD_CD", "COL_ADM_SE", "EMD_NM", "SGG_OID"].map((name) => ({ name, len: 20 }));
    const src = fixture([["51150101", "51150", "교동", "1"]], { fields: legacy });
    expect(() => readEmdBoundary(src, ["51"])).toThrow(/컬럼 없음: A1·A2·A4/);
  });

  it("도형과 속성 개수가 다르면 중단", () => {
    const src = fixture([row("51150101", KO.교동, "51150"), row("51150102", KO.교동, "51150")], { squares: [[0, 0]] });
    expect(() => readEmdBoundary(src, ["51"])).toThrow(/개수 불일치/);
  });

  it.each([
    ["읍면동 코드가 8자리가 아님", row("5115010", "교동", "51150")],
    ["시군구 코드가 비어 있음", row("51150101", "교동", "")],
    ["읍면동 이름이 비어 있음", row("51150101", "", "51150")],
    ["읍면동 이름이 NUL로 채워짐(변동데이터 삭제 행 모양)", row("51150101", Buffer.alloc(20), "51150")],
    ["읍면동 이름이 깨짐(인코딩 다름)", row("51150101", Buffer.from([0xff, 0xff, 0xff, 0xff]), "51150")],
  ])("%s → 정상으로 넘기지 않고 중단", (_, r) => {
    expect(() => readEmdBoundary(fixture([r]), ["51"])).toThrow(/형식 오류/);
  });

  it("레코드가 하나도 없으면 중단", () => {
    expect(() => readEmdBoundary(fixture([]), ["51"])).toThrow(/레코드 없음/);
  });
});
