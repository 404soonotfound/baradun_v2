import type { Logger } from "../core/collect/log";
import { exceptionReason, type CollectRunResult } from "./ocean";

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

export type ClaimedRunResult = Exclude<CollectRunResult, { status: "skipped" }>;

export interface FinishDeps extends TriggerDeps {
  // 실행 기록 남기기(core/collect/run-log.ts, BRD-149). 슬롯을 맡은 실행만
  readonly record: (result: ClaimedRunResult) => Promise<void>;
}

// 수집 Lambda 마무리: 실행 기록 → 깨우기 → 다 저장하지 못했으면(partial·failed) 그 뒤에 던짐(Lambda 오류 지표)
// 순서를 바꾸면 이력 저장만 실패한 실행도 게시를 깨우지 못함 → 테스트로 고정(BRD-94)
// 실행 기록은 운영 화면용이라 쓰기에 실패해도 오류 로그만 남기고 깨우기를 막지 않음
export async function finishRun(
  result: CollectRunResult,
  deps: FinishDeps,
): Promise<CollectRunResult> {
  if (result.status !== "skipped") await recordRun(result, deps);
  await triggerPublish(result, deps);
  if (result.status === "partial" || result.status === "failed") {
    throw new Error(`수집 ${result.status}: ${result.slotId}`);
  }
  return result;
}

async function recordRun(result: ClaimedRunResult, deps: FinishDeps) {
  await deps.record(result).catch((error: unknown) => {
    deps.log("error", "run_record_failed", {
      slotId: result.slotId,
      error: error instanceof Error ? error.name : typeof error,
    });
  });
}

// 수집 함수가 예외로 끝나도(시도 기록·슬롯 저장 실패 등) 실행 기록에 실패로 남기고 그대로 던짐
// 기록이 없으면 수집 현황이 이전의 정상 기록을 계속 '정상'으로 보여 줌 → 결측을 정상으로 읽지 않게 함
// 슬롯을 맡기 전 예외일 수도 있어 슬롯 id는 모름(빈 값). 깨우기는 하지 않음(전과 같음)
export async function runCollector(
  collect: () => Promise<CollectRunResult>,
  deps: FinishDeps,
): Promise<CollectRunResult> {
  let result: CollectRunResult;
  try {
    result = await collect();
  } catch (error) {
    await recordRun(
      {
        status: "failed",
        slotId: "",
        failures: [{ source: "run", reason: exceptionReason(error) }],
      },
      deps,
    );
    throw error;
  }
  return finishRun(result, deps);
}
