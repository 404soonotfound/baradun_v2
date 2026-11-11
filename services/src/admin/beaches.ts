import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { ManifestFile, Reason, StatusFile } from "@baradun/contracts";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type { SnapshotStore } from "../core/snapshots/types";
import { contractErrors } from "../publisher/validate";
import { actorOf } from "./audit";
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
import { MEMO_MAX } from "./inquiries";
import { beachMemoKey } from "./keys";
import { IDEMPOTENCY_KEY, IDEMPOTENCY_KEY_HEADER } from "./policy";
import { payloadHashOf, versionedWrite, type Sender } from "./writes";

// 해변 관리 (BRD-150, 화면 ADM-BCH, 결정 기록 D15-4, 아키텍처 18.1)
// - 해변 정보(정의·별칭·노출·사진)는 저장소 파일이 원본. 운영 API는 다루지 않음(화면이 빌드 때 읽음)
// - 지금 표시 상태: publisher가 게시한 status.json의 분류·사유를 그대로 돌려줌. 다시 계산하지 않음(G1)
//   게시본을 읽지 못하면 available: false. 화면은 모든 해변을 판단불가 계열로 보여 줌('특보 없음'으로 바꾸지 않음)
// - 운영 메모: 해변별 내부용. Ops 테이블에만 둠. publisher는 admin#notice만 읽어 게시본에 나가지 않음
//   변경 이력에는 바뀐 항목 이름만 남기고 메모 글은 복사하지 않음(D16-B5)

type Result = APIGatewayProxyStructuredResultV2;
type Operator = Principal & { kind: "operator" };

// data/beaches 파일 이름 = 해변 ID(b + 숫자 4자리)
export const BEACH_ID = /^b\d{4}$/;

// publisher가 바꾸는 게시본 입구(services/src/publisher/publish.ts MANIFEST_PATH와 같음)
const MANIFEST_PATH = "data/manifest.json";
// manifest가 가리키는 status 경로 모양. 다른 경로는 읽지 않음
const STATUS_PATH = /^\/(data\/[0-9]{8}T[0-9]{6}Z\/status\.json)$/;

export type StatusUnavailableReason =
  // 게시 버킷 설정이 없음(운영 API에 버킷 이름·읽기 권한을 아직 주지 않음)
  | "not_configured"
  | "manifest_missing"
  | "manifest_invalid"
  | "status_missing"
  | "status_invalid"
  | "read_failed";

export interface BeachStatusEntry {
  readonly category: StatusFile["beaches"][string]["category"];
  readonly reasons: readonly Reason[];
}

export type BeachStatusView =
  | {
      readonly available: true;
      readonly snapshotVersion: string;
      readonly generatedAt: string;
      readonly beaches: Readonly<Record<string, BeachStatusEntry>>;
    }
  | { readonly available: false; readonly reason: StatusUnavailableReason };

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

// 게시본 읽기: manifest → status.json. 둘 다 계약 검사를 통과해야 함(해변 하나라도 틀리면 전체를 못 읽은 것으로 봄)
export async function readBeachStatus(
  store: SnapshotStore | null,
): Promise<BeachStatusView> {
  if (!store) return { available: false, reason: "not_configured" };
  try {
    const manifestBody = await store.getFile(MANIFEST_PATH);
    if (manifestBody === null) {
      return { available: false, reason: "manifest_missing" };
    }
    const manifest = parseJson(manifestBody);
    if (contractErrors("ManifestFile", manifest).length > 0) {
      return { available: false, reason: "manifest_invalid" };
    }
    const { snapshotVersion, generatedAt, files } = manifest as ManifestFile;
    const path = STATUS_PATH.exec(files.status)?.[1];
    if (!path) return { available: false, reason: "manifest_invalid" };
    const statusBody = await store.getFile(path);
    if (statusBody === null) {
      return { available: false, reason: "status_missing" };
    }
    const status = parseJson(statusBody);
    if (contractErrors("StatusFile", status).length > 0) {
      return { available: false, reason: "status_invalid" };
    }
    const beaches: Record<string, BeachStatusEntry> = {};
    for (const [id, beach] of Object.entries((status as StatusFile).beaches)) {
      beaches[id] = { category: beach.category, reasons: beach.reasons };
    }
    return { available: true, snapshotVersion, generatedAt, beaches };
  } catch {
    return { available: false, reason: "read_failed" };
  }
}

export interface BeachMemoView {
  readonly beachId: string;
  readonly memo: string | null;
  // 0: 아직 저장한 적 없음
  readonly version: number;
  readonly updatedAt: string | null;
}

