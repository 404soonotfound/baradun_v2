import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { actorOf, type AuditAction } from "./audit";
import type { Principal } from "./auth";
import type { DataDependencies } from "./handler";
import {
  errorJson,
  header,
  json,
  readJsonBody,
  safeLog,
  type RequestIds,
} from "./http";
import { noticeKey } from "./keys";
import {
  exposeProblem,
  getNotice,
  isNoticeId,
  noticeChanges,
  noticeState,
  noticeViews,
  parseNoticeInput,
  parseVersionBody,
  queryNotices,
  type NoticeContent,
  type NoticeRecord,
} from "./notices";
import { IDEMPOTENCY_KEY, IDEMPOTENCY_KEY_HEADER } from "./policy";
import { holdReleaseFor } from "./publish-reads";
import { sampleNotices } from "./sample-data";
import {
  payloadHashOf,
  previousWrite,
  versionedWrite,
  type RelatedWrite,
  type WriteResult,
} from "./writes";

// 공지 경로 (BRD-151, ADM-NTC). 허용표(routes.ts)를 통과한 요청만 옴
// 응답은 "저장했어요"까지만. 앱 반영은 다음 게시 때라 공개 반영으로 표시하지 않음(D16-D4)

type Result = APIGatewayProxyStructuredResultV2;
type Operator = Principal & { kind: "operator" };

// GET /ops/notices: 지운 공지는 빼고 상태(대기·예약·노출 중·종료)·수정 대기·가려짐을 함께 줌
// 운영자 sub(updatedBy)는 넣지 않음. 샘플은 예시 공지(공개 전 문구를 보이지 않게)
export async function listNoticesRoute(
  principal: Principal,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  if (principal.kind === "sample") {
    return json(200, sampleNotices(data.now()), ids);
  }
  const records = await queryNotices(data.client, data.opsTable);
  return json(200, { items: noticeViews(records, data.now()) }, ids);
}

export interface WriteRequest {
  readonly key: string;
  readonly raw: string;
  readonly value: unknown;
}

// 쓰기 요청 공통: 멱등 키 헤더(UUID v4)와 JSON 본문
export function readWrite(
  event: APIGatewayProxyEventV2,
  ids: RequestIds,
): { request: WriteRequest } | { error: Result } {
  const key = header(event, IDEMPOTENCY_KEY_HEADER);
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    return {
      error: errorJson(400, "invalid_request", ids, {
        field: "idempotencyKey",
      }),
    };
  }
  const body = readJsonBody(event);
  if (!body) {
    return { error: errorJson(400, "invalid_request", ids, { field: "body" }) };
  }
  return { request: { key, ...body } };
}

async function write(
  data: DataDependencies,
  principal: Operator,
  ids: RequestIds,
  request: WriteRequest,
  options: {
    readonly id: string;
    readonly mode: "create" | "update";
    readonly expectedVersion: number;
    readonly set: Record<string, unknown>;
    readonly action: AuditAction;
    readonly changes: readonly string[];
    // 변경 이력에 남길 공지 문구 앞·뒤(공개 문구라 남김, 시안 V23 펼치기)
    readonly notice: {
      readonly before: NoticeContent | null;
      readonly after: NoticeContent | null;
    };
    // 같은 트랜잭션에 넣을 관련 쓰기(되돌림 풀기). 있으면 바뀐 항목에 hold를 더함
    readonly related?: readonly RelatedWrite[];
  },
  now: Date,
): Promise<Result> {
  const related = options.related ?? [];
  const label = (
    options.notice.after ?? options.notice.before
  )?.title.ko.trim();
  const result = await versionedWrite(
    data.client,
    { ops: data.opsTable },
    {
      target: { kind: "ops", key: noticeKey(options.id), mode: options.mode },
      expectedVersion: options.expectedVersion,
      set: options.set,
      idempotencyKey: request.key,
      payloadHash: payloadHashOf(request.raw),
      actorSub: principal.sub,
      // 바뀐 항목 이름과 공지 문구 앞·뒤(공개 문구). 문의 본문·이메일은 여기 없음(D16-B5)
      audit: {
        actor: actorOf(principal),
        action: options.action,
        target: { kind: "notice", id: options.id },
        ...(label ? { targetLabel: label } : {}),
        notice: options.notice,
        changes:
          related.length > 0 ? [...options.changes, "hold"] : options.changes,
        ids,
      },
      ...(related.length > 0 ? { related } : {}),
    },
    now,
  );
  return answer(result, options.id, options.mode, ids);
}

