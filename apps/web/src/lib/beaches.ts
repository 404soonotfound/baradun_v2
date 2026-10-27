// Node 기본 내장 도구(설치 불필요, "node:"로 시작). 컴퓨터 파일을 읽으므로 브라우저 코드에서는 사용 불가
// existsSync: 있는지 확인 · readdirSync: 폴더 안 이름 목록 · readFileSync: 파일 내용(글자)
// 끝의 Sync = 다 읽을 때까지 기다린 뒤 다음 줄 실행. 빌드 때 한 번 읽는 용도라 단순한 쪽 선택
import { existsSync, readdirSync, readFileSync } from "node:fs";
// 경로 잇기 도구. path.join이 "/"와 ".."를 정리
import path from "node:path";

import type { Beach } from "@baradun/contracts";
import { ALT_MAX_KM } from "@/lib/alternatives";
import type { BeachSummary } from "@/lib/beach-summary";
import { distanceKm } from "@/lib/geo";
import type { Locale } from "@/lib/i18n"; // "ko" | "en"

// 해변 목록 읽기 (아키텍처 17.5·B6, BRD-45). 빌드·개발 서버에서만 실행(브라우저로 내려가지 않음)
// 원본: 저장소의 data/beaches/b0001.json … (해변 하나 = 파일 하나)
// 명령이 apps/web에서 실행돼서(npm -w apps/web) 저장소 맨 위는 두 칸 위
const REPO_ROOT = path.join(process.cwd(), "../..");
const DATA_DIR = path.join(REPO_ROOT, "data/beaches");
// 개발 중 data/beaches가 비어 있으면 계약의 예시 해변 사용. 배포 빌드(production)에서는 절대 사용 안 함
const SAMPLE_FILE = path.join(
  REPO_ROOT,
  "packages/contracts/examples/valid/beaches.json",
);

// 해변이 하나도 없을 때 쓰는 자리 slug. 정적 내보내기는 경로가 0개면 빌드가 실패해서 하나를 만들고
// 그 페이지는 404 표시. "_"는 slug 규칙(소문자·숫자·하이픈)에 없는 글자라 실제 해변과 겹치지 않음
export const EMPTY_SLUG = "_";

function readDataDir(): Beach[] {
  if (!existsSync(DATA_DIR)) return []; // 폴더가 없으면 해변 0곳
  // 이름 목록 → .json만 → 이름순 → 파일마다 읽어서 객체로
  return readdirSync(DATA_DIR)
    .filter((file) => file.endsWith(".json")) // README.md 등은 건너뜀
    .sort()
    .map(
      (file) =>
        JSON.parse(readFileSync(path.join(DATA_DIR, file), "utf8")) as Beach,
    );
}

// 저장해 두지 않고 부를 때마다 읽기: 개발 중 파일을 고치면 바로 반영(파일이 작아서 빠름)
function load(): { beaches: Beach[]; sample: boolean } {
  const real = readDataDir();
  if (real.length > 0 || process.env.NODE_ENV === "production") {
    return { beaches: real, sample: false };
  }
  const file = JSON.parse(readFileSync(SAMPLE_FILE, "utf8")) as {
    beaches: Beach[];
  };
  return { beaches: file.beaches, sample: true };
}

// 상세 경로로 만들 slug 목록. 노출을 끈 해변(hidden: true)은 제외 → 404
export function beachSlugParams(): { slug: string }[] {
  const slugs = load()
    .beaches.filter((beach) => !beach.hidden)
    .map((beach) => ({ slug: beach.slug }));
  return slugs.length > 0 ? slugs : [{ slug: EMPTY_SLUG }];
}

// slug로 해변 찾기. 없거나 숨긴 해변이면 null
export function findBeach(
  slug: string,
): { beach: Beach; sample: boolean } | null {
  const { beaches, sample } = load();
  const beach = beaches.find((item) => item.slug === slug && !item.hidden);
  return beach ? { beach, sample } : null;
}

// 목록 화면용 해변 요약 목록 (BRD-26). 빌드·개발 서버에서만 실행
export function listBeachSummaries(locale: Locale): BeachSummary[] {
  return load()
    .beaches.filter((beach) => !beach.hidden)
    .map((beach) => ({
      id: beach.id,
      slug: beach.slug,
      name: beach.name[locale],
      sido: { key: beach.region.sido.ko, label: beach.region.sido[locale] },
      sigungu: {
        key: beach.region.sigungu.ko,
        label: beach.region.sigungu[locale],
      },
      region: `${beach.region.sido[locale]} ${beach.region.sigungu[locale]}`,
      coords: beach.coords,
      activities: beach.activities,
      stations: beach.stations,
    }));
}

// 상세 대안 해변 후보: 이 해변을 뺀 30km 안 해변만(해변 좌표는 고정이라 빌드 때 거름).
// 상세 페이지마다 전체 목록을 내려보내지 않게 함. 특보 없음·활동·최대 2곳은 브라우저에서(lib/alternatives.ts)
export function listAltCandidates(
  beach: Pick<Beach, "id" | "coords">,
  locale: Locale,
): BeachSummary[] {
  return listBeachSummaries(locale).filter(
    (item) =>
      item.id !== beach.id &&
      distanceKm(beach.coords, item.coords) <= ALT_MAX_KM,
  );
}
