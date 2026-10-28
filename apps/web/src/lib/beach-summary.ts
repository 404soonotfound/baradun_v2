import type { Beach } from "@baradun/contracts";

// 지역 한 칸 (시·도 또는 시·군)
export type RegionPart = {
  key: string;
  label: string;
};

// 목록 화면(홈·탐색·검색·즐겨찾기)에 넘길 가벼운 해변 정보
export type BeachSummary = {
  id: string;
  slug: string;
  name: string;
  sido: RegionPart; // 시·도
  sigungu: RegionPart; // 시·군. 고성군·중구처럼 다른 시·도에도 같은 이름이 있어 시·도와 함께 씀
  region: string; // 화면 표시용 "강원 강릉시"
  // Beach["coords"] = Beach 타입의 coords 칸 타입({ lat: number; lng: number })을 그대로 가져옴
  coords: Beach["coords"]; // 거리 계산은 기기 안에서만
  activities: Beach["activities"]; // 활동 타일로 거를 때 씀
  stations: Beach["stations"]; // 관측값 출처(측정소 이름·거리) 표시용
  // 검색용(BRD-31). 화면 언어와 관계없이 한국어·영어 둘 다로 찾음
  names: readonly string[]; // [한국어 이름, 영어 이름]
  aliases: readonly string[]; // 다른 이름(data/beach-meta.json 별칭, 한국어)
  regionNames: readonly string[]; // [한국어 "강원 강릉시", 영어 "Gangwon Gangneung"]
};
