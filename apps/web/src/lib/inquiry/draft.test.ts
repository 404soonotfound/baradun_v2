import { describe, expect, it } from "vitest";

import {
  createDraftStore,
  DRAFT_STORAGE_KEY,
  DRAFT_TTL_MS,
  parseDraft,
  type DraftStorage,
} from "./draft";

// 문의 임시 저장 (BRD-37): 유형·내용만 7일, 형식이 틀리면 바로 지움

const NOW = Date.parse("2026-10-28T03:00:00.000Z");
const raw = (value: unknown) => JSON.stringify(value);
const good = {
  kind: "mismatch",
  message: "파고가 달라요",
  savedAt: "2026-10-28T02:00:00.000Z",
};

function memory(initial: string | null = null, throws = false) {
  let value = initial;
  const storage: DraftStorage = {
    getItem: () => {
      if (throws) throw new Error("blocked");
      return value;
    },
    setItem: (_key, next) => {
      if (throws) throw new Error("blocked");
      value = next;
    },
    removeItem: () => {
      if (throws) throw new Error("blocked");
      value = null;
    },
  };
  return { storage, get: () => value };
}

describe("parseDraft", () => {
  it("유형·내용·저장 시각이 맞으면 읽음", () => {
    expect(parseDraft(raw(good), NOW)).toEqual(good);
    expect(parseDraft(raw({ ...good, kind: null }), NOW)?.kind).toBeNull();
  });

  it("이메일 등 모르는 칸·모르는 유형·깨진 글자는 믿지 않음", () => {
    expect(parseDraft(raw({ ...good, email: "a@b.co" }), NOW)).toBeNull();
    expect(parseDraft(raw({ ...good, consent: true }), NOW)).toBeNull();
    expect(parseDraft(raw({ ...good, kind: "data_error" }), NOW)).toBeNull();
    expect(parseDraft("{", NOW)).toBeNull();
    expect(parseDraft(raw([good]), NOW)).toBeNull();
    expect(parseDraft(raw({ ...good, message: 3 }), NOW)).toBeNull();
  });

  it("7일 지남·2분 넘는 미래·형식이 틀린 시각은 null", () => {
    expect(
      parseDraft(
        raw({
          ...good,
          savedAt: new Date(NOW - DRAFT_TTL_MS - 1).toISOString(),
        }),
        NOW,
      ),
    ).toBeNull();
    expect(
      parseDraft(
        raw({ ...good, savedAt: new Date(NOW + 3 * 60_000).toISOString() }),
        NOW,
      ),
    ).toBeNull();
    expect(
      parseDraft(raw({ ...good, savedAt: "2026-10-28 02:00" }), NOW),
    ).toBeNull();
  });
});

describe("createDraftStore", () => {
  it("저장값 형식이 틀리면 읽을 때 바로 지움", () => {
    const mem = memory(raw({ ...good, email: "a@b.co" }));
    const store = createDraftStore(
      () => mem.storage,
      () => NOW,
    );
    expect(store.read()).toBeNull();
    expect(mem.get()).toBeNull();
  });

  it("유형·내용만 저장하고, 둘 다 비면 지움", () => {
    const mem = memory();
    const store = createDraftStore(
      () => mem.storage,
      () => NOW,
    );
    store.save("criteria", "기준이 궁금해요");
    expect(JSON.parse(mem.get()!)).toEqual({
      kind: "criteria",
      message: "기준이 궁금해요",
      savedAt: "2026-10-28T03:00:00.000Z",
    });
    store.save(null, "   ");
    expect(mem.get()).toBeNull();
  });

  it("7일이 지나면 같은 글자여도 지움", () => {
    let now = NOW;
    const mem = memory();
    const store = createDraftStore(
      () => mem.storage,
      () => now,
    );
    store.save("mismatch", "파고가 달라요");
    expect(store.read()?.message).toBe("파고가 달라요");
    now += DRAFT_TTL_MS + 1;
    expect(store.read()).toBeNull();
    expect(mem.get()).toBeNull();
  });

  it("저장소를 못 쓰면 이번 방문 동안 메모리 값, 지우기도 메모리에서", () => {
    const mem = memory(null, true);
    const store = createDraftStore(
      () => mem.storage,
      () => NOW,
    );
    store.save("newData", "새 자료 제안");
    expect(store.read()?.kind).toBe("newData");
    store.clear();
    expect(store.read()).toBeNull();
  });

  it("저장소를 꺼낼 수조차 없으면(null) 메모리 값으로 입력을 이어감", () => {
    const store = createDraftStore(
      () => null,
      () => NOW,
    );
    expect(store.read()).toBeNull();
    store.save("mismatch", "파");
    expect(store.read()).toMatchObject({ kind: "mismatch", message: "파" });
    store.save("mismatch", "파고");
    expect(store.read()?.message).toBe("파고");
    store.clear();
    expect(store.read()).toBeNull();
  });

  it("키 이름은 기기 데이터 초기화와 같은 저장소 키", () => {
    expect(DRAFT_STORAGE_KEY).toBe("baradun:inquiry-draft");
  });
});
