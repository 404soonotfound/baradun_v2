import type { BeachId } from "@baradun/contracts";
import {
  checkPhoto,
  type PhotoCheck,
  type PhotoImage,
} from "../core/catalog/photo-check";
import type { StateValue } from "../core/store/types";
import { formatUtcIso } from "../core/warnings/time";
import {
  exceptionReason,
  type CollectDeps,
  type CollectRunResult,
} from "./ocean";
import { COLLECT_POLICY } from "./policy";
import { formatKst, slotStart } from "./schedule";

// collect-catalog (아키텍처 5장 D6·D9, BRD-58, 2026-10-23 사용자 결정)
// 하루 1회 대표 사진(data/beaches photo)의 공공누리 유형만 다시 확인함. 사진을 새로 고르거나 바꾸지 않음(원본은 저장소, 17.5)
// 확인 결과(type1·not_type1·missing)만 저장. 호출 실패는 확인 결과가 아니라서 그 해변의 이전 결과를 그대로 둠
// 카탈로그는 상태 분류와 분리됨(실시간 판단에 영향 없음)
// 유형 칸이 없거나 비어도 1유형이 아닌 것으로 봄(BRD-58 10/21: 칸이 없거나 유형 불명이면 사용 안 함)
// Lambda 연결과 publisher가 이 기록으로 beaches.json 사진을 빼는 일은 다음 PR(PR #52 publisher 머지 뒤)

export const CATALOG_JOB = "collect-catalog";
// photos: 해변별 마지막 확인 결과, attempt: 최근 시도 결과
export const CATALOG_STATE = {
  photos: { pk: "catalog", sk: "photos" },
  attempt: { pk: "catalog", sk: "attempt" },
} as const;

const BASE = "https://apis.data.go.kr/B551011/KorService2";

// 대장(data/photo-sources.json) 항목 하나. url은 저장소 photo.url과 같음(CI가 확인)
export interface PhotoSource {
  readonly beachId: BeachId;
  readonly url: string;
  readonly contentId: string;
  readonly image: PhotoImage;
}

export type PhotoStatus = "type1" | "not_type1" | "missing";
export interface PhotoRecord {
  readonly status: PhotoStatus;
  readonly url: string; // 확인한 사진 주소. 저장소 사진이 바뀌면 이 기록은 쓰지 않음
  readonly checkedAt: string;
}

export interface CatalogDeps extends CollectDeps {
  readonly photos: readonly PhotoSource[];
}

// 대장(data/photo-sources.json) → 확인할 목록. Lambda 번들에 들어가는 입력이라 모양이 틀리면
// 데이터가 아니라 빌드 문제 → 멈춤(틀린 항목을 빼고 돌지 않음). 사진 해변 = 대장은 CI(tools/beaches)가 확인함
export function parsePhotoLedger(json: unknown): PhotoSource[] {
  const beaches =
    typeof json === "object" && json !== null && !Array.isArray(json)
      ? (json as { beaches?: unknown }).beaches
      : undefined;
  if (typeof beaches !== "object" || beaches === null) {
    throw new RangeError("photo-sources.json: beaches 칸이 없음");
  }
  const sources: PhotoSource[] = [];
  for (const [beachId, entry] of Object.entries(beaches)) {
    const { contentId, image, url } = (entry ?? {}) as Record<string, unknown>;
    if (
      typeof contentId !== "string" ||
      !/^[0-9]+$/.test(contentId) ||
      (image !== "first" && image !== "detail") ||
      typeof url !== "string" ||
      !url.startsWith("https://")
    ) {
      throw new RangeError(`photo-sources.json: 항목 형식 오류: ${beachId}`);
    }
    sources.push({ beachId, url, contentId, image });
  }
  return sources.sort((a, b) => a.beachId.localeCompare(b.beachId));
}

function requestUrl(key: string, source: PhotoSource): string {
  const params = new URLSearchParams({
    serviceKey: key,
    MobileOS: "ETC",
    MobileApp: "baradun",
    _type: "json",
    contentId: source.contentId,
    ...(source.image === "detail"
      ? { imageYN: "Y", numOfRows: "100", pageNo: "1" }
      : {}),
  });
  const op = source.image === "first" ? "detailCommon2" : "detailImage2";
  return `${BASE}/${op}?${params}`;
}

async function checkOne(
  deps: CatalogDeps,
  key: string,
  source: PhotoSource,
): Promise<PhotoCheck> {
  const response = await deps.get(requestUrl(key, source));
  if (response.status === "failed") {
    return { status: "failed", reason: response.reason };
  }
  let json: unknown;
  try {
    json = JSON.parse(response.body);
  } catch {
    return { status: "failed", reason: "format:json" };
  }
  return checkPhoto(json, source.image, source.url, source.contentId);
}

