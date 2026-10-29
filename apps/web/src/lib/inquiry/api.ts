import type {
  CreateInquiryRequest,
  CreateInquiryResponse,
  InquiryPhotoReference,
  InquiryUploadResponse,
} from "@baradun/contracts";

// 데이터 문의 보내기 (BRD-37 · BRD-103 · infra/README '데이터 문의 접수(BRD-63)')
// 1) 사진이 있으면 POST /api/inquiries/uploads → presigned POST 양식(호스트·경로·메서드·만료·칸 검사) → 사진마다 multipart POST
// 2) POST /api/inquiries (본문 SHA-256을 x-amz-content-sha256에. 해시한 바로 그 문자열을 보냄)
// 문의 한 건에 멱등 키(UUID) 하나. 같은 내용으로 다시 보내면 같은 키·같은 사진 참조를 씀(서버가 첫 결과를 돌려줌)
// 응답은 계약 모양을 확인하고, 모양이 틀리면 접수되지 않은 것으로 봄(성공으로 보이지 않게)
// 사용자 위치·기기 정보는 보내지 않음. 이메일은 사용자가 쓴 경우만 본문에

export const INQUIRY_URL = "/api/inquiries";
export const UPLOAD_URL = "/api/inquiries/uploads";
export const REQUEST_TIMEOUT_MS = 20_000; // 요청 하나의 최대 대기
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024; // 파일당 5MiB(계약 InquiryUploadPhoto.size)

// 사진 업로드 대상: 서울 리전 문의 사진 버킷 하나만 허용(결정 26). 버킷 이름은 빌드 때 넣음
// (deploy.yml vars.INQUIRY_PHOTO_BUCKET ← 스택 출력 InquiryPhotoBucketName). 비어 있으면 어떤 업로드 주소도 받지 않음
export const PHOTO_BUCKET = process.env.NEXT_PUBLIC_INQUIRY_PHOTO_BUCKET ?? "";
const PHOTO_REGION = "ap-northeast-2"; // 스택 리전(infra/bin/infra.ts)
export const UPLOAD_EXPIRES_MS = 10 * 60_000; // 서버 양식 유효 시간(services INQUIRY_UPLOAD_EXPIRES_SECONDS)
export const CLOCK_SKEW_MS = 5 * 60_000; // 기기 시계가 늦을 때 허용하는 차이. 이보다 먼 만료는 정책과 다른 양식으로 봄

export type PhotoToSend = {
  blob: Blob;
  contentType: (typeof PHOTO_TYPES)[number];
};

// 실패 이유. 화면 문구를 고르는 데만 씀
export type SendFailure =
  | "offline" // 브라우저가 연결 없음으로 봄
  | "network" // 응답 없음·시간 초과
  | "rateLimited" // 잠시 많은 문의(429·rate_limited)
  | "unavailable" // 서버가 받을 수 없음(5xx·service_unavailable)
  | "rejected" // 요청 형식 거부(400·invalid_request)
  | "invalidResponse"; // 응답 모양이 계약과 다름

export type SendResult =
  | { ok: true; response: CreateInquiryResponse }
  | { ok: false; failure: SendFailure };

export type Progress =
  { phase: "photos"; done: number; total: number } | { phase: "message" };

export interface SendDeps {
  fetch: typeof fetch;
  digest: (data: string | ArrayBuffer) => Promise<string>; // 소문자 16진수 SHA-256
  online: () => boolean;
  now: () => number; // 양식 만료 비교용(epoch ms, 시간대와 무관)
  uuid: () => string; // 멱등 키(UUID v4)
  photoBucket: string; // 허용하는 업로드 버킷 이름
}

// 문의 한 건의 보내기 시도. 화면 메모리에만 둠(기기 저장 안 함). 이메일 원문은 넣지 않고 내용 지문만 둠
export type InquiryAttempt = {
  readonly idempotencyKey: string;
  readonly fingerprint: string; // 유형·본문·이메일·사진 내용의 SHA-256
  readonly refs: readonly InquiryPhotoReference[] | null; // 사진을 모두 올린 뒤의 참조. 다시 보낼 때 다시 올리지 않음
};
export type AttemptSlot = { current: InquiryAttempt | null }; // React useRef를 그대로 넘김

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    typeof data === "string" ? new TextEncoder().encode(data) : data,
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

