import type {
  DataDrivenPropertyValueSpecification,
  StyleSpecification,
} from "maplibre-gl";

import type { Locale } from "@/lib/i18n";
import type { ResolvedTheme } from "@/lib/theme";
import darkStyle from "./style-dark.json";
import lightStyle from "./style-light.json";

// 지도 스타일 (BRD-65 · 결정 D8, 아키텍처 16.4.3)
// style-light.json = OpenFreeMap Positron 포크(우리 저장소가 원본). 원격 스타일 URL을 그대로 쓰지 않음
// 포크에서 바꾼 것: 도로 번호 표지·작은 도로 이름·공항 아이콘 레이어 삭제, 바다를 옅은 파랑으로(육지와 대비),
// 지명 글자를 짙은 회색으로(해변 마커가 묻히지 않게), 라벨은 name:ko → name 순서
// style-dark.json = style-light.json과 같은 레이어·필터·글자 설정에 색만 다크 토큰 계열로 바꾼 것(BRD-44)
//   육지 #1F2A37·바다 #0D1722(육지·바다 대비는 라이트와 비슷한 1.2), 지명 글자는 text/body 다크(#B7C4D3)
//   마커(상태 색·점선)가 땅·바다 어디서나 3:1 이상 보이게 고름. 테마가 바뀌면 지도도 바뀜(map-view)

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
  theme,
}: {
  locale: Locale;
  tiles: TileMode;
  theme: ResolvedTheme;
}): StyleSpecification {
  const style = structuredClone(
    theme === "dark" ? darkStyle : lightStyle,
  ) as unknown as StyleSpecification;
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
