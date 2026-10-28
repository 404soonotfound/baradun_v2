// 지도 불러오기 상태 (BRD-65 · 아키텍처 9장 '지도 불러오기', 16.4.3 장애 격리)
// idle(아직 화면에 안 보임) → loading → ready | failed. 다시 시도하면 새 시도 번호로 loading
// 시도 번호(attempt): 지난 시도의 늦은 알림이 새 시도의 상태를 덮지 않게 함(점검표 1)

export type MapLoad =
  | { phase: "idle"; attempt: 0 }
  | { phase: "loading" | "ready" | "failed"; attempt: number };

export type MapLoadEvent =
  | { type: "visible" } // 지도 자리가 처음 화면에 보임
  | { type: "retry" } // 사용자가 다시 시도를 누름
  | { type: "ready"; attempt: number } // 스타일과 첫 타일을 그림
  | { type: "failed"; attempt: number }; // 스타일·타일·WebGL 실패 또는 시간 초과

export const initialMapLoad: MapLoad = { phase: "idle", attempt: 0 };

export function mapLoadReducer(state: MapLoad, event: MapLoadEvent): MapLoad {
  switch (event.type) {
    case "visible":
      // 처음 보일 때 한 번만 시작. 이미 시작했으면 그대로
      return state.phase === "idle" ? { phase: "loading", attempt: 1 } : state;
    case "retry":
      // 실패했을 때만 새로 시도(불러오는 중·성공 중에 겹쳐 만들지 않음)
      return state.phase === "failed"
        ? { phase: "loading", attempt: state.attempt + 1 }
        : state;
    case "ready":
      // 지금 시도의 알림이고 불러오는 중일 때만. 실패한 뒤 늦게 온 성공은 무시(실패를 정상으로 바꾸지 않음)
      return event.attempt === state.attempt && state.phase === "loading"
        ? { phase: "ready", attempt: state.attempt }
        : state;
    case "failed":
      // 지금 시도라면 불러오는 중이든 다 그린 뒤든 실패로(그린 뒤 타일이 끊겨도 지도만 오류 상태)
      return event.attempt === state.attempt &&
        (state.phase === "loading" || state.phase === "ready")
        ? { phase: "failed", attempt: state.attempt }
        : state;
  }
}

// 다 그린 뒤 타일 오류. 이동 중 타일 하나가 끊긴 것만으로 지도 전체를 실패로 바꾸지 않고,
// 그사이 받은 타일 없이 연달아 이만큼 실패하면 실패로 봄(목록으로 보기·다시 시도 안내)
export const TILE_ERROR_LIMIT = 3;

export function createTileErrorCounter(limit = TILE_ERROR_LIMIT) {
  let failures = 0;
  return {
    // 타일 오류. 연달아 limit번이 되면 true(실패로 알릴 때)
    error(): boolean {
      failures += 1;
      return failures === limit;
    },
    // 타일을 받음 → 처음부터 다시 셈
    loaded() {
      failures = 0;
    },
  };
}