function answer(
  result: WriteResult,
  id: string,
  mode: "create" | "update",
  ids: RequestIds,
): Result {
  if (result.status === "conflict") {
    return errorJson(409, "conflict", ids, { reason: result.reason });
  }
  safeLog("info", "ops_notice_written", {
    noticeId: id,
    version: result.version,
    replayed: result.status === "replayed" ? 1 : 0,
    traceId: ids.traceId,
  });
  return json(
    mode === "create" && result.status === "applied" ? 201 : 200,
    { noticeId: id, version: result.version },
    ids,
  );
}

// POST /ops/notices: 새 공지(대기). 노출본 없음
export async function createNoticeRoute(
  event: APIGatewayProxyEventV2,
  principal: Operator,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  const read = readWrite(event, ids);
  if ("error" in read) return read.error;
  const { request } = read;
  const check = parseNoticeInput(request.value, "create");
  if (!check.ok) {
    return errorJson(400, "invalid_request", ids, { field: check.field });
  }
  const now = data.now();
  // 같은 멱등 키로 다시 보내면 앞 결과(같은 ID)를 돌려줘야 함 → ID를 키에서 정함
  const id = `n-${request.key.replaceAll("-", "").slice(0, 12)}`;
  return write(
    data,
    principal,
    ids,
    request,
    {
      id,
      mode: "create",
      expectedVersion: 0,
      set: {
        kind: "notice",
        id,
        draft: check.content,
        live: null,
        exposedAt: null,
        deletedAt: null,
        createdAt: now.toISOString(),
      },
      action: "notice.create",
      changes: noticeChanges(null, check.content),
      notice: { before: null, after: check.content },
    },
    now,
  );
}

// 있는 공지를 바꾸는 쓰기의 앞부분: ID → 멱등 키·본문 → 같은 키의 앞 결과 → 지금 공지
// 앞 결과를 먼저 봐서, 재전송이 앞 쓰기로 바뀐 version·상태·삭제를 보고 409·404가 되지 않게 함(D16-B6)
async function begin(
  event: APIGatewayProxyEventV2,
  id: string,
  principal: Operator,
  data: DataDependencies,
  ids: RequestIds,
): Promise<
  { request: WriteRequest; record: NoticeRecord } | { result: Result }
> {
  if (!isNoticeId(id)) return { result: errorJson(404, "not_found", ids) };
  const read = readWrite(event, ids);
  if ("error" in read) return { result: read.error };
  const { request } = read;
  const previous = await previousWrite(
    data.client,
    { ops: data.opsTable },
    {
      target: { kind: "ops", key: noticeKey(id), mode: "update" },
      idempotencyKey: request.key,
      payloadHash: payloadHashOf(request.raw),
      actorSub: principal.sub,
    },
  );
  if (previous) return { result: answer(previous, id, "update", ids) };
  const record = await getNotice(data.client, data.opsTable, id);
  if (!record) return { result: errorJson(404, "not_found", ids) };
  return { request, record };
}

// PUT /ops/notices/{id}: 문구 저장(대기본만 바꿈. 노출본은 '노출' 전까지 그대로)
export async function updateNoticeRoute(
  event: APIGatewayProxyEventV2,
  id: string,
  principal: Operator,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  const started = await begin(event, id, principal, data, ids);
  if ("result" in started) return started.result;
  const { request, record } = started;
  const check = parseNoticeInput(request.value, "update");
  if (!check.ok) {
    return errorJson(400, "invalid_request", ids, { field: check.field });
  }
  return write(
    data,
    principal,
    ids,
    request,
    {
      id,
      mode: "update",
      expectedVersion: check.version,
      set: { draft: check.content },
      action: "notice.update",
      changes: noticeChanges(record.draft, check.content),
      notice: { before: record.draft, after: check.content },
    },
    data.now(),
  );
}

