import { readFileSync } from "node:fs";

import type { BeachStatus, StatusFile } from "@baradun/contracts";
import { describe, expect, it } from "vitest";

import { diffBeachStatuses } from "./diff";
import type { ViewSource } from "./view";

const example = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../packages/contracts/examples/valid/status.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as StatusFile;

// 계약 예시 데이터 기준 시각(2026-10-17T05:30:00Z, 만료 전)
const NOW_MS = Date.parse("2026-10-17T05:30:00Z");

function makeSource(
  statuses: Record<string, unknown> | null,
  overrides: Partial<ViewSource> = {},
): ViewSource {
  return {
    phase: "ready",
    statuses,
    live: true,
    clock: { offsetMs: 0, trusted: true },
    nowMs: NOW_MS,
    ...overrides,
  };
}

function withStatus(
  id: string,
  change: (status: BeachStatus) => void,
): Record<string, unknown> {
  const original = example.beaches[id];
  if (!original) throw new Error(`예시에 없는 해변: ${id}`);
  const status = structuredClone(original);
  change(status);
  return { ...example.beaches, [id]: status };
}

const BEACHES = [
  { id: "b0001", hidden: false },
  { id: "b0094", hidden: false },
  { id: "b0272", hidden: true },
];

describe("diffBeachStatuses", () => {
  it("returns empty map when nothing changed", () => {
    const prev = makeSource(example.beaches);
    const next = makeSource(example.beaches);
    expect(diffBeachStatuses(BEACHES, prev, next).size).toBe(0);
  });

  it("detects category and badge change and returns previous badge label", () => {
    const prev = makeSource(example.beaches);
    const nextStatuses = withStatus("b0001", (s) => {
      s.category = "unavailable";
      s.reasons = [
        {
          code: "warning",
          type: "wind_wave",
          level: "advisory",
          scope: "남해동부앞바다",
          source: "기상청",
          at: "2026-10-21T05:00:00Z",
        },
      ];
    });
    const next = makeSource(nextStatuses);

    const diff = diffBeachStatuses(BEACHES, prev, next);
    expect(diff.size).toBe(1);
    expect(diff.get("b0001")).toEqual({ kind: "clear" });
  });

  it("detects badge change within same category (warning -> different warning)", () => {
    const prev = makeSource(example.beaches);
    const nextStatuses = withStatus("b0094", (s) => {
      s.reasons = [
        {
          code: "warning",
          type: "wind_wave",
          level: "warning",
          scope: "남해동부앞바다",
          source: "기상청",
          at: "2026-10-21T05:00:00Z",
        },
      ];
    });
    const next = makeSource(nextStatuses);

    const diff = diffBeachStatuses(BEACHES, prev, next);
    expect(diff.get("b0094")).toEqual({
      kind: "warning",
      type: "wind_wave",
      level: "advisory",
    });
  });

  it("detects live -> B5 stale degradation on clear beach", () => {
    const prev = makeSource(example.beaches);
    const next = makeSource(example.beaches, { live: false });

    const diff = diffBeachStatuses(BEACHES, prev, next);
    expect(diff.get("b0001")).toEqual({ kind: "clear" });
  });

  it("ignores hidden beaches and non-ready phases", () => {
    const prev = makeSource(example.beaches);
    const nextStatuses = withStatus("b0272", (s) => {
      s.category = "clear";
      s.reasons = [];
    });
    const next = makeSource(nextStatuses);
    expect(diffBeachStatuses(BEACHES, prev, next).size).toBe(0);
    expect(
      diffBeachStatuses(BEACHES, makeSource(null, { phase: "loading" }), next)
        .size,
    ).toBe(0);
  });
});
