import type { StatusFile } from "@baradun/contracts";
import {
  canonicalJson,
  categoryCountsOf,
  type CategoryCounts,
} from "../core/collect/publish-summary";
import { formatUtcIso } from "../core/warnings/time";
import { readPublishInputs } from "./inputs";
import { MANIFEST_PATH, parseManifest } from "./notice-select";
import { beachIdProblem, FILES, KEYS, type PublishDeps } from "./publish";
import { BeachSnapshotError, buildSnapshot } from "./snapshot";
import { contractErrors } from "./validate";

// 게시 변경 미리보기 (#331, 캔버스 N2 '해변 앱 표시가 바뀌는 곳·미리 해 본 검증')
// '지금 게시'를 하면 해변 분류가 어떻게 바뀌는지 publisher가 같은 코드로 미리 계산함(운영 API는 State를 읽지 않음, G1·D16-B2)
// - 쓰지 않음: 게시 잠금·S3·Ops 어느 것도 쓰지 않음. 지금 게시본(manifest → status.json)과 마지막 수집 사실만 읽음
// - 분류는 publisher가 계산한 그대로 돌려줌(운영 화면이 다시 판단하지 않음)
// - 검증도 게시와 같음: 해변 ID 집합 대조(D16-C1)·분류·계약 검사. 걸리면 '이대로면 게시 안 함'(blocked)
// - 실제 게시는 그 순간의 수집 사실로 다시 계산하므로 미리보기와 다를 수 있음

export const PREVIEW_CHANGED_LIMIT = 50;

// 사유 하나: code와 특보 종류·단계(있을 때만). 화면이 사유 먼저 배지('풍랑주의보')를 그리는 데 씀
export interface PreviewReason {
  readonly code: string;
  readonly type?: string;
  readonly level?: string;
}

export interface PreviewBeachState {
  readonly category: string;
  readonly reasons: readonly PreviewReason[]; // publisher 순서 그대로
}

export interface PreviewBeachChange {
  readonly id: string;
  // 지금 게시본에 없던 해변이면 null
  readonly before: PreviewBeachState | null;
  readonly after: PreviewBeachState;
}

export interface PreviewChecks {
  // 해변 ID 대조 결과(D16-C1). 문제없으면 null
  readonly beachIds: {
    readonly where: "source" | "beaches" | "status";
    readonly missing: number;
    readonly extra: number;
    readonly duplicate: number;
  } | null;
  readonly expected: number; // 저장소 원본 해변 수
  readonly contractErrors: number;
}

export type PublishPreview =
  | {
      readonly status: "ready";
      readonly at: string; // 미리보기를 만든 시각(UTC ISO)
      // 지금 게시본. 읽지 못하면 version·counts null(견줄 수 없음, 변경 목록 비움)
      readonly current: {
        readonly version: string | null;
        readonly counts: CategoryCounts | null;
        readonly readable: boolean;
        // 아직 게시본이 없음(첫 게시 전). readable false지만 장애가 아님
        readonly missing: boolean;
      };
      readonly next: { readonly counts: CategoryCounts | null };
      // 분류나 사유가 바뀌는 해변(최대 PREVIEW_CHANGED_LIMIT건, 해변 ID 순)
      readonly changed: readonly PreviewBeachChange[];
      readonly changedCount: number;
      readonly checks: PreviewChecks;
    }
  | {
      // 이대로 게시하면 검증에 걸려 게시하지 않음(앞 게시본 유지)
      readonly status: "blocked";
      readonly at: string;
      readonly reason: "beach_ids" | "classify" | "contract";
      readonly checks: PreviewChecks;
    };

function stateOf(status: {
  category: string;
  reasons: readonly { code: string; type?: unknown; level?: unknown }[];
}): PreviewBeachState {
  return {
    category: status.category,
    reasons: status.reasons.map((r) => ({
      code: r.code,
      ...(typeof r.type === "string" ? { type: r.type } : {}),
      ...(typeof r.level === "string" ? { level: r.level } : {}),
    })),
  };
}

