import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  PUBLISH_JOB_ID,
  PUBLISH_JOB_RETENTION_MS,
  publishJobKey,
  type PublishJob,
  type PublishJobAction,
} from "../core/collect/publish-job";
import { snapshotVersion } from "../core/snapshots/version";
import {
  failPendingPublishJobItem,
  NOTICE_HOLD_KEY,
} from "../core/store/dynamodb";
import { actorOf } from "./audit";
import type { Principal } from "./auth";
import type { DataDependencies } from "./handler";
import { errorJson, json, safeLog, type RequestIds } from "./http";
import { PUBLISH_JOB_SLOT_KEY } from "./keys";
import { readWrite } from "./notice-routes";
import { getNotice, isNoticeId, parseVersionBody } from "./notices";
import {
  jobViewOf,
  readFailedRuns,
  readJob,
  readJobSlot,
  readLastRun,
  readNoticeHold,
  readPublishOverview,
  readSummaries,
  type JobView,
} from "./publish-reads";
import { payloadHashOf, previousWrite, versionedWrite } from "./writes";

// 데이터 게시 경로 (#331, 화면 ADM-PUB). 허용표(routes.ts)를 통과한 요청만 옴
// - GET /ops/publish: 게시 현황(publish-reads.ts)
// - POST /ops/publish/jobs: '지금 게시'·'되돌리기' 작업 만들기 → 작업 ID(202). 결과는 작업 조회로 봄(D16-C4)
// - GET /ops/publish/jobs/{id}: 작업 상태(대기·실행·게시 완료·실패)
// - POST /ops/publish/holds/{id}/reapply: 되돌린 공지 다시 적용(되돌림 포인터에서 그 공지를 뺌, D20-2·D16-C3)
// 판단 상태를 바꾸는 조작은 없음(G1). 게시 파일은 publisher만 씀(6.2 단일 작성자)

type Result = APIGatewayProxyStructuredResultV2;
type Operator = Principal & { kind: "operator" };

// 운영 API가 publisher를 비동기로 부르는 방법(handler가 Lambda 호출로 만듦). 시험은 가짜로 바꿈
export interface PublisherInvoker {
  invoke(event: PublisherJobEvent): Promise<void>;
}

export type PublisherJobEvent =
  | { readonly action: "publish"; readonly jobId: string }
  | {
      readonly action: "rollback";
      readonly version: string;
      readonly jobId: string;
    };

const VERSION = /^[0-9]{8}T[0-9]{6}Z$/;

// GET /ops/publish
export async function publishOverviewRoute(
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  const view = await readPublishOverview(
    data.client,
    data.opsTable,
    data.snapshots ?? null,
    data.now(),
  );
  return json(200, view, ids);
}

type JobRequest =
  | { readonly action: "publish" }
  | { readonly action: "rollback"; readonly version: string };

// 본문은 정해진 칸만. 모르는 칸이 있으면 거부(오타 난 되돌리기를 '지금 게시'로 돌리지 않음)
export function parseJobRequest(
  value: unknown,
): { ok: true; request: JobRequest } | { ok: false; field: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, field: "body" };
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort().join(",");
  if (body.action === "publish" && keys === "action") {
    return { ok: true, request: { action: "publish" } };
  }
  if (body.action === "rollback" && keys === "action,version") {
    if (typeof body.version !== "string" || !VERSION.test(body.version)) {
      return { ok: false, field: "version" };
    }
    return { ok: true, request: { action: "rollback", version: body.version } };
  }
  return { ok: false, field: "action" };
}

// 같은 멱등 키 → 같은 작업 ID(공지 ID와 같은 방식)
export function jobIdOf(idempotencyKey: string): string {
  return `j-${idempotencyKey.replaceAll("-", "").slice(0, 12)}`;
}

// 아직 끝나지 않았고 시간 제한 안인 작업(새 작업을 받지 않음)
function isActive(job: PublishJob, nowMs: number): boolean {
  return (
    (job.state === "pending" || job.state === "running") &&
    !jobViewOf(job, nowMs).overdue
  );
}

