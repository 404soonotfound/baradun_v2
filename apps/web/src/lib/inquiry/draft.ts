import { useSyncExternalStore } from "react";

import { INQUIRY_KINDS, MESSAGE_INPUT_MAX, type InquiryKind } from "./form";

// 데이터 문의 작성 중 임시 저장 (BRD-37 · 결정 기록 11장 '문의(BRD-37)', 화면 설계서 2장 INQ)
// 유형·내용만 이 기기에 최대 7일. 이메일·동의 상태·사진·기기 정보·해변·활동은 저장하지 않음
// 지우는 때: 접수 성공 · '지우기' · 기기 데이터 초기화 · 저장값 형식이 틀림(읽을 때 바로 지움) · 7일 지남
// 저장 틀은 lib/region.ts와 같음(못 쓰면 이번 방문 동안 메모리)

export type InquiryDraft = {
  kind: InquiryKind | null; // 고른 유형(화면 칩). 안 골랐으면 null
  message: string;
  savedAt: string; // 저장한 시각(ISO, UTC)
};

export const DRAFT_STORAGE_KEY = "baradun:inquiry-draft";
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60_000;
// 기기 시계가 조금 앞서 저장된 값까지만 믿음(2분 넘는 미래 시각은 형식 오류로 봄, 점검표 3)
const FUTURE_TOLERANCE_MS = 2 * 60_000;
const SAVED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// [1] 저장 글자 → 임시 저장. 모양이 다르거나 7일이 지났거나 미래 시각이면 null(= 지울 대상)
export function parseDraft(
  raw: string | null,
  nowMs: number,
): InquiryDraft | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return null;
    const { kind, message, savedAt, ...rest } = value as Record<
      string,
      unknown
    >;
    // 모르는 칸이 있으면(예: 예전 버전이 이메일을 넣었던 값) 믿지 않고 지움
    if (Object.keys(rest).length > 0) return null;
    if (kind !== null && !(INQUIRY_KINDS as readonly unknown[]).includes(kind))
      return null;
    if (typeof message !== "string" || message.length > MESSAGE_INPUT_MAX)
      return null;
    if (typeof savedAt !== "string" || !SAVED_AT_PATTERN.test(savedAt))
      return null;
    const savedMs = Date.parse(savedAt);
    if (!Number.isFinite(savedMs)) return null;
    if (savedMs > nowMs + FUTURE_TOLERANCE_MS) return null;
    if (nowMs - savedMs > DRAFT_TTL_MS) return null;
    return { kind: kind as InquiryKind | null, message, savedAt };
  } catch {
    return null;
  }
}

// [2] 저장할 것이 있는지. 유형도 내용도 비었으면 저장하지 않고 지움
export function isEmptyDraft(kind: InquiryKind | null, message: string) {
  return kind === null && message.trim() === "";
}

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): DraftStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// [3] 저장소. 테스트에서 저장소·시계를 바꿔 끼움
export function createDraftStore(
  getStorage: () => DraftStorage | null = browserStorage,
  now: () => number = Date.now,
) {
  let memory: InquiryDraft | null = null;
  let writeFailed = false;
  let lastRaw: string | null = null;
  let lastValue: InquiryDraft | null = null;
  const listeners = new Set<() => void>();

  function notify() {
    listeners.forEach((listener) => listener());
  }

  function remove() {
    memory = null;
    try {
      getStorage()?.removeItem(DRAFT_STORAGE_KEY);
    } catch {
      writeFailed = true;
    }
  }

  // 읽을 때 형식이 틀리거나 기한이 지난 값은 바로 지움
  function read(): InquiryDraft | null {
    if (writeFailed) {
      if (memory && parseDraft(JSON.stringify(memory), now()) === null)
        memory = null;
      return memory;
    }
    let raw: string | null;
    try {
      raw = getStorage()?.getItem(DRAFT_STORAGE_KEY) ?? null;
    } catch {
      return memory;
    }
    if (raw !== lastRaw) {
      lastRaw = raw;
      lastValue = parseDraft(raw, now());
      if (raw !== null && lastValue === null) remove();
    } else if (lastValue && parseDraft(raw, now()) === null) {
      // 같은 글자라도 7일이 지나면 지움
      lastValue = null;
      remove();
    }
    return lastValue;
  }

  function save(kind: InquiryKind | null, message: string) {
    if (isEmptyDraft(kind, message)) {
      clear();
      return;
    }
    const next: InquiryDraft = {
      kind,
      message: message.slice(0, MESSAGE_INPUT_MAX),
      savedAt: new Date(now()).toISOString(),
    };
    memory = next;
    try {
      getStorage()?.setItem(DRAFT_STORAGE_KEY, JSON.stringify(next));
      writeFailed = false;
    } catch {
      writeFailed = true;
    }
    notify();
  }

  function clear() {
    remove();
    notify();
  }

  function subscribe(onChange: () => void) {
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }

  return { read, save, clear, subscribe };
}

// [4] 앱 전체에서 하나
const store = createDraftStore();

// 처음 화면을 그릴 때 한 번 읽어 입력칸을 채움(입력 중에는 화면 상태가 원본)
export const readInquiryDraft = store.read;
export const saveInquiryDraft = store.save;
// 접수 성공·지우기·기기 데이터 초기화(lib/device-reset.ts)
export const clearInquiryDraft = store.clear;

// 화면에서 임시 저장이 있는지 볼 때. 서버 HTML은 없음
export function useInquiryDraft(): InquiryDraft | null {
  return useSyncExternalStore(store.subscribe, store.read, () => null);
}
