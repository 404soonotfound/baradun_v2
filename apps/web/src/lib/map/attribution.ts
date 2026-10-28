// 지도 아래 출처 표기(아키텍처 16.4.2: 구성별 의무). 글자는 문구 키 map.attribution.<key>
// 지도 틀(map-view)이 첫 화면에서 읽으므로 스타일 JSON(style.ts)과 떼어 둠(스타일은 지도를 불러올 때만 받음)
export const MAP_ATTRIBUTIONS = [
  { key: "openfreemap", href: "https://openfreemap.org" },
  { key: "openmaptiles", href: "https://www.openmaptiles.org/" },
  { key: "osm", href: "https://www.openstreetmap.org/copyright" },
] as const;
