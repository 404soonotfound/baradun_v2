import { CLOCK_TOLERANCE_MS, isTime, kstStamp } from "@/lib/snapshot/clock";
import type { SnapshotState } from "@/lib/snapshot/store";
import type { BeachView } from "@/lib/snapshot/view";

// 상황 배너 고르기 (BRD-28 · 노션 2장 HOME 3 '상황 배너(있을 때만 하나)', 3장 Banner '화면당 하나만')
// 홈·탐색·상세가 함께 씀. 화면마다 다른 것은 입력(delayed·locationOff)뿐
// 순서: 오프라인 → 지원 밖 형식 → 새 정보 불러오기 실패 → 확인된 판단 없음 → 관측 지연 → 위치 없이 보는 중
// 받은 정보가 오래됐거나 읽을 수 없다는 사실을 가장 먼저(오래된 값을 최신처럼 보이지 않게)
// 전체 장애(BRD-38, 노션 2장 SYS·1장 L13)는 노션 우선순위 목록에 없어 임시안: 받기는 했지만(live) 확인된 판단이 없음 →
// 우리 쪽 조회 실패(failed)보다 뒤, 해변 하나의 관측 지연보다 앞

// [1] 고른 결과. 관측 지연은 영향받는 해변을 먼저 말하려고 첫 해변과 나머지 수를 담음
// <B> = 해변 모양을 부르는 쪽이 정함(제네릭)
export type Situation<B> =
  | { kind: "offline" }
  | { kind: "unsupported" }
  | { kind: "failed" }
  | { kind: "outage"; lastConfirmedAt: string | null }
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
  outage: Outage | null; // 확인된 판단 없음(sourceOutage). 전체 해변으로 계산함
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
  // 새로 받은 정보로 확인된 판단이 하나도 없음. live가 아니면(첫 응답 전·끊김) 위 배너나 B5 배지가 이미 알림
  if (input.outage && input.live) {
    return { kind: "outage", lastConfirmedAt: input.outage.lastConfirmedAt };
  }
  const [first, ...rest] = input.delayed;
  // first !== undefined: 빈 목록이면 첫 항목이 없음(noUncheckedIndexedAccess가 확인하게 함)
  if (first !== undefined) {
    return { kind: "delayed", first, more: rest.length };
  }
  if (input.locationOff) return { kind: "noLocation" };
  return null;
}

// [3] 확인된 판단 없음 (노션 2장 SYS · 1장 L13 · 5장 B5 · 결정 1). 이름은 outage지만 원인(출처 장애)은 단정하지 않음
// 분류는 다시 계산하지 않고(G1) 해변별 화면 상태(BeachView: 게시된 분류·사유 + 만료 여부)만 봄.
// 노출 중인 전체 해변 중 지금 확인된 판단(만료 전 '특보 없음'·이용불가, 사유가 관측 지연뿐인 판단불가)이
// 하나도 없으면 해당 = 모든 해변이 만료(B5)이거나 특보 확인 못 함·데이터 없음. 배너만 바꾸고 분류는 그대로 둠
// 마지막 확인 시각은 해변별 특보 마지막 확인 시각 중 가장 늦은 것(없으면 null → '시각 모름')
export interface Outage {
  lastConfirmedAt: string | null;
}

export function sourceOutage(views: readonly BeachView[]): Outage | null {
  const ready = views.filter(
    (view): view is Extract<BeachView, { kind: "ready" }> =>
      view.kind === "ready",
  );
  // 받은 해변이 없으면(로딩·노출 해변 없음) 판단하지 않음
  if (ready.length === 0) return null;
  const confirmed = ready.some(
    (view) =>
      !view.stale &&
      (view.category !== "undetermined" ||
        view.reasons.every((reason) => reason.kind === "observation_delayed")),
  );
  if (confirmed) return null;
  let latest: string | null = null;
  for (const view of ready) {
    const at = view.confirmedAt;
    if (at !== null && (latest === null || Date.parse(at) > Date.parse(latest)))
      latest = at;
  }
  return { lastConfirmedAt: latest };
}

// [4] 배너에 올릴 '관측 지연' 해변인지. 지금 받은 정보에서 배지가 관측 지연일 때만
// (B5로 바뀐 해변은 배지가 '특보 확인 못 함'이라 해당 없음, 이용불가 해변은 특보 배지가 먼저라 해당 없음)
export function isDelayedView(view: BeachView): boolean {
  return (
    view.kind === "ready" &&
    !view.stale &&
    view.badge.kind === "observation_delayed"
  );
}

// [5] '14:30 정보를 보여주고 있어요'의 시각. 지금 보여주는 스냅샷의 게시 시각(한국 시각)
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
