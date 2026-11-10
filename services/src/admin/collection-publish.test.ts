import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  PUBLISH_SUMMARY_PK,
  STATION_TABLE_KEY,
  type StationTable,
} from "../core/collect/publish-summary";
import type { Incident } from "./collection";
import {
  incidentImpact,
  readPublishSummaries,
  versionOf,
  type SummaryLite,
  type SummaryRead,
} from "./collection-publish";
import type { Sender } from "./writes";

// 수집 현황 · 게시 요약 (BRD-187). 해변 영향은 publisher가 게시한 '관측 지연' 사유만 씀
// 요약이 빠지거나 읽지 못하면 '확인 못 함'(영향 없음으로 바꾸지 않음)

const NOW_MS = Date.parse("2026-11-02T03:30:00Z");

const STATIONS: StationTable = {
  "22451": {
    name: "속초 파고부이",
    beachIds: ["b0001", "b0002"],
    waveBeachIds: ["b0001", "b0002"],
  },
  "22520": {
    name: "울진 해양기상부이",
    beachIds: ["b0003"],
    waveBeachIds: [],
  },
};

function lite(
  version: string,
  previous: string | null,
  delayedBeachIds: string[] = [],
): SummaryLite {
  return {
    version,
    previous,
    publishedAt: version,
    beachCount: 206,
    delayedBeachIds,
  };
}

function read(list: SummaryLite[], failed = false): SummaryRead {
  const latest = list.at(-1) ?? null;
  return {
    list,
    latest,
    stations: failed ? null : STATIONS,
    failed,
    live: (version) =>
      latest && latest.version === version
        ? {
            version: latest.version,
            publishedAt: latest.publishedAt,
            beachCount: latest.beachCount,
            delayedBeaches: latest.delayedBeachIds.length,
          }
        : null,
  };
}

// 02:10~03:00 관측소 22451이 빠짐(돌아온 03:00으로 장애가 끝남)
const INCIDENT: Incident = {
  startedAt: "2026-11-02T02:10:00.000Z",
  endedAt: "2026-11-02T03:00:00.000Z",
  runs: 2,
  failures: [],
  stations: [
    {
      id: "22451",
      firstMissingAt: "2026-11-02T02:10:00.000Z",
      lastMissingAt: "2026-11-02T02:40:00.000Z",
      returnedAt: "2026-11-02T03:00:00.000Z",
    },
  ],
};

// 시작 전에 보이던 01:50 게시본 → 02:25 → 02:55 게시가 사슬로 이어짐
const CHAIN = [
  lite("20261102T015000Z", "20261102T013500Z"),
  lite("20261102T022500Z", "20261102T015000Z"),
  lite("20261102T025500Z", "20261102T022500Z"),
];

