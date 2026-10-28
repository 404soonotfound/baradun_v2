import type { CreateInquiryRequest, InquiryType } from "@baradun/contracts";

// 데이터 문의 입력 규칙 (BRD-37 · 화면 설계서 2장 INQ, infra/README '데이터 문의 접수')
// 화면 유형 칩 4개 → 계약 유형 3개(data_error·data_question·other). 칩 이름은 본문 첫 줄에도 넣어 운영자가 구분함
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
  addBeach: "other",
  criteria: "data_question",
  newData: "other",
};

export const MESSAGE_MIN = 5; // 화면 설계서 INQ '내용(5자 이상)'
export const MESSAGE_MAX = 2000; // 계약 CreateInquiryRequest.message maxLength(맨 앞 머리 줄 포함)
export const EMAIL_MAX = 254; // 계약 email maxLength
export const PHOTO_MAX_COUNT = 3; // 사진만 최대 3장
// 본문 앞에 붙이는 머리 줄(유형·해변·활동, 감싸는 글자 포함)의 최대 길이. 내용 입력 상한은 이만큼 뺌
export const HEADER_MAX = 120;
const HEADER_WRAP = "[]\n\n".length;
export const MESSAGE_INPUT_MAX = MESSAGE_MAX - HEADER_MAX;

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

// 접수 본문: 머리 줄(유형 · 해변 · 활동) + 빈 줄 + 사용자가 쓴 내용
// 해변·활동은 화면이 자동으로 넣은 맥락(상세에서 들어온 경우). 사용자 위치는 넣지 않음
export function composeMessage(input: {
  kindLabel: string;
  beachName: string | null;
  activityLabel: string | null;
  message: string;
}): string {
  // 감싸는 글자("[", "]", 빈 줄 두 개)까지 머리 줄 상한 안에 넣음 → 내용 입력 상한까지 쓴 글이 잘리지 않음
  const header = [input.kindLabel, input.beachName, input.activityLabel]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ")
    .slice(0, HEADER_MAX - HEADER_WRAP);
  return `[${header}]\n\n${input.message.trim()}`.slice(0, MESSAGE_MAX);
}

export function buildRequest(input: {
  kind: InquiryKind;
  message: string; // composeMessage 결과
  email: string;
  photos: CreateInquiryRequest["photos"];
}): CreateInquiryRequest {
  const email = input.email.trim();
  return {
    type: KIND_TO_TYPE[input.kind],
    message: input.message,
    ...(email === "" ? {} : { email }),
    photos: input.photos,
  };
}
