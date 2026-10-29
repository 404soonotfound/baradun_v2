import { receiptUnknown, type SendFailure, type SendStop } from "./api";

// 문의 실패 안내 문구 고르기 (BRD-111 · 결정 기록 12장 결정 27)
// 무슨 일(제목·원인) → 영향(멈춘 단계·접수 여부) → 다음 행동 순서. 키는 messages의 inquiry.failed 아래
// 순수 함수만 둠(화면은 키·값을 번역만 함)

export type FailureCopy = {
  unknown: boolean; // 문의가 접수됐는지 모름
  title: "title" | "titleUnknown";
  cause: SendFailure | "rateLimitedRetry";
  impact:
    | { key: "stopPhotos"; values: { uploaded: number; total: number } }
    | { key: "stopMessageAfterPhotos"; values: { count: number } }
    | { key: "stopUnknown" | "stopMessage" };
  next:
    | "next.offline"
    | "next.rateLimited"
    | "next.rejected"
    | "next.later"
    | "next.unknown"
    | "next.unknownLater"
    | "next.unknownOffline";
};

export function failureCopy(result: {
  failure: SendFailure;
  stop: SendStop;
}): FailureCopy {
  const { failure, stop } = result;
  const unknown = receiptUnknown(result);
  return {
    unknown,
    title: unknown ? "titleUnknown" : "title",
    // 앞 시도의 접수 여부를 모르는 채 재시도가 429면 '이번 재시도'를 받지 못했다고 씀
    cause: unknown && failure === "rateLimited" ? "rateLimitedRetry" : failure,
    impact:
      stop.stage === "photos" && stop.uploaded > 0
        ? {
            key: "stopPhotos",
            values: { uploaded: stop.uploaded, total: stop.total },
          }
        : unknown
          ? { key: "stopUnknown" }
          : stop.stage === "message" && stop.photos > 0
            ? { key: "stopMessageAfterPhotos", values: { count: stop.photos } }
            : { key: "stopMessage" },
    next: unknown
      ? failure === "rateLimited"
        ? "next.unknownLater"
        : failure === "offline"
          ? "next.unknownOffline"
          : "next.unknown"
      : failure === "offline" ||
          failure === "rateLimited" ||
          failure === "rejected"
        ? `next.${failure}`
        : "next.later",
  };
}