function eventOf(job: PublishJob): PublisherJobEvent {
  return job.action === "rollback" && job.target !== undefined
    ? { action: "rollback", version: job.target, jobId: job.jobId }
    : { action: "publish", jobId: job.jobId };
}

// publisher 호출. 실패하면 작업을 실패(invoke_failed)로 바꿈(아직 '대기'일 때만)
// 바꾸지도 못하면 작업은 '대기'로 남고 시작 제한이 지나 publisher가 맡지 않음 → 화면은 늦어짐(overdue)
async function invokeJob(
  data: DataDependencies,
  job: PublishJob,
  ids: RequestIds,
): Promise<PublishJob> {
  try {
    await data.publisher!.invoke(eventOf(job));
    return job;
  } catch (error) {
    safeLog("error", "ops_publish_invoke_failed", {
      jobId: job.jobId,
      traceId: ids.traceId,
      error: error instanceof Error ? error.name : "unknown",
    });
    const now = data.now();
    const failed = await failPendingPublishJobItem(
      data.client,
      data.opsTable,
      job.jobId,
      "invoke_failed",
      now.getTime(),
    ).catch(() => false);
    return failed
      ? {
          ...job,
          state: "failed",
          reason: "invoke_failed",
          finishedAt: now.toISOString(),
        }
      : job;
  }
}

function jobAnswer(
  statusCode: number,
  job: PublishJob,
  nowMs: number,
  ids: RequestIds,
): Result {
  return json(
    statusCode,
    { jobId: job.jobId, job: jobViewOf(job, nowMs) },
    ids,
  );
}

