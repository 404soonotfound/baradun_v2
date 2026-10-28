import { readFileSync } from "node:fs";

import type { BeachStatus, StatusFile } from "@baradun/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  changeNote,
  createSeenStore,
  nextSeen,
  parseSeen,
  toSeen,
  warningFact,
  type SeenRecord,
} from "@/lib/favorite-changes";
import type { Clock } from "@/lib/snapshot/clock";
import { deriveBeachView, type ViewSource } from "@/lib/snapshot/view";

// 즐겨찾기 변경 표시 (BRD-35). 입력은 계약 예시 데이터
// 예시: b0001 특보 없음 · b0002 풍랑주의보 · b0003 관측 지연(특보는 없음 확인)
const example = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/contracts/examples/valid/status.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as StatusFile;

const TRUSTED: Clock = { offsetMs: 0, trusted: true };
const NOW = "2026-10-17T05:30:00Z";

function source(
  overrides: Partial<ViewSource> = {},
  statuses: Record<string, unknown> = example.beaches,
): ViewSource {
  return {
    phase: "ready",
    statuses,
    live: true,
    clock: TRUSTED,
    nowMs: Date.parse(NOW),
    ...overrides,
  };
}

function withStatus(id: string, change: (status: BeachStatus) => void) {
  const status = structuredClone(example.beaches[id]!);
  change(status);
  return { ...example.beaches, [id]: status };
}

function factOf(id: string, src: ViewSource) {
  return warningFact(id, deriveBeachView({ id, hidden: false }, src), src);
}

describe("warningFact", () => {
  it("특보 없음 확인 → none, 발효 → 종류·단계·발표 시각", () => {
    expect(factOf("b0001", source())).toEqual({ state: "none" });
    expect(factOf("b0002", source())).toEqual({
      state: "active",
      items: [
        {
          type: "wind_wave",
          level: "advisory",
          publishedAt: "2026-10-17T04:00:00Z",
        },
      ],
    });
  });

  it("관측 지연(판단불가)이어도 특보 없음이 확인됐으면 none", () => {
    expect(factOf("b0003", source())).toEqual({ state: "none" });
  });

  it("불러오는 중·오프라인(B5)·지원 밖 형식·데이터 없음은 확인 못 함(null)", () => {
    expect(factOf("b0002", source({ phase: "loading" }))).toBeNull();
    expect(factOf("b0002", source({ live: false }))).toBeNull();
    expect(factOf("b0001", source({ live: false }))).toBeNull();
    expect(factOf("b0002", source({ phase: "schema_unsupported" }))).toBeNull();
    expect(factOf("b9999", source())).toBeNull();
  });

  it("모르는 사유·읽을 수 없는 특보 항목이 있으면 확인 못 함", () => {
    const unknownReason = withStatus("b0002", (status) => {
      status.reasons.push({
        code: "control_closed" as never,
        scope: "x",
        source: "y",
        at: null,
      });
    });
    expect(factOf("b0002", source({}, unknownReason))).toBeNull();

    const badItem = withStatus("b0002", (status) => {
      (status.warning.items[0] as { level: string }).level = "extreme";
    });
    expect(factOf("b0002", source({}, badItem))).toBeNull();
  });

  it("특보 확인이 45분을 넘었으면 발효도 확인 못 함", () => {
    const old = withStatus("b0002", (status) => {
      status.warning.lastConfirmedAt = "2026-10-17T04:40:00Z";
    });
    expect(factOf("b0002", source({}, old))).toBeNull();
  });
});

describe("toSeen", () => {
  it("종류·단계만 남기고 중복 없이 정렬", () => {
    expect(toSeen(null)).toBeNull();
    expect(toSeen({ state: "none" })).toEqual({ state: "none" });
    expect(
      toSeen({
        state: "active",
        items: [
          { type: "strong_wind", level: "advisory", publishedAt: NOW },
          { type: "wind_wave", level: "advisory", publishedAt: NOW },
          { type: "wind_wave", level: "advisory", publishedAt: NOW },
        ],
      }),
    ).toEqual({
      state: "active",
      keys: ["strong_wind:advisory", "wind_wave:advisory"],
    });
  });
});

describe("changeNote", () => {
  const active = (
    ...items: ["wind_wave" | "strong_wind", "advisory" | "warning", string][]
  ) =>
    ({
      state: "active",
      items: items.map(([type, level, publishedAt]) => ({
        type,
        level,
        publishedAt,
      })),
    }) as const;

  it("지난 방문 기록이 없으면 표시 없음", () => {
    expect(changeNote(undefined, { state: "none" })).toBeNull();
    expect(changeNote(undefined, null)).toBeNull();
  });

  it("한쪽이라도 확인 못 했으면 '변경 판단 안 함'", () => {
    expect(changeNote(null, { state: "none" })).toEqual({ kind: "unknown" });
    expect(changeNote({ state: "none" }, null)).toEqual({ kind: "unknown" });
  });

  it("둘 다 확인됐고 새 특보가 생겼을 때만 발표 표시(가장 늦게 발표된 것)", () => {
    expect(
      changeNote(
        { state: "none" },
        active(
          ["wind_wave", "advisory", "2026-10-17T04:00:00Z"],
          ["strong_wind", "advisory", "2026-10-17T05:05:00Z"],
        ),
      ),
    ).toEqual({
      kind: "issued",
      type: "strong_wind",
      level: "advisory",
      publishedAt: "2026-10-17T05:05:00Z",
    });
  });

  it("같은 특보가 이어지거나 해제·없음 유지면 표시 없음", () => {
    const before: SeenRecord = {
      state: "active",
      keys: ["wind_wave:advisory"],
    };
    expect(
      changeNote(before, active(["wind_wave", "advisory", NOW])),
    ).toBeNull();
    expect(changeNote(before, { state: "none" })).toBeNull();
    expect(changeNote({ state: "none" }, { state: "none" })).toBeNull();
  });

  it("단계가 오르면(주의보 → 경보) 새 특보로 봄", () => {
    expect(
      changeNote(
        { state: "active", keys: ["wind_wave:advisory"] },
        active(["wind_wave", "warning", NOW]),
      ),
    ).toMatchObject({ kind: "issued", level: "warning" });
  });
});

