import type { StationTable } from "../core/collect/publish-summary";
import type { RunView } from "./collection";

// 수집 현황 · 관측소 목록 (GH-380, 화면 ADM-COLLECT 관측소 시트, 시안 4차 V10)
// publisher가 남긴 관측소 표(publish#stations)와 관측 수집기 실행 기록(빠진 관측소)만 씀
// - 관측소별 마지막 측정 시각은 State에 있어 운영 API가 읽지 않음(G1·D16-B2, D19-5) → 빠짐 여부와 처음 빠진 시각만
// - 기준은 대조한 성공 실행(complete + missingStations 칸 있음). 일부 실패 실행은 실패한 출처를 대조하지 않아
//   그 출처 관측소를 정상으로 볼 수 없음 → 상태 기준으로 쓰지 않음(관측소 장애 끝 판정과 같은 기준)
// - 표를 못 읽으면 unavailable, 대조한 실행이 없거나 빠진 목록이 잘렸으면 해당 관측소는 unknown('정상'으로 보지 않음)

export type StationState = "ok" | "missing" | "unknown";

export interface StationRow {
  readonly id: string;
  readonly name: string;
  readonly beachIds: readonly string[];
  readonly waveBeachIds: readonly string[];
  readonly state: StationState;
  // false: 기준 실행에서 빠졌는데 관측소 표에 없음(해변 파일이 바뀌고 표가 아직 안 바뀜). 이름·쓰는 해변을 모름
  readonly inTable: boolean;
  // 지금 빠진 관측소가 처음 빠진 실행 시작 시각(7일 기록 안에서). 아니면 null
  readonly missingSince: string | null;
}

export type StationsView =
  | {
      readonly status: "ok";
      // 상태 기준 실행(대조한 성공 실행) 시작 시각. 없으면 null(모든 관측소 unknown)
      readonly checkedAt: string | null;
      readonly list: readonly StationRow[];
    }
  | { readonly status: "unavailable" };

const STATE_ORDER: Record<StationState, number> = {
  missing: 0,
  unknown: 1,
  ok: 2,
};

const checked = (run: RunView) =>
  run.status === "complete" && run.missingStations !== undefined;

// 빠진 목록이 기록 상한에 잘린 실행: 목록에 없다고 돌아온 것으로 볼 수 없음
const cut = (run: RunView) =>
  (run.missingStationsTotal ?? 0) > (run.missingStations?.length ?? 0);

// runs: collect-ocean 실행 기록(시작 시각 오름차순)
export function stationsView(
  table: StationTable | null,
  runs: readonly RunView[],
): StationsView {
  // 빈 표도 못 읽은 것으로 봄('관측소 0곳·문제 없음'으로 보이지 않게)
  if (table === null || Object.keys(table).length === 0) {
    return { status: "unavailable" };
  }
  let baseIndex = runs.length - 1;
  while (baseIndex >= 0 && !checked(runs[baseIndex]!)) baseIndex--;
  const base = baseIndex >= 0 ? runs[baseIndex]! : null;
  const missing = new Set(base?.missingStations ?? []);
  const truncated = base !== null && cut(base);

  // 처음 빠진 시각: 기준 실행부터 거꾸로, 그 관측소가 빠진 실행을 이어 감
  // 대조한 성공 실행에 없으면 그때는 돌아와 있었음 → 멈춤. 대조 못 한·일부 실패·목록이 잘린 실행은 건너뜀
  const since = (id: string): string | null => {
    let first: string | null = null;
    for (let i = baseIndex; i >= 0; i--) {
      const run = runs[i]!;
      if (run.missingStations?.includes(id)) first = run.startedAt;
      else if (checked(run) && !cut(run)) break;
    }
    return first;
  };

  const list = Object.entries(table).map(([id, use]): StationRow => {
    const state: StationState =
      base === null
        ? "unknown"
        : missing.has(id)
          ? "missing"
          : truncated
            ? "unknown"
            : "ok";
    return {
      id,
      name: use.name,
      beachIds: use.beachIds,
      waveBeachIds: use.waveBeachIds,
      state,
      inTable: true,
      missingSince: state === "missing" ? since(id) : null,
    };
  });
  // 표에 없는 빠진 관측소도 숨기지 않음(장애 기록에는 보이는데 목록에서 사라지지 않게)
  for (const id of missing) {
    if (id in table) continue;
    list.push({
      id,
      name: id,
      beachIds: [],
      waveBeachIds: [],
      state: "missing",
      inTable: false,
      missingSince: since(id),
    });
  }
  list.sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      a.name.localeCompare(b.name, "ko"),
  );
  return { status: "ok", checkedAt: base?.startedAt ?? null, list };
}