describe("incidentImpact", () => {
  it("구간 게시본을 모두 확인했고 그 관측소 해변이 관측 지연으로 게시되지 않았으면 영향 없음", () => {
    expect(
      incidentImpact(INCIDENT, read(CHAIN), "20261102T025500Z", NOW_MS),
    ).toEqual({
      status: "none",
      wholeSource: false,
      delayedBeachIds: [],
      stations: [
        { id: "22451", name: "속초 파고부이", beaches: 2, waveBeaches: 2 },
      ],
    });
  });

  it("그 관측소를 파고로 쓰는 해변이 구간 안에 관측 지연으로 게시됐으면 영향 있음(다른 관측소 해변은 세지 않음)", () => {
    const chain = [
      CHAIN[0]!,
      lite("20261102T022500Z", "20261102T015000Z", ["b0002", "b0099"]),
      CHAIN[2]!,
    ];
    expect(
      incidentImpact(INCIDENT, read(chain), "20261102T025500Z", NOW_MS),
    ).toMatchObject({ status: "affected", delayedBeachIds: ["b0002"] });
  });

  it("구간 사이 게시 요약이 빠지면(previous 사슬이 끊김) 확인 못 함", () => {
    const broken = [
      CHAIN[0]!,
      lite("20261102T025500Z", "20261102T022500Z"), // 02:25 요약이 없음
    ];
    expect(
      incidentImpact(INCIDENT, read(broken), "20261102T025500Z", NOW_MS),
    ).toMatchObject({
      status: "unknown",
      reason: "summary_missing",
      delayedBeachIds: [],
    });
  });

  it("구간 바로 뒤 요약의 previous가 구간 마지막이 아니면(구간 끝 요약이 빠짐) 확인 못 함", () => {
    // 02:25 요약만 구간 안에 남고, 02:40 게시 요약이 빠짐 → 03:15 요약의 previous가 02:40
    const gap = [
      CHAIN[0]!,
      CHAIN[1]!,
      lite("20261102T031500Z", "20261102T024000Z"),
    ];
    expect(
      incidentImpact(INCIDENT, read(gap), "20261102T031500Z", NOW_MS),
    ).toMatchObject({ status: "unknown", reason: "summary_missing" });
  });

  it("뒤 요약이 없는데 구간 마지막이 지금 게시본이 아니면 확인 못 함", () => {
    expect(
      incidentImpact(INCIDENT, read(CHAIN), "20261102T031000Z", NOW_MS),
    ).toMatchObject({ status: "unknown", reason: "summary_missing" });
  });

  it("장애 시작 때 보이던 게시본 요약이 없으면 확인 못 함", () => {
    expect(
      incidentImpact(
        INCIDENT,
        read(CHAIN.slice(1)),
        "20261102T025500Z",
        NOW_MS,
      ),
    ).toMatchObject({ status: "unknown", reason: "summary_missing" });
  });

  it("이어지는 장애인데 마지막 요약이 지금 게시본이 아니면 확인 못 함", () => {
    const open: Incident = { ...INCIDENT, endedAt: null };
    expect(
      incidentImpact(open, read(CHAIN), "20261102T031000Z", NOW_MS),
    ).toMatchObject({ status: "unknown", reason: "summary_missing" });
  });

  it("요약을 읽지 못하면 확인 못 함", () => {
    expect(
      incidentImpact(INCIDENT, read([], true), "20261102T025500Z", NOW_MS),
    ).toMatchObject({ status: "unknown", reason: "summary_unread" });
  });

  it("빠진 관측소가 지금 게시본 요약에 없으면 확인 못 함", () => {
    const incident: Incident = {
      ...INCIDENT,
      stations: [{ ...INCIDENT.stations[0]!, id: "99999" }],
    };
    expect(
      incidentImpact(incident, read(CHAIN), "20261102T025500Z", NOW_MS),
    ).toMatchObject({
      status: "unknown",
      reason: "station_unknown",
      stations: [{ id: "99999", name: null, beaches: null, waveBeaches: null }],
    });
  });

  it("파고를 받는 출처가 통째로 실패하면 모든 관측 지연 해변을 영향으로 셈", () => {
    const incident: Incident = {
      ...INCIDENT,
      failures: [{ source: "sea_obs", reason: "timeout" }],
      stations: [],
    };
    const chain = [
      CHAIN[0]!,
      lite("20261102T022500Z", "20261102T015000Z", ["b0099"]),
      CHAIN[2]!,
    ];
    expect(
      incidentImpact(incident, read(chain), "20261102T025500Z", NOW_MS),
    ).toMatchObject({
      status: "affected",
      wholeSource: true,
      delayedBeachIds: ["b0099"],
    });
  });

  it("파주기·파향 출처(kma_buoy)만 실패하면 파고 관측소는 영향 범위가 아님", () => {
    const incident: Incident = {
      ...INCIDENT,
      failures: [{ source: "kma_buoy", reason: "timeout" }],
      stations: [],
    };
    const chain = [
      CHAIN[0]!,
      lite("20261102T022500Z", "20261102T015000Z", ["b0099"]),
      CHAIN[2]!,
    ];
    expect(
      incidentImpact(incident, read(chain), "20261102T025500Z", NOW_MS),
    ).toMatchObject({ status: "none", wholeSource: false });
  });
});