const DEFAULT_DEPS: () => SendDeps = () => ({
  fetch: (...args) => fetch(...args),
  digest: sha256Hex,
  online: () => navigator.onLine,
  now: () => Date.now(),
  uuid: () => crypto.randomUUID(),
  photoBucket: PHOTO_BUCKET,
});

// ── 응답 모양 확인(계약 스키마의 필수 칸·패턴) ──
const PHOTO_ID = /^[0-9a-f]{16}$/;
const PHOTO_KEY = /^pending\/[0-9a-f]{32}\/[0-9a-f]{16}$/;
const INQUIRY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ── 업로드 양식 확인(결정 26) ──
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const REQUIRED_FIELDS = [
  "key",
  "bucket",
  "Content-Type",
  "Policy",
  "X-Amz-Algorithm",
  "X-Amz-Credential",
  "X-Amz-Date",
  "X-Amz-Signature",
] as const;
const ALLOWED_FIELDS = new Set<string>([
  ...REQUIRED_FIELDS,
  "X-Amz-Security-Token",
]);

// 허용 주소: 버킷 가상 호스트의 / 하나(https). 버킷 이름이 비었거나 형식이 틀리면 null(아무 주소도 허용 안 함)
export function uploadUrlFor(bucket: string): string | null {
  return BUCKET_NAME.test(bucket)
    ? `https://${bucket}.s3.${PHOTO_REGION}.amazonaws.com/`
    : null;
}

// 지금보다 뒤이고, 10분 정책 + 시계 차이보다 멀지 않은 만료인지
function expiresInWindow(value: unknown, now: number): boolean {
  if (typeof value !== "string" || !DATE_TIME.test(value)) return false;
  const at = Date.parse(value);
  return (
    Number.isFinite(at) && at > now && at <= now + UPLOAD_EXPIRES_MS + CLOCK_SKEW_MS
  );
}

// S3가 실제로 강제하는 정책(base64 JSON). 읽을 수 없으면 null
function decodePolicy(
  encoded: string,
): { expiration: unknown; conditions: unknown[] } | null {
  try {
    const value: unknown = JSON.parse(atob(encoded));
    return isObject(value) && Array.isArray(value.conditions)
      ? { expiration: value.expiration, conditions: value.conditions }
      : null;
  } catch {
    return null;
  }
}

// 정책에 이 칸의 값이 정확히 걸려 있는지({칸: 값} 또는 ["eq", "$칸", 값])
const hasCondition = (conditions: unknown[], name: string, value: string) =>
  conditions.some(
    (condition) =>
      (isObject(condition) && condition[name] === value) ||
      (Array.isArray(condition) &&
        condition.length === 3 &&
        condition[0] === "eq" &&
        condition[1] === `$${name}` &&
        condition[2] === value),
  );

// 양식 하나: 호스트·경로(정확한 주소)·메서드(POST)·만료(양식·정책 모두)·칸(정해진 칸만)·키(pending/)·콘텐츠 타입(이 사진과 같음)
export function isUploadTarget(
  item: unknown,
  photo: { contentType: string },
  now: number,
  bucket: string,
): boolean {
  const url = uploadUrlFor(bucket);
  if (url === null || !isObject(item) || !isObject(item.fields)) return false;
  const fields = item.fields;
  if (
    typeof item.photoId !== "string" ||
    !PHOTO_ID.test(item.photoId) ||
    typeof item.key !== "string" ||
    !PHOTO_KEY.test(item.key) ||
    item.method !== "POST" ||
    item.url !== url ||
    !expiresInWindow(item.expiresAt, now)
  )
    return false;
  if (
    !Object.entries(fields).every(
      ([name, value]) => ALLOWED_FIELDS.has(name) && typeof value === "string",
    ) ||
    !REQUIRED_FIELDS.every((name) => typeof fields[name] === "string")
  )
    return false;
  if (
    fields.key !== item.key ||
    fields.bucket !== bucket ||
    fields["Content-Type"] !== photo.contentType ||
    !(PHOTO_TYPES as readonly string[]).includes(photo.contentType) ||
    fields["X-Amz-Algorithm"] !== "AWS4-HMAC-SHA256"
  )
    return false;
  const policy = decodePolicy(fields.Policy as string);
  return (
    policy !== null &&
    expiresInWindow(policy.expiration, now) &&
    hasCondition(policy.conditions, "bucket", bucket) &&
    hasCondition(policy.conditions, "key", item.key) &&
    hasCondition(policy.conditions, "Content-Type", photo.contentType)
  );
}

