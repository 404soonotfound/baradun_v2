// xlsx 첫 시트 읽기 (패키지 없이 시스템 unzip + 공유 문자열·셀 XML 해석). 읽기 전용
// 반환: 행 배열, 각 행은 { 행번호, 셀: { A: 값, B: 값, … } }
import { execFileSync } from "node:child_process";

const unzipEntry = (path, entry) => execFileSync("unzip", ["-p", path, entry], { maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
const decode = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

export function readFirstSheet(path) {
  const shared = [];
  for (const si of unzipEntry(path, "xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    // 서식 조각(r) 안의 t만 이어 붙이고 발음 표기(rPh)는 버림
    const body = si[1].replace(/<rPh[\s\S]*?<\/rPh>/g, "");
    shared.push(decode([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join("")));
  }
  const rows = [];
  for (const row of unzipEntry(path, "xl/worksheets/sheet1.xml").matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of row[2].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /r="([A-Z]+)\d+"/.exec(c[1])?.[1];
      const type = /t="(\w+)"/.exec(c[1])?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? "")?.[1];
      const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2] ?? "")?.[1];
      if (!ref) continue;
      cells[ref] = type === "s" ? shared[Number(v)] : type === "inlineStr" ? decode(inline ?? "") : v === undefined ? "" : decode(v);
    }
    rows.push({ row: Number(row[1]), cells });
  }
  return rows;
}
