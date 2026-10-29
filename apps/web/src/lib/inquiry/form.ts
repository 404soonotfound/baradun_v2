import type {
  Activity,
  BeachId,
  CreateInquiryRequest,
  InquiryType,
} from "@baradun/contracts";

// 데이터 문의 입력 규칙 (BRD-37 · 화면 설계서 2장 INQ, infra/README '데이터 문의 접수')
// 화면 유형 칩 4개 ↔ 계약 유형 4개 1:1(결정 기록 12장 결정 21)
// 해변·활동은 본문 머리 줄이 아니라 계약 칸(beachId·activity)으로 보냄(결정 22)
// 순수 함수만 둠(브라우저 API 없음)

export const INQUIRY_KINDS = [
  "mismatch", // 정보가 실제와 달라요
  "addBeach", // 해변을 추가해 주세요
  "criteria", // 판단 기준이 궁금해요
  "newData", // 새 데이터를 제안해요
] as const;
export type InquiryKind = (typeof INQUIRY_KINDS)[number];

export const KIND_TO_TYPE: Record<InquiryKind, InquiryType> = {
  mismatch: "data_error",
  addBeach: "beach_request",
  criteria: "data_question",
  newData: "data_suggestion",
};

export const MESSAGE_MIN = 5; // 화면 설계서 INQ '내용(5자 이상)'
export const MESSAGE_INPUT_MAX = 2000; // 계약 CreateInquiryRequest.message maxLength
export const EMAIL_MAX = 254; // 계약 email maxLength
export const PHOTO_MAX_COUNT = 3; // 사진만 최대 3장

export type FieldError =
  "kindMissing" | "messageShort" | "emailFormat" | "consentMissing";

export type FormErrors = Partial<
  Record<"kind" | "message" | "email" | "consent", FieldError>
>;

// 이메일 형식: 화면에서 흔한 실수만 막음(최종 확인은 서버 계약 format: email)
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function validateForm(input: {
  kind: InquiryKind | null;
  message: string;
  email: string;
  consent: boolean;
}): FormErrors {
  const errors: FormErrors = {};
  if (input.kind === null) errors.kind = "kindMissing";
  if (input.message.trim().length < MESSAGE_MIN)
    errors.message = "messageShort";
  const email = input.email.trim();
  if (email !== "") {
    if (email.length > EMAIL_MAX || !EMAIL_PATTERN.test(email))
      errors.email = "emailFormat";
    if (!input.consent) errors.consent = "consentMissing";
  }
  return errors;
}

// 첫 오류 칸(포커스 이동용). 화면 순서와 같음
export function firstErrorField(errors: FormErrors): keyof FormErrors | null {
  for (const key of ["kind", "message", "email", "consent"] as const) {
    if (errors[key]) return key;
  }
  return null;
}

// 접수 요청(멱등 키·사진 참조는 api.ts가 붙임). 해변은 상세에서 들어온 경우만, 활동은 해변과 함께이고 그 해변이 지원할 때만 보냄
// 사용자 위치는 넣지 않음
export function buildRequest(input: {
  kind: InquiryKind;
  message: string;
  email: string;
  context: { beachId: BeachId; activity?: Activity } | null;
}): Omit<CreateInquiryRequest, "idempotencyKey" | "photos"> {
  const email = input.email.trim();
  return {
    type: KIND_TO_TYPE[input.kind],
    message: input.message.trim(),
    ...(email === "" ? {} : { email }),
    ...(input.context ?? {}),
  };
}