// 양식 묶음: 보낸 사진마다 하나씩, 모두 통과해야 함(하나라도 틀리면 사진을 하나도 올리지 않음). 키가 겹치면 거부
export function isUploadResponse(
  value: unknown,
  photos: readonly { contentType: string }[],
  now: number,
  bucket: string,
): value is InquiryUploadResponse {
  if (!isObject(value) || !Array.isArray(value.uploads)) return false;
  // 요청한 장수만큼 와야 함(덜 오면 사진이 조용히 빠짐)
  if (value.uploads.length !== photos.length) return false;
  const keys = new Set(
    value.uploads.map((item: unknown) => (isObject(item) ? item.key : null)),
  );
  if (keys.size !== photos.length) return false;
  return value.uploads.every((item: unknown, index) =>
    isUploadTarget(item, photos[index]!, now, bucket),
  );
}

export function isCreateResponse(
  value: unknown,
  sent: readonly InquiryPhotoReference[],
): value is CreateInquiryResponse {
  if (!isObject(value)) return false;
  if (typeof value.inquiryId !== "string" || !INQUIRY_ID.test(value.inquiryId))
    return false;
  if (typeof value.receivedAt !== "string" || !DATE_TIME.test(value.receivedAt))
    return false;
  // 보낸 사진마다 결과가 하나씩 와야 함(빠지거나 겹치면 사진이 말없이 개수에서 빠짐)
  if (!Array.isArray(value.photos) || value.photos.length !== sent.length)
    return false;
  const pending = new Set(sent.map((photo) => photo.photoId));
  return value.photos.every(
    (item: unknown) =>
      isObject(item) &&
      typeof item.photoId === "string" &&
      pending.delete(item.photoId) &&
      (item.status === "accepted" ||
        (item.status === "rejected" &&
          (item.reason === "location_metadata" ||
            item.reason === "invalid_file" ||
            item.reason === "not_found"))),
  );
}

// 오류 응답 → 실패 이유. 본문이 계약 모양이 아니어도 상태 코드로 나눔
function failureOf(status: number, body: unknown): SendFailure {
  const code =
    isObject(body) && isObject(body.error) ? body.error.code : undefined;
  if (status === 429 || code === "rate_limited") return "rateLimited";
  if (code === "service_unavailable" || status >= 500) return "unavailable";
  // 409 idempotency_conflict: 같은 키로 다른 내용(웹은 내용이 바뀌면 새 키를 써서 생기지 않아야 함)
  if (
    status === 400 ||
    status === 409 ||
    code === "invalid_request" ||
    code === "idempotency_conflict"
  )
    return "rejected";
  return "unavailable";
}

// 시간 제한이 있는 요청. 응답 헤더만이 아니라 본문 읽기(readBody)까지 같은 제한 안에서 끝내야 함
// (본문이 멈추면 'sending'에서 영원히 멈추지 않게). 응답이 없거나 끊기거나 시간이 넘으면 "network".
// fetch가 abort를 무시해도 race로 반드시 끝남
async function timedFetch<T>(
  deps: SendDeps,
  url: string,
  init: RequestInit,
  readBody: (response: Response) => Promise<T>,
): Promise<{ response: Response; body: T } | "network"> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"network">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("network");
    }, REQUEST_TIMEOUT_MS);
  });
  const request = (async () => {
    const response = await deps.fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return { response, body: await readBody(response) };
  })().catch(() => "network" as const);
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// 본문이 JSON이 아니면 undefined(오류 응답은 상태 코드로 나눔). 끊기면 timedFetch가 "network"로 봄
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function postJson(
  deps: SendDeps,
  url: string,
  payload: unknown,
): Promise<{ ok: true; body: unknown } | { ok: false; failure: SendFailure }> {
  const body = JSON.stringify(payload);
  const hash = await deps.digest(body);
  const result = await timedFetch(
    deps,
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amz-content-sha256": hash,
      },
      body,
      credentials: "omit",
    },
    readJson,
  );
  if (result === "network") return { ok: false, failure: "network" };
  const { response, body: json } = result;
  if (!response.ok)
    return { ok: false, failure: failureOf(response.status, json) };
  return { ok: true, body: json };
}

