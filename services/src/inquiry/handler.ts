import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SNSClient } from "@aws-sdk/client-sns";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type {
  CreateInquiryRequest,
  CreateInquiryResponse,
  InquiryErrorResponse,
  InquiryUploadResponse,
} from "@baradun/contracts";
import { createHash, randomUUID } from "node:crypto";
import { InquiryNotifier } from "./notification";
import { InquiryPhotos } from "./photos";
import { INQUIRY_MAX_BODY_BYTES } from "./policy";
import { InquiryStore, type InquiryReceipt } from "./store";
import {
  isCreateInquiryRequest,
  isInquiryUploadRequest,
  isInquiryUploadResponse,
} from "./validation";

const INQUIRY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface DeleteEmailEvent {
  readonly action: "delete_email";
  readonly inquiryId: string;
}

export interface InquiryDependencies {
  readonly store: InquiryStore;
  readonly photos: InquiryPhotos;
  readonly notifier: InquiryNotifier;
  readonly now: () => Date;
  readonly id: () => string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경 변수 없음: ${name}`);
  return value;
}

function safeLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, string | number> = {},
): void {
  console.log(JSON.stringify({ level, event, ...fields }));
}

function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const entry = Object.entries(event.headers).find(
    ([key]) => key.toLowerCase() === wanted,
  );
  return entry?.[1];
}

function jsonResponse(
  statusCode: number,
  body: InquiryUploadResponse | CreateInquiryResponse | InquiryErrorResponse,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function errorResponse(
  statusCode: number,
  code: InquiryErrorResponse["error"]["code"],
  message: string,
): APIGatewayProxyStructuredResultV2 {
  return jsonResponse(statusCode, { error: { code, message } });
}

function requestBytes(event: APIGatewayProxyEventV2): Buffer | undefined {
  if (event.body === undefined) return undefined;
  return Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
}

function validRequestBody(
  event: APIGatewayProxyEventV2,
): { bytes: Buffer; value: unknown } | undefined {
  const contentType = header(event, "content-type")?.split(";", 1)[0]?.trim();
  const expectedHash = header(event, "x-amz-content-sha256")?.toLowerCase();
  const bytes = requestBytes(event);
  if (
    contentType !== "application/json" ||
    !bytes ||
    bytes.length < 1 ||
    bytes.length > INQUIRY_MAX_BODY_BYTES ||
    !expectedHash ||
    !/^[0-9a-f]{64}$/.test(expectedHash)
  ) {
    return undefined;
  }

  const declaredLength = Number(header(event, "content-length"));
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength !== bytes.length
  ) {
    return undefined;
  }
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expectedHash) return undefined;

  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch {
    return undefined;
  }
}

function isDeleteEmailEvent(event: unknown): event is DeleteEmailEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { action?: unknown }).action === "delete_email" &&
    typeof (event as { inquiryId?: unknown }).inquiryId === "string" &&
    INQUIRY_ID.test((event as { inquiryId: string }).inquiryId)
  );
}

function isHttpEvent(event: unknown): event is APIGatewayProxyEventV2 {
  return (
    typeof event === "object" &&
    event !== null &&
    "requestContext" in event &&
    typeof (event as APIGatewayProxyEventV2).requestContext?.http?.method ===
      "string"
  );
}

const rateLimited = () =>
  errorResponse(429, "rate_limited", "요청이 많습니다. 잠시 뒤 다시 시도해 주세요.");

// 멱등 키를 뺀 보낸 값 그대로(다듬기 전)의 SHA-256. 같은 키로 온 두 요청이 같은 내용인지 가림
// 해변·활동(결정 22)은 있을 때만 뒤에 붙임 → 둘 다 없는 요청의 지문은 칸을 넣기 전과 같음
// (배포 직전 접수된 문의의 재시도가 지문 불일치 409로 버려져 두 번 접수되지 않게)
export function requestFingerprint(request: CreateInquiryRequest): string {
  const context =
    request.beachId === undefined && request.activity === undefined
      ? []
      : [request.beachId ?? null, request.activity ?? null];
  return createHash("sha256")
    .update(
      JSON.stringify([
        request.type,
        request.message,
        request.email ?? null,
        request.photos.map((photo) => [photo.photoId, photo.key]),
        ...context,
      ]),
    )
    .digest("hex");
}

// 같은 키의 두 번째 요청: 내용이 같으면 첫 결과를 그대로, 다르면 409
function replay(
  receipt: InquiryReceipt,
  fingerprint: string,
): APIGatewayProxyStructuredResultV2 {
  if (receipt.fingerprint !== fingerprint) {
    safeLog("warn", "inquiry_idempotency_conflict");
    return errorResponse(
      409,
      "idempotency_conflict",
      "같은 요청 키로 다른 내용을 보낼 수 없습니다.",
    );
  }
  safeLog("info", "inquiry_replayed");
  return jsonResponse(201, receipt.response);
}

async function createInquiry(
  request: CreateInquiryRequest,
  dependencies: InquiryDependencies,
): Promise<APIGatewayProxyStructuredResultV2> {
  const fingerprint = requestFingerprint(request);
  // 이미 접수한 키는 속도 제한을 다시 세지 않고 첫 결과를 돌려줌(응답을 못 받은 재시도가 429로 막히지 않게)
  const earlier = await dependencies.store.findReceipt(request.idempotencyKey);
  if (earlier) return replay(earlier, fingerprint);
  if (!(await dependencies.store.allowRequest(dependencies.now()))) {
    return rateLimited();
  }

  const receivedAt = dependencies.now();
  // 파일 문제(없음·형식·GPS)는 inspect가 거절 결과로 돌려주고, 그 밖의 오류(S3 장애·권한)는
  // 그대로 던져 503으로 끝냄 — 조회 실패를 '잘못된 파일' 거절로 바꾸지 않음(사용자가 재시도)
  const inspected = await Promise.all(
    request.photos.map((photo) => dependencies.photos.inspect(photo)),
  );
  const inquiryId = dependencies.id();
  const message = request.message.trim();
  const email = request.email?.trim();
  const response: CreateInquiryResponse = {
    inquiryId,
    receivedAt: receivedAt.toISOString(),
    photos: inspected.map((photo) => photo.result) as CreateInquiryResponse["photos"],
  };

  const saved = await dependencies.store.save({
    inquiryId,
    type: request.type,
    message,
    ...(request.beachId ? { beachId: request.beachId } : {}),
    ...(request.activity ? { activity: request.activity } : {}),
    ...(email ? { email } : {}),
    photoKeys: inspected.flatMap((photo) =>
      photo.acceptedKey ? [photo.acceptedKey] : [],
    ),
    receivedAt,
    idempotencyKey: request.idempotencyKey,
    fingerprint,
    response,
  });
  if (saved === "duplicate") {
    // 같은 키의 다른 요청이 먼저 저장함 → 그 결과를 돌려주고 알림은 보내지 않음
    const winner = await dependencies.store.findReceipt(request.idempotencyKey);
    if (!winner) throw new Error("멱등 기록을 읽지 못함"); // 503 → 다시 보내면 첫 결과를 받음
    return replay(winner, fingerprint);
  }

  // 저장된 뒤의 알림 오류는 접수 실패(503)로 바꾸지 않음. 503이면 재시도가 첫 결과만 받아 알림이 영영 빠짐
  const notification = await dependencies.notifier
    .notify({
      inquiryId,
      type: request.type,
      message,
      ...(request.beachId ? { beachId: request.beachId } : {}),
      ...(request.activity ? { activity: request.activity } : {}),
      hasEmail: Boolean(email),
      receivedAt,
    })
    .catch(() => "failed" as const);
  if (notification !== "sent") {
    safeLog("warn", "inquiry_notification_skipped", { reason: notification });
  }
  safeLog("info", "inquiry_received", {
    acceptedPhotos: inspected.filter(
      (photo) => photo.result.status === "accepted",
    ).length,
    rejectedPhotos: inspected.filter(
      (photo) => photo.result.status === "rejected",
    ).length,
  });
  return jsonResponse(201, response);
}

export async function handleInquiryHttp(
  event: APIGatewayProxyEventV2,
  dependencies: InquiryDependencies,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (event.requestContext.http.method !== "POST") {
    return errorResponse(400, "invalid_request", "POST 요청만 받을 수 있습니다.");
  }

  const parsed = validRequestBody(event);
  if (!parsed) {
    return errorResponse(
      400,
      "invalid_request",
      "요청 본문과 필수 헤더를 확인해 주세요.",
    );
  }

  // 속도 제한은 모양 검사를 통과한 요청만 셈(문의는 멱등 기록을 먼저 봄)
  if (event.rawPath === "/api/inquiries/uploads") {
    if (!isInquiryUploadRequest(parsed.value)) {
      return errorResponse(400, "invalid_request", "사진 정보를 확인해 주세요.");
    }
    if (!(await dependencies.store.allowRequest(dependencies.now()))) {
      return rateLimited();
    }
    const body = {
      uploads: await dependencies.photos.createUploads(
        parsed.value.photos,
        dependencies.now(),
      ),
    };
    if (!isInquiryUploadResponse(body)) {
      throw new Error("업로드 양식이 계약과 다름"); // 503. 계약 밖 주소·칸을 내보내지 않음
    }
    return jsonResponse(200, body);
  }

  if (event.rawPath === "/api/inquiries") {
    if (!isCreateInquiryRequest(parsed.value)) {
      return errorResponse(400, "invalid_request", "문의 내용을 확인해 주세요.");
    }
    return createInquiry(parsed.value, dependencies);
  }

  return errorResponse(400, "invalid_request", "지원하지 않는 요청입니다.");
}

let cached: InquiryDependencies | undefined;

function setup(): InquiryDependencies {
  if (cached) return cached;
  const store = new InquiryStore(
    DynamoDBDocumentClient.from(new DynamoDBClient({})),
    requiredEnv("INQUIRY_TABLE_NAME"),
  );
  cached = {
    store,
    photos: new InquiryPhotos(new S3Client({}), requiredEnv("PHOTO_BUCKET_NAME")),
    notifier: new InquiryNotifier(
      new SNSClient({}),
      requiredEnv("INQUIRY_TOPIC_ARN"),
      store,
    ),
    now: () => new Date(),
    id: randomUUID,
  };
  return cached;
}

export async function inquiryHandler(
  event: unknown,
): Promise<APIGatewayProxyStructuredResultV2 | { status: "email_deleted" }> {
  const dependencies = setup();
  if (isDeleteEmailEvent(event)) {
    await dependencies.store.deleteEmail(event.inquiryId);
    safeLog("info", "inquiry_email_deleted");
    return { status: "email_deleted" };
  }
  if (!isHttpEvent(event)) {
    throw new Error("지원하지 않는 문의 이벤트");
  }

  try {
    return await handleInquiryHttp(event, dependencies);
  } catch {
    safeLog("error", "inquiry_internal_error");
    return errorResponse(
      503,
      "service_unavailable",
      "문의를 접수하지 못했습니다. 다시 시도해 주세요.",
    );
  }
}
