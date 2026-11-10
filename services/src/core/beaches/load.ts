import type { Beach } from "@baradun/contracts";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// 해변 파일(data/beaches/b*.json) 읽기. publisher와 collect-ocean(빠진 관측소 대조, BRD-187)이 같이 씀
// 파일 수가 많아 import 대신 묶을 때 함수 폴더 beaches/로 복사함(infra commandHooks)
// 하나도 없으면 던짐(빈 목록으로 게시해 모든 해변이 사라지지 않게). 계약 모양 검사는 게시 전 계약 검사(BeachesFile)가 함

const BEACH_FILE = /^b[0-9]{4}\.json$/;

export function loadBeaches(dir: string): Beach[] {
  const names = readdirSync(dir)
    .filter((name) => BEACH_FILE.test(name))
    .sort();
  if (names.length === 0) throw new Error(`해변 파일 없음: ${dir}`);
  return names.map(
    (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Beach,
  );
}
