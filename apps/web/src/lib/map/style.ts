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
// 타일·sprite·글꼴 주소는 JSON에 두지 않고 buildMapStyle이 지도 판 주소로 채움
// 포크에서 바꾼 것: 도로 번호 표지·작은 도로 이름·공항 아이콘 레이어 삭제, 바다를 옅은 파랑으로(육지와 대비),
// 지명 글자를 짙은 회색으로(해변 마커가 묻히지 않게), 라벨은 name:ko → name 순서
// style-dark.json = style-light.json과 같은 레이어·필터·글자 설정에 색만 다크 토큰 계열로 바꾼 것(BRD-44)
//   육지 #1F2A37·바다 #0D1722(육지·바다 대비는 라이트와 비슷한 1.2), 지명 글자는 text/body 다크(#B7C4D3)
//   마커(상태 색·점선)가 땅·바다 어디서나 3:1 이상 보이게 고름. 테마가 바뀌면 지도도 바뀜(map-view)

// [1] 지도 판: 검증한 한국 지도 파일(PMTiles)·글꼴·sprite를 사이트 CloudFront의 map/<판>/에서 받음
// (결정 기록 D19-1 · #392, 아키텍처 16.4.3). 외부 지도 서버를 부르지 않음
// 판은 tools/map-tiles(map-tiles 워크플로)가 만들어 올린 것 중 READY.txt가 있고 표본 해변 화면을 본 것만 씀
// 판을 바꾸면 CI map-files 작업이 실제 경로(READY.txt·범위 요청·sprite·글꼴)를 확인함(tools/map-tiles/verify.mjs)
export const MAP_VERSION = "20261111-0654";
export const MAP_PATH = `/map/${MAP_VERSION}`;
export const TILE_SOURCE_ID = "openmaptiles";

// 지도 파일 주소. 화면과 같은 출처(운영 CloudFront)에서 받음(CSP 'self', 외부 출처 허용 없음)
// 개발 서버·Storybook은 /map/ 요청을 운영 CloudFront로 넘겨 같은 출처로 받음(scripts/dev-map.mjs, CORS를 열지 않음)
export function mapAssetUrls(origin: string) {
  const base = `${origin.replace(/\/+$/, "")}${MAP_PATH}`;
  return {
    tiles: `pmtiles://${base}/korea.pmtiles`,
    sprite: `${base}/sprites/ofm`,
    glyphs: `${base}/fonts/{fontstack}/{range}.pbf`,
  };
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
  origin,
  theme,
}: {
  locale: Locale;
  origin: string;
  theme: ResolvedTheme;
}): StyleSpecification {
  const style = structuredClone(
    theme === "dark" ? darkStyle : lightStyle,
  ) as unknown as StyleSpecification;
  const urls = mapAssetUrls(origin);
  style.sources[TILE_SOURCE_ID] = { type: "vector", url: urls.tiles };
  style.sprite = urls.sprite;
  style.glyphs = urls.glyphs;
  for (const layer of style.layers) {
    if (layer.type === "symbol" && layer.layout?.["text-field"]) {
      layer.layout["text-field"] = structuredClone(
        LABEL_FIELD[locale],
      ) as unknown as DataDrivenPropertyValueSpecification<string>;
    }
  }
  return style;
}