// 메모 읽기(강한 일관성). 없으면 version 0. 모양이 틀린 항목은 빈 메모로 바꾸지 않고 던짐(500)
export async function getBeachMemo(
  client: Sender,
  opsTable: string,
  beachId: string,
): Promise<BeachMemoView> {
  const out = (await client.send(
    new GetCommand({
      TableName: opsTable,
      Key: beachMemoKey(beachId),
      ConsistentRead: true,
    }),
  )) as { Item?: Record<string, unknown> };
  const item = out.Item;
  if (!item) return { beachId, memo: null, version: 0, updatedAt: null };
  const { memo, version, updatedAt } = item;
  if (
    (memo !== null && typeof memo !== "string") ||
    !Number.isSafeInteger(version) ||
    (version as number) < 1 ||
    typeof updatedAt !== "string"
  ) {
    throw new Error("해변 메모 모양이 틀림");
  }
  return { beachId, memo, version: version as number, updatedAt };
}

export interface BeachMemoPut {
  readonly version: number;
  readonly memo: string | null;
}

export type BeachMemoCheck =
  | { readonly ok: true; readonly put: BeachMemoPut }
  | { readonly ok: false; readonly field: string };

// 요청 본문 검사. 모르는 칸은 거부. 공백만 남긴 메모는 '메모 없음'(null)으로 저장
export function parseBeachMemoPut(body: unknown): BeachMemoCheck {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, field: "body" };
  }
  const value = body as Record<string, unknown>;
  const unknown = Object.keys(value).find(
    (k) => k !== "version" && k !== "memo",
  );
  if (unknown) return { ok: false, field: unknown };
  const { version, memo } = value;
  if (!Number.isSafeInteger(version) || (version as number) < 0) {
    return { ok: false, field: "version" };
  }
  if (
    memo === undefined ||
    (memo !== null && typeof memo !== "string") ||
    (typeof memo === "string" && [...memo].length > MEMO_MAX)
  ) {
    return { ok: false, field: "memo" };
  }
  return {
    ok: true,
    put: {
      version: version as number,
      memo: typeof memo === "string" && memo.trim() !== "" ? memo : null,
    },
  };
}

// GET /ops/beaches/published
export async function beachStatusRoute(
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  const view = await readBeachStatus(data.snapshots ?? null);
  if (!view.available) {
    safeLog("warn", "ops_beach_status_unavailable", {
      reason: view.reason,
      traceId: ids.traceId,
    });
  }
  return json(200, view, ids);
}

// GET /ops/beaches/{id}/memo
export async function beachMemoGetRoute(
  id: string,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  if (!BEACH_ID.test(id)) return errorJson(404, "not_found", ids);
  return json(200, await getBeachMemo(data.client, data.opsTable, id), ids);
}

// PUT /ops/beaches/{id}/memo: 읽을 때 받은 version과 함께 보냄(다르면 409, 덮어쓰지 않음)
export async function beachMemoPutRoute(
  event: APIGatewayProxyEventV2,
  id: string,
  principal: Operator,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  if (!BEACH_ID.test(id)) return errorJson(404, "not_found", ids);
  const key = header(event, IDEMPOTENCY_KEY_HEADER);
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    return errorJson(400, "invalid_request", ids, { field: "idempotencyKey" });
  }
  const body = readJsonBody(event);
  if (!body) return errorJson(400, "invalid_request", ids, { field: "body" });
  const check = parseBeachMemoPut(body.value);
  if (!check.ok) {
    return errorJson(400, "invalid_request", ids, { field: check.field });
  }
  const result = await versionedWrite(
    data.client,
    { ops: data.opsTable },
    {
      target: {
        kind: "ops",
        key: beachMemoKey(id),
        mode: check.put.version === 0 ? "create" : "update",
      },
      expectedVersion: check.put.version,
      set: { kind: "beach_memo", beachId: id, memo: check.put.memo },
      idempotencyKey: key,
      payloadHash: payloadHashOf(body.raw),
      actorSub: principal.sub,
      // 메모 글은 넣지 않고 바뀐 항목 이름만(D16-B5)
      audit: {
        actor: actorOf(principal),
        action: "beach.memo",
        target: { kind: "beach", id },
        changes: ["beachMemo"],
        ids,
      },
    },
    data.now(),
  );
  if (result.status === "conflict") {
    return errorJson(409, "conflict", ids, { reason: result.reason });
  }
  safeLog("info", "ops_beach_memo_written", {
    beachId: id,
    version: result.version,
    replayed: result.status === "replayed" ? 1 : 0,
    traceId: ids.traceId,
  });
  return json(200, { beachId: id, version: result.version }, ids);
}