// 사진 올리기: 양식 받기 → 사진마다 multipart POST. 하나라도 실패하면 문의 전체를 보내지 않음(사진이 조용히 빠지지 않게)
async function uploadPhotos(
  deps: SendDeps,
  photos: readonly PhotoToSend[],
  onProgress: (progress: Progress) => void,
): Promise<
  | { ok: true; refs: InquiryPhotoReference[] }
  | { ok: false; failure: SendFailure }
> {
  if (photos.length === 0) return { ok: true, refs: [] };
  const form = await postJson(deps, UPLOAD_URL, {
    photos: photos.map((photo) => ({
      contentType: photo.contentType,
      size: photo.blob.size,
    })),
  });
  if (!form.ok) return form;
  if (!isUploadResponse(form.body, photos, deps.now(), deps.photoBucket))
    return { ok: false, failure: "invalidResponse" };
  const refs: InquiryPhotoReference[] = [];
  onProgress({ phase: "photos", done: 0, total: photos.length });
  for (const [index, target] of form.body.uploads.entries()) {
    // 앞 사진을 올리는 사이(화면 전환 등) 만료됐으면 올리지 않음
    if (Date.parse(target.expiresAt) <= deps.now())
      return { ok: false, failure: "invalidResponse" };
    const data = new FormData();
    for (const [name, value] of Object.entries(target.fields))
      data.append(name, value);
    data.append("file", photos[index]!.blob); // 파일은 맨 마지막(S3 POST 규칙)
    // S3 응답 본문은 읽지 않음(상태 코드만 봄)
    const result = await timedFetch(
      deps,
      target.url,
      { method: "POST", body: data, credentials: "omit" },
      async () => undefined,
    );
    if (result === "network") return { ok: false, failure: "network" };
    if (!result.response.ok)
      return {
        ok: false,
        failure: failureOf(result.response.status, undefined),
      };
    refs.push({ photoId: target.photoId, key: target.key });
    onProgress({ phase: "photos", done: index + 1, total: photos.length });
  }
  return { ok: true, refs };
}

// 보낼 내용의 지문: 유형·본문·이메일·해변·활동·사진(형식·내용 SHA-256). 같으면 같은 시도로 봄
async function contentFingerprint(
  deps: SendDeps,
  request: InquiryContent,
  photos: readonly PhotoToSend[],
): Promise<string> {
  const photoDigests = await Promise.all(
    photos.map(async (photo) => [
      photo.contentType,
      await deps.digest(await photo.blob.arrayBuffer()),
    ]),
  );
  return deps.digest(
    JSON.stringify([
      request.type,
      request.message,
      request.email ?? null,
      request.beachId ?? null,
      request.activity ?? null,
      photoDigests,
    ]),
  );
}

export type InquiryContent = Omit<CreateInquiryRequest, "photos" | "idempotencyKey">;

// 문의 보내기. request는 form.ts buildRequest 결과
// attempt: 지난 시도와 내용이 같으면 그 멱등 키·사진 참조를 다시 씀. 내용이 바뀌면 새 키. 접수되면 비움
export async function sendInquiry(
  request: InquiryContent,
  photos: readonly PhotoToSend[],
  onProgress: (progress: Progress) => void = () => {},
  deps: SendDeps = DEFAULT_DEPS(),
  attempt: AttemptSlot = { current: null },
): Promise<SendResult> {
  if (!deps.online()) return { ok: false, failure: "offline" };
  const fingerprint = await contentFingerprint(deps, request, photos);
  const current: InquiryAttempt =
    attempt.current?.fingerprint === fingerprint
      ? attempt.current
      : { idempotencyKey: deps.uuid(), fingerprint, refs: null };
  attempt.current = current;
  let refs = current.refs;
  if (refs === null) {
    const uploaded = await uploadPhotos(deps, photos, onProgress);
    if (!uploaded.ok) return uploaded;
    refs = uploaded.refs;
    attempt.current = { ...current, refs };
  }
  onProgress({ phase: "message" });
  const sent = await postJson(deps, INQUIRY_URL, {
    ...request,
    idempotencyKey: current.idempotencyKey,
    photos: refs,
  });
  if (!sent.ok) {
    // 거부(400·409)는 서버가 아무것도 만들지 않은 것 → 다음 시도는 새 키
    if (sent.failure === "rejected") attempt.current = null;
    return sent;
  }
  if (!isCreateResponse(sent.body, refs))
    return { ok: false, failure: "invalidResponse" };
  attempt.current = null; // 접수됨 → 다음 문의는 새 키
  return { ok: true, response: sent.body };
}