// POST /ops/publish/jobs: 작업 만들기
// 순서: 멱등 키·본문 → 같은 키의 앞 결과(있으면 그 작업) → 진행 중 작업 확인 → 작업 자리·작업·감사 한 트랜잭션 → publisher 호출
// - 같은 키·같은 내용 재시도: 새 작업을 만들지 않고 앞 작업을 돌려줌. 앞 작업이 아직 '대기'면 publisher를 다시 부름
//   (응답 시간 초과로 호출이 됐는지 모를 때. publisher는 '대기'일 때만 맡으므로 두 번 실행되지 않음)
// - 같은 키·다른 내용: 409(idempotency_mismatch)
// - 진행 중 작업이 있거나 동시에 다른 작업이 먼저 만들어짐: 409(busy). 연속·동시 실행을 받지 않음
export async function createPublishJobRoute(
  event: APIGatewayProxyEventV2,
  principal: Operator,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  const read = readWrite(event, ids);
  if ("error" in read) return read.error;
  const { request } = read;
  const parsed = parseJobRequest(request.value);
  if (!parsed.ok) {
    return errorJson(400, "invalid_request", ids, { field: parsed.field });
  }
  if (!data.publisher) {
    // 호출할 publisher가 없으면 작업을 만들지 않음(만들면 '대기'로만 남음)
    safeLog("error", "ops_publish_invoker_missing", { traceId: ids.traceId });
    return errorJson(500, "internal", ids);
  }
  const jobId = jobIdOf(request.key);
  const payloadHash = payloadHashOf(request.raw);
  const replay = {
    target: {
      kind: "ops" as const,
      key: PUBLISH_JOB_SLOT_KEY,
      mode: "update" as const,
    },
    idempotencyKey: request.key,
    payloadHash,
    actorSub: principal.sub,
  };

  const resend = async (): Promise<Result> => {
    const job = await readJob(data.client, data.opsTable, jobId);
    if (!job) throw new Error("멱등 기록은 있는데 작업이 없음");
    const nowMs = data.now().getTime();
    const current =
      job.state === "pending" && !jobViewOf(job, nowMs).overdue
        ? await invokeJob(data, job, ids)
        : job;
    return jobAnswer(202, current, nowMs, ids);
  };

  const previous = await previousWrite(
    data.client,
    { ops: data.opsTable },
    replay,
  );
  if (previous?.status === "conflict") {
    return errorJson(409, "conflict", ids, { reason: previous.reason });
  }
  if (previous) return resend();

  const now = data.now();
  const nowMs = now.getTime();
  const slot = await readJobSlot(data.client, data.opsTable);
  const active = slot
    ? await readJob(data.client, data.opsTable, slot.jobId)
    : null;
  if (active && isActive(active, nowMs)) {
    return errorJson(409, "conflict", ids, {
      reason: "busy",
      jobId: active.jobId,
    });
  }

  const action: PublishJobAction = parsed.request.action;
  const target =
    parsed.request.action === "rollback" ? parsed.request.version : undefined;
  const job: PublishJob = {
    jobId,
    action,
    ...(target !== undefined ? { target } : {}),
    state: "pending",
    createdAt: now.toISOString(),
    createdAtMs: nowMs,
  };
  const result = await versionedWrite(
    data.client,
    { ops: data.opsTable },
    {
      target: {
        kind: "ops",
        key: PUBLISH_JOB_SLOT_KEY,
        mode: slot ? "update" : "create",
      },
      expectedVersion: slot?.version ?? 0,
      set: { jobId, createdAt: job.createdAt },
      idempotencyKey: request.key,
      payloadHash,
      actorSub: principal.sub,
      related: [
        {
          kind: "put",
          key: publishJobKey(jobId),
          item: {
            kind: "publish-job",
            ...job,
            ttl: Math.floor((nowMs + PUBLISH_JOB_RETENTION_MS) / 1000),
          },
        },
      ],
      // 작업 ID와 되돌리기에서 고른 게시본 버전만(공지 문구 없음)
      audit: {
        actor: actorOf(principal),
        action: action === "rollback" ? "publish.rollback" : "publish.now",
        target: { kind: "publish", id: jobId },
        ...(target !== undefined ? { targetLabel: target } : {}),
        changes: action === "rollback" ? ["job", "rollbackTo"] : ["job"],
        ids,
      },
    },
    now,
  );
  if (result.status === "replayed") return resend();
  if (result.status === "conflict") {
    // 작업 자리 version이 바뀜 = 그사이 다른 작업이 만들어짐
    return errorJson(409, "conflict", ids, {
      reason: result.reason === "version" ? "busy" : result.reason,
    });
  }
  safeLog("info", "ops_publish_job_created", {
    jobId,
    action,
    traceId: ids.traceId,
  });
  const invoked = await invokeJob(data, job, ids);
  return jobAnswer(202, invoked, nowMs, ids);
}

// 작업 기록이 늦어진 작업(시간 제한 넘김)의 결과를 게시 실행 기록·게시 요약에서 찾음
// publisher가 게시는 끝냈는데 작업 기록만 남기지 못한 경우(S3 전환과 DB 기록의 부분 성공)를 작업 상태로 보여 줌
async function resolveFromRuns(
  data: DataDependencies,
  job: PublishJob,
): Promise<PublishJob | null> {
  const from = snapshotVersion(job.createdAtMs);
  // 작업을 만든 뒤의 기록을 오래된 순으로(publisher는 만든 뒤 시작 제한 2분 안에만 실행함)
  const [last, summaries, failed] = await Promise.all([
    readLastRun(data.client, data.opsTable),
    readSummaries(data.client, data.opsTable, 10, { from, forward: true }),
    readFailedRuns(data.client, data.opsTable, 10, { from, forward: true }),
  ]);
  const summary = summaries.find(
    (row) => row.jobId === job.jobId && row.version >= from,
  );
  if (summary) {
    return {
      ...job,
      state: "done",
      result: "published",
      snapshotVersion: summary.version,
    };
  }
  if (last?.jobId === job.jobId && last.result !== "failed") {
    return {
      ...job,
      state: "done",
      result: last.result,
      snapshotVersion: last.version,
    };
  }
  const fail = failed.find((run) => run.jobId === job.jobId);
  if (fail) {
    return {
      ...job,
      state: "failed",
      snapshotVersion: fail.version,
      ...(fail.reason !== undefined ? { reason: fail.reason } : {}),
    };
  }
  return null;
}