describe("readPublishSummaries", () => {
  // 요약 Query(키 조건: 전체·sk <= :from·sk > :from)와 관측소 표 GetItem만 받는 가짜
  function client(
    items: Record<string, unknown>[] | Error,
    table: unknown = STATIONS,
  ) {
    const sent: string[] = [];
    const sender = {
      async send(command: QueryCommand | GetCommand) {
        if (items instanceof Error) throw items;
        if (command instanceof GetCommand) {
          sent.push(`get ${command.input.Key?.pk}`);
          return {
            Item:
              table === undefined
                ? undefined
                : { ...STATION_TABLE_KEY, stations: table },
          };
        }
        const condition = command.input.KeyConditionExpression!;
        const from = String(command.input.ExpressionAttributeValues?.[":from"]);
        sent.push(`query ${condition}`);
        const forward = command.input.ScanIndexForward !== false;
        const sorted = items
          .filter((item) =>
            condition.includes("<=")
              ? String(item.sk) <= from
              : condition.includes(">")
                ? String(item.sk) > from
                : true,
          )
          .sort((a, b) => (String(a.sk) < String(b.sk) === forward ? -1 : 1));
        return {
          Items: command.input.Limit
            ? sorted.slice(0, command.input.Limit)
            : sorted,
        };
      },
    } as unknown as Sender;
    return { sender, sent };
  }

  const item = (version: string, previous: string | null) => ({
    pk: PUBLISH_SUMMARY_PK,
    sk: version,
    ...lite(version, previous, ["b0001"]),
  });
  const ITEMS = [
    item("20261102T013500Z", null),
    item("20261102T015000Z", "20261102T013500Z"),
    item("20261102T022500Z", "20261102T015000Z"),
  ];

  it("관측 장애가 없으면 최신 요약과 관측소 표만 읽고 지금 게시본의 관측 지연 해변 수를 돌려준다", async () => {
    const { sender, sent } = client(ITEMS);
    const result = await readPublishSummaries(sender, "Ops", null);
    expect(sent.sort()).toEqual(["get publish#stations", "query pk = :pk"]);
    expect(result.failed).toBe(false);
    expect(result.list).toEqual([]);
    expect(result.stations).toEqual(STATIONS);
    expect(result.live("20261102T022500Z")).toEqual({
      version: "20261102T022500Z",
      publishedAt: "20261102T022500Z",
      beachCount: 206,
      delayedBeaches: 1,
    });
    // 지금 게시본의 요약이 없으면 0이 아니라 null
    expect(result.live("20261102T030000Z")).toBeNull();
    expect(result.live(null)).toBeNull();
  });

  it("장애 시작 때 보이던 게시본 하나와 그 뒤 요약만 읽는다(더 오래된 요약은 읽지 않음)", async () => {
    const { sender } = client(ITEMS);
    const result = await readPublishSummaries(
      sender,
      "Ops",
      Date.parse("2026-11-02T02:10:00Z"),
    );
    expect(result.list.map((s) => s.version)).toEqual([
      "20261102T015000Z",
      "20261102T022500Z",
    ]);
  });

  it("읽기에 실패하면 failed로 두고 지금 게시본 요약·관측소 표도 null", async () => {
    const { sender } = client(new Error("throttled"));
    const result = await readPublishSummaries(sender, "Ops", NOW_MS);
    expect(result.failed).toBe(true);
    expect(result.stations).toBeNull();
    expect(result.live("20261102T022500Z")).toBeNull();
  });

  it("관측소 표가 없거나 모양이 틀리면 쓰지 않는다(영향 판정은 station_unknown)", async () => {
    for (const table of [null, { x: { name: 1 } }]) {
      const { sender } = client(ITEMS, table);
      expect(
        (await readPublishSummaries(sender, "Ops", null)).stations,
      ).toBeNull();
    }
  });
});

describe("versionOf", () => {
  it("UTC 시각을 게시 버전 모양으로 바꾼다", () => {
    expect(versionOf(Date.parse("2026-11-04T05:10:00.123Z"))).toBe(
      "20261104T051000Z",
    );
  });
});
