// PC 상단 내비 업데이트 상태 알약 (Figma 170:399, BRD-129 · #105 결정 3)
// '14:30 업데이트 · 관측 지연 2곳'. 관측 지연은 노출 중인 전체 해변에서 게시된 사유 그대로 셈(isDelayedView, 분류 재계산 없음)
// 보이는 규칙:
//   불러오는 중·게시 시각을 모름(처음부터 못 받음·점검 등) → 숨김
//   연결됨 + 이번에 받은 정보(live) → 'HH:MM 업데이트', 관측 지연이 있으면 ' · 관측 지연 n곳'
//   오프라인·불러오기 실패로 지난 정보를 보여주는 중 → 'HH:MM 정보 · 새로 확인 못 함'
//     (지난 정보에서 센 관측 지연은 지금 상태가 아니라 세지 않음)
export type UpdateStatus =
  | { kind: "hidden" }
  | { kind: "live"; time: string; delayed: number }
  | { kind: "stale"; time: string };

export function updateStatus(input: {
  time: string | null; // 지금 보여주는 정보의 게시 시각(shownDataTime). 모르면 null
  online: boolean;
  live: boolean; // 이번 방문에 새로 받은 정보인지(저장된 값이 아닌지)
  delayed: number; // 관측 지연 해변 수
}): UpdateStatus {
  if (input.time === null) return { kind: "hidden" };
  if (!input.online || !input.live) return { kind: "stale", time: input.time };
  return {
    kind: "live",
    time: input.time,
    delayed: Math.max(0, input.delayed),
  };
}