// 칸 순서와 상관없이 분류·사유가 같은지(publish-summary.ts canonicalJson)
const same = (a: PreviewBeachState, b: PreviewBeachState) =>
  canonicalJson(a) === canonicalJson(b);

// 지금 게시본의 해변 상태. missing: 아직 게시본이 없음(첫 게시 전) · status null: 읽지 못함
async function currentStatus(snapshots: PublishDeps["snapshots"]): Promise<{
  version: string | null;
  status: StatusFile | null;
  missing: boolean;
}> {
  try {
    const body = await snapshots.getFile(MANIFEST_PATH);
    if (body === null) return { version: null, status: null, missing: true };
    const manifest = parseManifest(body);
    if (manifest === null)
      return { version: null, status: null, missing: false };
    const statusBody = await snapshots.getFile(
      manifest.files.status.replace(/^\//, ""),
    );
    const parsed: unknown = statusBody === null ? null : JSON.parse(statusBody);
    return {
      version: manifest.snapshotVersion,
      missing: false,
      status:
        parsed !== null && contractErrors("StatusFile", parsed).length === 0
          ? (parsed as StatusFile)
          : null,
    };
  } catch {
    return { version: null, status: null, missing: false };
  }
}

export async function previewSnapshot(
  deps: Pick<
    PublishDeps,
    | "state"
    | "snapshots"
    | "beaches"
    | "beachIds"
    | "zones"
    | "seasons"
    | "log"
    | "clock"
  >,
): Promise<PublishPreview> {
  const at = formatUtcIso(deps.clock());
  const expected = deps.beachIds.length;
  const blocked = (
    reason: "beach_ids" | "classify" | "contract",
    checks: Partial<PreviewChecks> = {},
  ): PublishPreview => ({
    status: "blocked",
    at,
    reason,
    checks: { beachIds: null, expected, contractErrors: 0, ...checks },
  });
  const idCheck = (
    where: "source" | "beaches" | "status",
    actual: readonly string[],
  ) => {
    const problem = beachIdProblem(deps.beachIds, actual);
    return problem
      ? {
          where,
          missing: problem.missing.length,
          extra: problem.extra.length,
          duplicate: problem.duplicate.length,
        }
      : null;
  };

  const source = idCheck(
    "source",
    deps.beaches.map((b) => b.id),
  );
  if (source) return blocked("beach_ids", { beachIds: source });

  const [inputs, current] = await Promise.all([
    readPublishInputs(deps.state, deps.log),
    currentStatus(deps.snapshots),
  ]);
  let snapshot;
  try {
    snapshot = buildSnapshot({
      beaches: deps.beaches,
      zones: deps.zones,
      seasons: deps.seasons,
      inputs,
      now: at,
    });
  } catch (error) {
    if (error instanceof BeachSnapshotError) return blocked("classify");
    throw error;
  }
  const outputs =
    idCheck(
      "beaches",
      snapshot.beaches.beaches.map((b) => b.id),
    ) ?? idCheck("status", Object.keys(snapshot.status.beaches));
  if (outputs) return blocked("beach_ids", { beachIds: outputs });
  const errors = KEYS.flatMap((key) =>
    contractErrors(FILES[key].contract, snapshot[key]),
  ).length;
  if (errors > 0) return blocked("contract", { contractErrors: errors });

  const next = snapshot.status.beaches;
  const before = current.status?.beaches ?? null;
  const changed: PreviewBeachChange[] = [];
  if (before !== null) {
    for (const id of Object.keys(next).sort()) {
      const after = stateOf(next[id]!);
      const was = before[id] ? stateOf(before[id]) : null;
      if (was === null || !same(was, after)) {
        changed.push({ id, before: was, after });
      }
    }
  }
  return {
    status: "ready",
    at,
    current: {
      version: current.version,
      counts: before ? categoryCountsOf(before) : null,
      readable: before !== null,
      missing: current.missing,
    },
    next: { counts: categoryCountsOf(next) },
    changed: changed.slice(0, PREVIEW_CHANGED_LIMIT),
    changedCount: changed.length,
    checks: { beachIds: null, expected, contractErrors: 0 },
  };
}
