import type { Logger } from "../core/collect/log";
import type { CollectRunResult } from "./ocean";

// 수집 뒤 publish-snapshot 깨우기 (아키텍처 6.2 '수집 Lambda는 사실만 저장하고 publish-snapshot을 비동기로 깨움', BRD-61 PR ②)
// 이번 실행이 슬롯을 맡았으면(complete·partial·failed) 깨움. 실패한 수집도 깨우는 이유:
// 새 사실이 없어도 시간이 지나면 분류가 바뀜(특보 확인 45분·파고 90분이 지나면 판단불가) → 그 시각으로 다시 게시
// 다른 실행이 맡은 슬롯(skipped)은 그 실행이 깨움
// 깨우기 실패는 던짐(Lambda 오류 지표로 보임). 저장한 사실은 그대로이고 다음 수집이 다시 깨움

export interface TriggerDeps {
  readonly invoke: () => Promise<void>;
  readonly log: Logger;
}

export async function triggerPublish(
  result: CollectRunResult,
  deps: TriggerDeps,
): Promise<boolean> {
  if (result.status === "skipped") return false;
  try {
    await deps.invoke();
    return true;
  } catch (error) {
    deps.log("error", "publish_trigger_failed", {
      slotId: result.slotId,
      error: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }
}

// 수집 Lambda 마무리: 먼저 깨우고, 다 저장하지 못했으면(partial·failed) 그 뒤에 던짐(Lambda 오류 지표)
// 순서를 바꾸면 이력 저장만 실패한 실행도 게시를 깨우지 못함 → 테스트로 고정(BRD-94)
export async function finishRun(
  result: CollectRunResult,
  deps: TriggerDeps,
): Promise<CollectRunResult> {
  await triggerPublish(result, deps);
  if (result.status === "partial" || result.status === "failed") {
    throw new Error(`수집 ${result.status}: ${result.slotId}`);
  }
  return result;
}