// POST /ops/notices/{id}/expose: 저장한 문구를 노출본으로 확정(다음 게시 때 앱에 나감)
// 한·영 모두·글자 수·차단 표현·끝 시각을 서버가 다시 확인. 통과 못 하면 잘라 내지 않고 거부(D16-D1·D2)
export async function exposeNoticeRoute(
  event: APIGatewayProxyEventV2,
  id: string,
  principal: Operator,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  const started = await begin(event, id, principal, data, ids);
  if ("result" in started) return started.result;
  const { request, record } = started;
  const check = parseVersionBody(request.value);
  if (!check.ok) {
    return errorJson(400, "invalid_request", ids, { field: check.field });
  }
  // 읽은 version이 다르면 다른 문구를 확인한 것 → 검사보다 먼저 409(쓰기 조건도 다시 막음)
  if (check.version !== record.version) {
    return errorJson(409, "conflict", ids, { reason: "version" });
  }
  const now = data.now();
  const problem = exposeProblem(record.draft, now);
  if (problem) {
    return errorJson(400, "invalid_request", ids, {
      field: problem.field,
      reason: problem.reason,
    });
  }
  return write(
    data,
    principal,
    ids,
    request,
    {
      id,
      mode: "update",
      expectedVersion: check.version,
      set: { live: record.draft, exposedAt: now.toISOString() },
      action: "notice.expose",
      changes: noticeChanges(record.live, record.draft),
      notice: { before: record.live, after: record.draft },
      // 되돌림 상태인 공지를 다시 노출하면 되돌림도 풂(운영자가 지금 문구를 확정함, 사용자 결정 2026-11-12)
      related: await holdReleaseFor(data.client, data.opsTable, id),
    },
    now,
  );
}

// POST /ops/notices/{id}/end: 노출 끝내기. 노출 중이면 끝 시각을 지금으로, 예약이면 노출본을 지움
// 웹은 받은 끝 시각부터 숨기고, 다음 게시에서 빠짐
export async function endNoticeRoute(
  event: APIGatewayProxyEventV2,
  id: string,
  principal: Operator,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  const started = await begin(event, id, principal, data, ids);
  if ("result" in started) return started.result;
  const { request, record } = started;
  const check = parseVersionBody(request.value);
  if (!check.ok) {
    return errorJson(400, "invalid_request", ids, { field: check.field });
  }
  if (check.version !== record.version) {
    return errorJson(409, "conflict", ids, { reason: "version" });
  }
  const now = data.now();
  const state = noticeState(record, now);
  if (state !== "live" && state !== "scheduled") {
    return errorJson(409, "conflict", ids, { reason: "not_live" });
  }
  const endsAt = now.toISOString();
  const set =
    state === "scheduled"
      ? { live: null }
      : {
          live: { ...record.live!, endsAt },
          // 저장한 문구도 같은 끝 시각으로 맞춤(끝낸 뒤 '수정 대기'로 보이지 않게)
          // 저장한 문구의 시작이 아직이면 그대로 둠(끝이 시작보다 앞서는 대기본을 만들지 않음)
          ...(Date.parse(record.draft.startsAt) < now.getTime()
            ? { draft: { ...record.draft, endsAt } }
            : {}),
        };
  return write(
    data,
    principal,
    ids,
    request,
    {
      id,
      mode: "update",
      expectedVersion: check.version,
      set,
      action: "notice.end",
      changes: state === "scheduled" ? ["live"] : ["endsAt"],
      // 되돌림 상태인 공지의 노출을 끝내면 되돌림도 풂(그때 노출본을 계속 싣지 않게, 사용자 결정 2026-11-12)
      related: await holdReleaseFor(data.client, data.opsTable, id),
      notice: {
        before: record.live,
        after: state === "scheduled" ? null : { ...record.live!, endsAt },
      },
    },
    now,
  );
}

// DELETE /ops/notices/{id}: 대기·예약·종료 공지만. 노출 중이면 먼저 노출을 끝내야 함(D16-D3)
// 예약된 노출본을 지우는 것은 노출을 바꾸는 일이라 노출 변경 권한만
// 항목은 지우지 않고 deletedAt만 남김(이력 보존)
export async function deleteNoticeRoute(
  event: APIGatewayProxyEventV2,
  id: string,
  principal: Operator,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  const started = await begin(event, id, principal, data, ids);
  if ("result" in started) return started.result;
  const { request, record } = started;
  const check = parseVersionBody(request.value);
  if (!check.ok) {
    return errorJson(400, "invalid_request", ids, { field: check.field });
  }
  if (check.version !== record.version) {
    return errorJson(409, "conflict", ids, { reason: "version" });
  }
  const now = data.now();
  const state = noticeState(record, now);
  if (state === "live") {
    return errorJson(409, "conflict", ids, { reason: "live" });
  }
  if (state === "scheduled" && principal.role !== "publisher") {
    return errorJson(403, "forbidden", ids);
  }
  return write(
    data,
    principal,
    ids,
    request,
    {
      id,
      mode: "update",
      expectedVersion: check.version,
      set: { deletedAt: now.toISOString() },
      action: "notice.delete",
      changes: ["deletedAt"],
      notice: { before: record.draft, after: null },
    },
    now,
  );
}