// GET /ops/publish/jobs/{id}
export async function publishJobRoute(
  id: string,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  if (!PUBLISH_JOB_ID.test(id)) return errorJson(404, "not_found", ids);
  const job = await readJob(data.client, data.opsTable, id);
  if (!job) return errorJson(404, "not_found", ids);
  const nowMs = data.now().getTime();
  const view = jobViewOf(job, nowMs);
  if (view.overdue) {
    const resolved = await resolveFromRuns(data, job);
    if (resolved) {
      const body: JobView & { readonly fromRunRecord: true } = {
        ...jobViewOf(resolved, nowMs),
        fromRunRecord: true,
      };
      return json(200, { jobId: id, job: body }, ids);
    }
  }
  return json(200, { jobId: id, job: view }, ids);
}

// POST /ops/publish/holds/{id}/reapply: 본문 { version: 되돌림 포인터 version }
// 그 공지를 포인터에서 빼면 다음 게시부터 운영 DB의 노출본(없으면 싣지 않음)을 다시 씀
export async function reapplyNoticeRoute(
  event: APIGatewayProxyEventV2,
  noticeId: string,
  principal: Operator,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  if (!isNoticeId(noticeId)) return errorJson(404, "not_found", ids);
  const read = readWrite(event, ids);
  if ("error" in read) return read.error;
  const { request } = read;
  const check = parseVersionBody(request.value);
  if (!check.ok) {
    return errorJson(400, "invalid_request", ids, { field: check.field });
  }
  const payloadHash = payloadHashOf(request.raw);
  const target = {
    kind: "ops" as const,
    key: NOTICE_HOLD_KEY,
    mode: "update" as const,
  };
  const answer = (result: { status: string; version: number }) => {
    safeLog("info", "ops_notice_reapplied", {
      noticeId,
      version: result.version,
      replayed: result.status === "replayed" ? 1 : 0,
      traceId: ids.traceId,
    });
    return json(200, { noticeId, holdVersion: result.version }, ids);
  };
  const previous = await previousWrite(
    data.client,
    { ops: data.opsTable },
    {
      target,
      idempotencyKey: request.key,
      payloadHash,
      actorSub: principal.sub,
    },
  );
  if (previous?.status === "conflict") {
    return errorJson(409, "conflict", ids, { reason: previous.reason });
  }
  if (previous) return answer(previous);

  const hold = await readNoticeHold(data.client, data.opsTable);
  if (!hold || hold.version !== check.version) {
    return errorJson(409, "conflict", ids, { reason: "version" });
  }
  const held = hold.notices[noticeId];
  if (!Object.hasOwn(hold.notices, noticeId) || !held) {
    return errorJson(404, "not_found", ids);
  }
  const record = await getNotice(data.client, data.opsTable, noticeId);
  const label = (record?.draft.title.ko ?? held.live?.title.ko)?.trim();
  const result = await versionedWrite(
    data.client,
    { ops: data.opsTable },
    {
      target,
      expectedVersion: hold.version,
      set: {
        notices: Object.fromEntries(
          Object.entries(hold.notices).filter(([id]) => id !== noticeId),
        ),
      },
      idempotencyKey: request.key,
      payloadHash,
      actorSub: principal.sub,
      // 공지 ID·제목과 바뀐 항목 이름만(되돌린 노출본 문구는 넣지 않음)
      audit: {
        actor: actorOf(principal),
        action: "publish.reapply",
        target: { kind: "notice", id: noticeId },
        ...(label ? { targetLabel: label } : {}),
        changes: ["hold"],
        ids,
      },
    },
    data.now(),
  );
  if (result.status === "conflict") {
    return errorJson(409, "conflict", ids, { reason: result.reason });
  }
  return answer(result);
}
