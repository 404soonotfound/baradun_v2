import type {
  DataDrivenPropertyValueSpecification,
  StyleSpecification,
} from "maplibre-gl";

import type { Locale } from "@/lib/i18n";
import lightStyle from "./style-light.json";

// 지도 스타일 (BRD-65 · 결정 D8, 아키텍처 16.4.3)
// style-light.json = OpenFreeMap Positron 포크(우리 저장소가 원본). 원격 스타일 URL을 그대로 쓰지 않음
// 포크에서 바꾼 것: 도로 번호 표지·작은 도로 이름·공항 아이콘 레이어 삭제, 바다를 옅은 파랑으로(육지와 대비),
// 지명 글자를 짙은 회색으로(해변 마커가 묻히지 않게), 라벨은 name:ko → name 순서
// 다크 스타일은 BRD-44에서 따로 만듦(지금은 다크 테마에서도 이 스타일)

// [1] OpenFreeMap 벡터 타일. 개발은 최신(TileJSON), 운영 빌드는 검증한 판으로 고정(16.4.3 버전 전략)
// 판 이름은 https://tiles.openfreemap.org/planet 응답의 tiles 주소에서 가져옴. 바꿀 때는 표본 해변 화면을 보고 올림
export const OPENFREEMAP_TILEJSON = "https://tiles.openfreemap.org/planet";
export const PINNED_TILES_VERSION = "20261025_080012_pt";
export const TILE_SOURCE_ID = "openmaptiles";
const TILE_HOST = "https://tiles.openfreemap.org";

export type TileMode = "latest" | "pinned";

// next build(운영)는 고정 판, next dev·Storybook은 최신
export function tileModeFor(nodeEnv: string | undefined): TileMode {
  return nodeEnv === "production" ? "pinned" : "latest";
}

// [2] 화면 언어별 라벨. 한국어는 name:ko 우선(D8), 영어는 영어 이름 → 로마자 → 원래 이름
// 해변 이름은 지도 라벨이 아니라 우리 마커가 보여 줌(16.3: OSM에 해변 이름이 일부만 있음)
const LABEL_FIELD = {
  ko: ["coalesce", ["get", "name:ko"], ["get", "name"]],
  en: ["coalesce", ["get", "name:en"], ["get", "name:latin"], ["get", "name"]],
} as const;

// [3] 스타일 만들기. 원본 JSON은 고치지 않고 복사본을 돌려줌
export function buildMapStyle({
  locale,
  tiles,
}: {
  locale: Locale;
  tiles: TileMode;
}): StyleSpecification {
  const style = structuredClone(lightStyle) as unknown as StyleSpecification;
  style.sources[TILE_SOURCE_ID] =
    tiles === "pinned"
      ? {
          type: "vector",
          tiles: [
            `${TILE_HOST}/planet/${PINNED_TILES_VERSION}/{z}/{x}/{y}.pbf`,
          ],
          minzoom: 0,
          maxzoom: 14,
        }
      : { type: "vector", url: OPENFREEMAP_TILEJSON };
  for (const layer of style.layers) {
    if (layer.type === "symbol" && layer.layout?.["text-field"]) {
      layer.layout["text-field"] = structuredClone(
        LABEL_FIELD[locale],
      ) as unknown as DataDrivenPropertyValueSpecification<string>;
    }
  }
  return style;
}

// [4] 지도 아래 출처 표기(아키텍처 16.4.2: 구성별 의무). 글자는 문구 키 map.attribution.<key>
export const MAP_ATTRIBUTIONS = [
  { key: "openfreemap", href: "https://openfreemap.org" },
  { key: "openmaptiles", href: "https://www.openmaptiles.org/" },
  { key: "osm", href: "https://www.openstreetmap.org/copyright" },
] as const;
