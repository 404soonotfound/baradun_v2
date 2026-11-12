// 운영자 사이트 전용 토큰(결정 E6·BRD-165). build-tokens·check-tokens가 함께 씀
// build-tokens: --admin일 때만 CSS로 내보냄. check-tokens: 초록 금지 검사에서 뺌(사용자 사이트 CSS에는 나가지 않으므로)
// 한 곳에서만 정해 두 스크립트가 어긋나지 않게 함
export const ADMIN_ONLY_PATHS = [["color", "success"]];

export const isAdminOnly = (path) =>
  ADMIN_ONLY_PATHS.some((prefix) => prefix.every((key, i) => path[i] === key));