describe("nextSeen", () => {
  it("즐겨찾기에 없는 해변은 지우고, 화면에 없는 해변(노출 끔)은 지난 기록 유지", () => {
    const stored = {
      a: { state: "none" },
      hiddenBeach: { state: "active", keys: ["wind_wave:advisory"] },
      removed: { state: "none" },
    } as const;
    const current = new Map<string, SeenRecord>([["a", null]]);
    expect(nextSeen(stored, ["a", "hiddenBeach", "new"], current)).toEqual({
      a: null,
      hiddenBeach: { state: "active", keys: ["wind_wave:advisory"] },
    });
  });
});

describe("parseSeen", () => {
  it("깨진 저장 값은 빈 기록, 모양이 다른 항목은 확인 못 함(null)으로", () => {
    expect(parseSeen(null)).toEqual({});
    expect(parseSeen("{ 깨짐")).toEqual({});
    expect(parseSeen("[1,2]")).toEqual({});
    expect(
      parseSeen(
        JSON.stringify({
          a: { state: "none" },
          b: { state: "active", keys: ["wind_wave:advisory"] },
          c: { state: "active", keys: ["wind_wave:extreme"] },
          d: { state: "active", keys: [] },
          e: 3,
          f: null,
          g: { state: "active", keys: ["wind_wave:advisory:x"] },
        }),
      ),
    ).toEqual({
      a: { state: "none" },
      b: { state: "active", keys: ["wind_wave:advisory"] },
      c: null,
      d: null,
      e: null,
      f: null,
      g: null,
    });
  });
});

describe("createSeenStore (기기 저장)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function memoryStorage({ failWrites = false } = {}) {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failWrites) throw new Error("QuotaExceeded");
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    };
  }

  const NONE = new Map<string, SeenRecord>([["a", { state: "none" }]]);

  it("구독할 때 지난 기록을 한 번 읽고, 그 전에는 기록하지 않음", () => {
    const storage = memoryStorage();
    storage.data.set("k", JSON.stringify({ a: null }));
    const store = createSeenStore("k", () => storage);
    store.record(["a"], NONE);
    expect(storage.data.get("k")).toBe(JSON.stringify({ a: null }));
    expect(store.getBaseline()).toBeNull();

    const onChange = vi.fn();
    store.subscribe(onChange);
    expect(onChange).toHaveBeenCalledOnce();
    expect(store.getBaseline()).toEqual({ a: null });
    store.record(["a"], NONE);
    expect(storage.data.get("k")).toBe(
      JSON.stringify({ a: { state: "none" } }),
    );
    // 머무는 동안 지난 기록은 그대로(방금 쓴 값과 비교하지 않음)
    expect(store.getBaseline()).toEqual({ a: null });
  });

  it("해제 뒤 바로 다시 구독(개발 모드)하면 다시 읽지 않고, 떠난 뒤 들어오면 다시 읽음", () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const store = createSeenStore("k", () => storage);
    const off = store.subscribe(() => {});
    store.record(["a"], NONE);
    off();
    const offAgain = store.subscribe(() => {});
    expect(store.getBaseline()).toEqual({});
    offAgain();
    vi.runAllTimers();
    expect(store.getBaseline()).toBeNull();
    store.subscribe(() => {});
    expect(store.getBaseline()).toEqual({ a: { state: "none" } });
  });

  it("쓰기가 막히면 이번 방문 동안 memory 값으로 이어감", () => {
    vi.useFakeTimers();
    const storage = memoryStorage({ failWrites: true });
    const store = createSeenStore("k", () => storage);
    store.subscribe(() => {})();
    store.record(["a"], NONE);
    vi.runAllTimers();
    store.subscribe(() => {});
    expect(store.getBaseline()).toEqual({ a: { state: "none" } });
  });

  it("저장소가 없거나 읽기가 오류를 내도 멈추지 않음", () => {
    const store = createSeenStore("k", () => null);
    store.subscribe(() => {});
    expect(store.getBaseline()).toEqual({});
    expect(() => store.record(["a"], NONE)).not.toThrow();
    expect(() => store.clear()).not.toThrow();

    const broken = createSeenStore("k", () => ({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    }));
    expect(() => broken.subscribe(() => {})).not.toThrow();
    expect(broken.getBaseline()).toEqual({});
  });

  it("초기화하면 저장 값과 보고 있는 지난 기록을 비우고 화면에 알림", () => {
    const storage = memoryStorage();
    storage.data.set("k", JSON.stringify({ a: { state: "none" } }));
    const store = createSeenStore("k", () => storage);
    const onChange = vi.fn();
    store.subscribe(onChange);
    store.clear();
    expect(storage.data.has("k")).toBe(false);
    expect(store.getBaseline()).toEqual({});
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