export async function collectCatalog(
  deps: CatalogDeps,
): Promise<CollectRunResult> {
  const startedMs = deps.clock();
  const slotId = formatKst(
    slotStart(startedMs, COLLECT_POLICY.catalogSchedule),
    "minute",
  );
  const claim = await deps.ops.claimSlot(
    CATALOG_JOB,
    slotId,
    deps.owner,
    startedMs,
    COLLECT_POLICY.slotLeaseMs,
  );
  if (claim !== "claimed") {
    deps.log("info", "catalog_slot_skipped", { slotId, claim });
    return { status: "skipped", slotId, claim };
  }

  const key = await deps.keys.get("data-go-kr").catch(() => null);
  const results = new Map<BeachId, PhotoCheck>();
  if (key !== null) {
    // 몇 개씩 나눠 보냄. 시간 예산이 지나면 새 요청을 보내지 않음
    const queue = [...deps.photos];
    const worker = async () => {
      for (let source = queue.shift(); source; source = queue.shift()) {
        if (deps.clock() - startedMs > COLLECT_POLICY.catalogBudgetMs) return;
        const result = await checkOne(deps, key, source).catch(
          (error: unknown): PhotoCheck => ({
            status: "failed",
            reason: exceptionReason(error),
          }),
        );
        results.set(source.beachId, result);
      }
    };
    await Promise.all(
      Array.from({ length: COLLECT_POLICY.catalogConcurrency }, worker),
    );
  }

  // 이전 결과에 이번 확인 결과만 덮음. 실패·미확인 해변은 이전 결과 유지
  // 확인 결과가 하나도 없으면 쓰지 않음(저장한 것으로 치지 않음)
  const { pk, sk } = CATALOG_STATE.photos;
  const checkedAt = formatUtcIso(deps.clock());
  // 이번에 확인된 해변의 새 기록. 실패는 확인 결과가 아니라 넣지 않음(이전 결과 유지)
  const records = new Map<BeachId, PhotoRecord>();
  for (const source of deps.photos) {
    const result = results.get(source.beachId);
    if (result !== undefined && result.status !== "failed") {
      records.set(source.beachId, {
        status: result.status,
        url: source.url,
        checkedAt,
      });
    }
  }
  let saved = false;
  for (let attempt = 0; attempt < 2 && records.size > 0; attempt += 1) {
    const previous = await deps.state.getState(pk, sk);
    const prev = (previous?.value as { beaches?: unknown } | null)?.beaches;
    const beaches: Record<string, PhotoRecord> = {
      // 저장된 beaches가 객체가 아니면(오염된 기록) 섞지 않고 이번 결과만 씀
      ...(typeof prev === "object" && prev !== null && !Array.isArray(prev)
        ? (prev as Record<string, PhotoRecord>)
        : {}),
      ...Object.fromEntries(records),
    };
    // orderAt은 이전 값 이상 → stale 없음. conflict면 다시 읽어 한 번 더 합침
    const written = await deps.state.putState(
      pk,
      sk,
      { beaches } as unknown as StateValue,
      Math.max(startedMs, previous?.orderAt ?? 0),
      previous?.recordVersion ?? null,
    );
    if (written === "conflict") continue;
    saved = written !== "stale";
    break;
  }
  if (records.size > 0 && !saved) {
    deps.log("error", "catalog_photos_not_saved", { slotId });
  }

  const counts: Record<string, number> = {
    type1: 0,
    not_type1: 0,
    missing: 0,
    failed: 0,
    unchecked: 0,
  };
  for (const source of deps.photos) {
    const result = results.get(source.beachId);
    counts[result ? result.status : "unchecked"]! += 1;
    // 1유형이 아니게 됐거나 사진을 찾지 못함 → 게시에서 뺄 사진(publisher 연결 후). 저장소 사진을 고칠 수 있게 알림
    if (result?.status === "not_type1" || result?.status === "missing") {
      deps.log("warn", "catalog_photo_rejected", {
        slotId,
        beachId: source.beachId,
        contentId: source.contentId,
        status: result.status,
      });
    }
    if (result?.status === "failed") {
      deps.log("error", "catalog_photo_failed", {
        slotId,
        beachId: source.beachId,
        reason: result.reason,
      });
    }
  }
  await deps.state.putState(
    CATALOG_STATE.attempt.pk,
    CATALOG_STATE.attempt.sk,
    {
      attemptedAt: formatUtcIso(startedMs),
      slotId,
      keyLoaded: key !== null,
      saved,
      counts,
    },
    startedMs,
  );

  // 모두 확인하고 저장했을 때만 complete. 확인 결과를 하나도 저장하지 못했으면(모든 호출 실패 포함) failed
  const allChecked =
    key !== null &&
    (saved || records.size === 0) &&
    counts.failed === 0 &&
    counts.unchecked === 0;
  if (allChecked) await deps.ops.completeSlot(CATALOG_JOB, slotId, deps.owner);
  const status = allChecked ? "complete" : saved ? "partial" : "failed";
  deps.log(status === "complete" ? "info" : "error", "catalog_run_finished", {
    slotId,
    status,
    ...counts,
  });
  return { status, slotId };
}
