import "maplibre-gl/dist/maplibre-gl.css";

import * as maplibregl from "maplibre-gl";

import type { Locale } from "@/lib/i18n";
import type { ResolvedTheme } from "@/lib/theme";
import { FIT_OPTIONS, MAX_BOUNDS, type LngLatBox } from "./bounds";
import { buildMapStyle, TILE_SOURCE_ID, tileModeFor } from "./style";

// 지도 엔진 (BRD-65). 이 파일은 지도가 화면에 보일 때만 import()로 불러옴(첫 화면 용량에 넣지 않음)
// MapLibre GL JS 6: 작업자(worker)는 별도 파일이라 public/vendor에 복사해 둔 것을 씀(scripts/copy-map-worker.mjs)

// 이 시간 안에 바다가 그려지지 않으면 실패로 봄. 404처럼 MapLibre가 오류를 내지 않는 실패도 여기서 잡힘
const FIRST_TILE_TIMEOUT_MS = 15_000;

export type MapHandle = {
  map: maplibregl.Map;
  // 우리 HTML 요소를 좌표에 마커로 붙임. 돌려준 함수를 부르면 뗌
  // MapLibre 코드를 이 파일 밖에서 import하지 않게(첫 화면 용량) 여기서만 Marker를 만듦
  addMarker: (element: HTMLElement, lngLat: [number, number]) => () => void;
  // 화면 테마가 바뀌면 지도 색만 바꿈(MapLibre가 바뀐 색만 고쳐 그림, 타일·마커는 그대로)
  setTheme: (theme: ResolvedTheme) => void;
  destroy: () => void;
};

export type CreateMapOptions = {
  container: HTMLElement;
  locale: Locale;
  theme: ResolvedTheme;
  bounds: LngLatBox;
  uiFont: string; // 한글 라벨을 그릴 글꼴(화면 글꼴과 같게). CSS font-family 값
  reducedMotion: boolean;
  canvasLabel: string; // 지도 캔버스의 읽히는 이름(문구 키)
  onReady: () => void;
  onFailed: () => void;
};

export function createMap(options: CreateMapOptions): MapHandle | null {
  // 파일 이름에 판 번호가 있어 판을 올리면 새 파일을 받음
  maplibregl.setWorkerUrl(
    new URL(
      `/vendor/maplibre-gl-worker-${maplibregl.getVersion()}.js`,
      window.location.href,
    ).href,
  );

  const tiles = tileModeFor(process.env.NODE_ENV);
  let theme = options.theme;
  let map: maplibregl.Map;
  try {
    map = new maplibregl.Map({
      container: options.container,
      style: buildMapStyle({ locale: options.locale, tiles, theme }),
      bounds: options.bounds,
      fitBoundsOptions: FIT_OPTIONS,
      maxBounds: MAX_BOUNDS,
      minZoom: 5,
      maxZoom: 16,
      renderWorldCopies: false,
      // 출처는 지도 아래 우리 줄로 따로 보여 줌(키보드·화면 읽기·다크에서 읽히게)
      attributionControl: false,
      // 한글은 MapLibre가 브라우저 글꼴로 그림 → 화면 글꼴(Noto Sans KR)과 같게
      localIdeographFontFamily: options.uiFont,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      fadeDuration: options.reducedMotion ? 0 : 300,
      locale: { "Map.Title": options.canvasLabel },
    });
  } catch {
    // WebGL을 못 쓰는 기기 등
    options.onFailed();
    return null;
  }
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();

  let settled = false; // 성공·실패를 한 번만 알림(그린 뒤 실패는 따로)

  const timer = window.setTimeout(() => {
    if (!settled) fail();
  }, FIRST_TILE_TIMEOUT_MS);

  function fail() {
    window.clearTimeout(timer);
    settled = true;
    options.onFailed();
  }

  // 그릴 것을 다 받은 때(idle)마다 바다 면이 실제로 들어왔는지 봄. 한국 범위에는 늘 바다가 있음
  // 타일이 404·빈 응답이면 MapLibre는 오류 없이 빈 지도를 그리므로, '받았다'가 아니라 '바다가 있다'로 판단
  map.on("idle", () => {
    if (settled) return;
    const sea = map.querySourceFeatures(TILE_SOURCE_ID, {
      sourceLayer: "water",
    });
    if (sea.length === 0) return; // 시간 초과까지 기다림
    settled = true;
    window.clearTimeout(timer);
    options.onReady();
  });
  map.on("error", (event) => {
    const sourceId = (event as { sourceId?: string }).sourceId;
    // 다 그리기 전에는 어떤 오류든 실패. 그린 뒤에는 타일 출처 오류만(이동 중 타일이 끊긴 경우)
    if (!settled) fail();
    else if (sourceId === TILE_SOURCE_ID) options.onFailed();
  });
  map.on("webglcontextlost", () => options.onFailed());

  return {
    map,
    addMarker: (element, lngLat) => {
      const marker = new maplibregl.Marker({ element })
        .setLngLat(lngLat)
        .addTo(map);
      return () => {
        marker.remove();
      };
    },
    setTheme: (next) => {
      if (next === theme) return;
      theme = next;
      map.setStyle(buildMapStyle({ locale: options.locale, tiles, theme }));
    },
    destroy: () => {
      window.clearTimeout(timer);
      settled = true;
      map.remove();
    },
  };
}
