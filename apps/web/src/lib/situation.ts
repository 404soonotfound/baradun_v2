import { CLOCK_TOLERANCE_MS, isTime, kstStamp } from "@/lib/snapshot/clock";
import type { SnapshotState } from "@/lib/snapshot/store";
import type { BeachView } from "@/lib/snapshot/view";

// 상황 배너 고르기 (BRD-28 · 노션 2장 HOME 3 '상황 배너(있을 때만 하나)', 3장 Banner '화면당 하나만')
// 홈·탐색·상세가 함께 씀. 화면마다 다른 것은 입력(delayed·locationOff)뿐
// 순서: 오프라인 → 지원 밖 형식 → 새 정보 불러오기 실패 → 관측 지연 → 위치 없이 보는 중
// 받은 정보가 오래됐거나 읽을 수 없다는 사실을 가장 먼저(오래된 값을 최신처럼 보이지 않게)

// [1] 고른 결과. 관측 지연은 영향받는 해변을 먼저 말하려고 첫 해변과 나머지 수를 담음
// <B> = 해변 모양을 부르는 쪽이 정함(제네릭)
export type Situation<B> =
  | { kind: "offline" }
  | { kind: "unsupported" }
  | { kind: "failed" }
  | { kind: "delayed"; first: B; more: number }
  | { kind: "noLocation" }
  | null;

// 공용 배너(SituationBanner)가 그리는 것. '위치 없이 보는 중'은 화면마다 다른 배너라 뺌
export type DataSituation<B> = Exclude<Situation<B>, { kind: "noLocation" }>;

// [2] 순수 함수: 같은 입력이면 같은 결과
export function pickSituation<B>(input: {
  phase: SnapshotState["phase"];
  live: boolean; // 마지막 조회 성공 여부(store)
  failedOnline: boolean; // 연결된 채로 시작한 마지막 조회가 실패함(store)
  online: boolean; // 브라우저 연결 상태(useOnline)
  delayed: readonly B[]; // 화면 해변 중 배지가 '관측 지연'인 해변
  locationOff: boolean; // 위치 없이 지역으로 보는 중이고 배너를 닫지 않음
}): Situation<B> {
  // 점검·강제 업데이트는 화면 전체를 덮는 쪽(BRD-38)이 알림
  if (input.phase === "maintenance" || input.phase === "update_required") {
    return null;
  }
  if (!input.online) return { kind: "offline" };
  // 새 데이터 형식을 못 읽어 모든 해변이 '확인 못 함'인 이유를 알림
  if (input.phase === "schema_unsupported") return { kind: "unsupported" };
  // 첫 응답 전·끊긴 동안·연결이 돌아온 뒤 다시 받는 중에는 실패로 보지 않음(store failedOnline)
  if (input.failedOnline && !input.live) return { kind: "failed" };
  const [first, ...rest] = input.delayed;
  // first !== undefined: 빈 목록이면 첫 항목이 없음(noUncheckedIndexedAccess가 확인하게 함)
  if (first !== undefined) {
    return { kind: "delayed", first, more: rest.length };
  }
  if (input.locationOff) return { kind: "noLocation" };
  return null;
}

// [3] 배너에 올릴 '관측 지연' 해변인지. 지금 받은 정보에서 배지가 관측 지연일 때만
// (B5로 바뀐 해변은 배지가 '특보 확인 못 함'이라 해당 없음, 이용불가 해변은 특보 배지가 먼저라 해당 없음)
export function isDelayedView(view: BeachView): boolean {
  return (
    view.kind === "ready" &&
    !view.stale &&
    view.badge.kind === "observation_delayed"
  );
}

// [4] '14:30 정보를 보여주고 있어요'의 시각. 지금 보여주는 스냅샷의 게시 시각(한국 시각)
// 읽을 수 없거나, 지금 시각을 모르거나, 지금보다 2분 넘게 미래(시계가 틀림)면 null → '시각 모름' 문구
export function shownDataTime(
  generatedAt: string | null | undefined,
  nowMs: number,
): string | null {
  if (!isTime(generatedAt)) return null;
  // nowMs가 NaN이면 비교가 false → null
  if (!(Date.parse(generatedAt) <= nowMs + CLOCK_TOLERANCE_MS)) return null;
  return kstStamp(generatedAt, nowMs);
}
