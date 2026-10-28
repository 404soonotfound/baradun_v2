import type {
  CreateInquiryRequest,
  CreateInquiryResponse,
  InquiryPhotoReference,
  InquiryUploadResponse,
} from "@baradun/contracts";

// 데이터 문의 보내기 (BRD-37 · infra/README '데이터 문의 접수(BRD-63)')
// 1) 사진이 있으면 POST /api/inquiries/uploads → presigned POST 양식 → 사진마다 multipart POST
// 2) POST /api/inquiries (본문 SHA-256을 x-amz-content-sha256에. 해시한 바로 그 문자열을 보냄)
// 응답은 계약 모양을 확인하고, 모양이 틀리면 접수되지 않은 것으로 봄(성공으로 보이지 않게)
// 사용자 위치·기기 정보는 보내지 않음. 이메일은 사용자가 쓴 경우만 본문에

export const INQUIRY_URL = "/api/inquiries";
export const UPLOAD_URL = "/api/inquiries/uploads";
export const REQUEST_TIMEOUT_MS = 20_000; // 요청 하나의 최대 대기
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024; // 파일당 5MiB(계약 InquiryUploadPhoto.size)

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
  digest: (text: string) => Promise<string>; // 소문자 16진수 SHA-256
  online: () => boolean;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

const DEFAULT_DEPS: () => SendDeps = () => ({
  fetch: (...args) => fetch(...args),
  digest: sha256Hex,
  online: () => navigator.onLine,
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

export function isUploadResponse(
  value: unknown,
  count: number,
): value is InquiryUploadResponse {
  if (!isObject(value) || !Array.isArray(value.uploads)) return false;
  // 요청한 장수만큼 와야 함(덜 오면 사진이 조용히 빠짐)
  if (value.uploads.length !== count) return false;
  return value.uploads.every(
    (item: unknown) =>
      isObject(item) &&
      typeof item.photoId === "string" &&
      PHOTO_ID.test(item.photoId) &&
      typeof item.key === "string" &&
      PHOTO_KEY.test(item.key) &&
      typeof item.url === "string" &&
      item.url.startsWith("https://") &&
      isObject(item.fields) &&
      Object.values(item.fields).every((field) => typeof field === "string") &&
      typeof item.expiresAt === "string" &&
      DATE_TIME.test(item.expiresAt),
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
  if (status === 400 || code === "invalid_request") return "rejected";
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
  if (!isUploadResponse(form.body, photos.length))
    return { ok: false, failure: "invalidResponse" };
  const refs: InquiryPhotoReference[] = [];
  onProgress({ phase: "photos", done: 0, total: photos.length });
  for (const [index, target] of form.body.uploads.entries()) {
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

// 문의 보내기. message는 머리 줄을 붙인 본문(form.ts composeMessage)
export async function sendInquiry(
  request: Omit<CreateInquiryRequest, "photos">,
  photos: readonly PhotoToSend[],
  onProgress: (progress: Progress) => void = () => {},
  deps: SendDeps = DEFAULT_DEPS(),
): Promise<SendResult> {
  if (!deps.online()) return { ok: false, failure: "offline" };
  const uploaded = await uploadPhotos(deps, photos, onProgress);
  if (!uploaded.ok) return uploaded;
  onProgress({ phase: "message" });
  const sent = await postJson(deps, INQUIRY_URL, {
    ...request,
    photos: uploaded.refs,
  });
  if (!sent.ok) return sent;
  if (!isCreateResponse(sent.body, uploaded.refs))
    return { ok: false, failure: "invalidResponse" };
  return { ok: true, response: sent.body };
}
