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
  InquiryPhotoReference,
  InquiryUploadResponse,
} from "@baradun/contracts";
import { createHash, randomUUID } from "node:crypto";
import { InquiryNotifier } from "./notification";
import { InquiryPhotos, type InspectedPhoto } from "./photos";
import { INQUIRY_MAX_BODY_BYTES } from "./policy";
import { InquiryStore } from "./store";
import {
  isCreateInquiryRequest,
  isInquiryUploadRequest,
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

async function inspectPhoto(
  photo: InquiryPhotoReference,
  dependencies: InquiryDependencies,
): Promise<InspectedPhoto> {
  try {
    return await dependencies.photos.inspect(photo);
  } catch {
    safeLog("warn", "inquiry_photo_inspection_failed");
    return {
      result: {
        photoId: photo.photoId,
        status: "rejected",
        reason: "invalid_file",
      },
    };
  }
}

async function createInquiry(
  request: CreateInquiryRequest,
  dependencies: InquiryDependencies,
): Promise<CreateInquiryResponse> {
  const receivedAt = dependencies.now();
  const inspected = await Promise.all(
    request.photos.map((photo) => inspectPhoto(photo, dependencies)),
  );
  const inquiryId = dependencies.id();
  const message = request.message.trim();
  const email = request.email?.trim();

  await dependencies.store.save({
    inquiryId,
    type: request.type,
    message,
    ...(email ? { email } : {}),
    photoKeys: inspected.flatMap((photo) =>
      photo.acceptedKey ? [photo.acceptedKey] : [],
    ),
    receivedAt,
  });

  const notification = await dependencies.notifier.notify({
    inquiryId,
    type: request.type,
    message,
    hasEmail: Boolean(email),
    receivedAt,
  });
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
  return {
    inquiryId,
    receivedAt: receivedAt.toISOString(),
    photos: inspected.map((photo) => photo.result) as CreateInquiryResponse["photos"],
  };
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
  if (!(await dependencies.store.allowRequest(dependencies.now()))) {
    return errorResponse(
      429,
      "rate_limited",
      "요청이 많습니다. 잠시 뒤 다시 시도해 주세요.",
    );
  }

  if (event.rawPath === "/api/inquiries/uploads") {
    if (!isInquiryUploadRequest(parsed.value)) {
      return errorResponse(400, "invalid_request", "사진 정보를 확인해 주세요.");
    }
    const uploads = await dependencies.photos.createUploads(
      parsed.value.photos,
      dependencies.now(),
    );
    return jsonResponse(200, {
      uploads: uploads as InquiryUploadResponse["uploads"],
    });
  }

  if (event.rawPath === "/api/inquiries") {
    if (!isCreateInquiryRequest(parsed.value)) {
      return errorResponse(400, "invalid_request", "문의 내용을 확인해 주세요.");
    }
    return jsonResponse(201, await createInquiry(parsed.value, dependencies));
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
