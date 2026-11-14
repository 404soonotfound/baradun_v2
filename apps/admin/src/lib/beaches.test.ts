import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localPublishedView } from "./auth/local-beaches";
import {
  loadBeaches,
  loadZoneNames,
  parseCsv,
  summaryOf,
} from "./beach-data";
import {
  BEACH_PAGE_SIZE,
  SIDO_ORDER,
  badgeTone,
  beachListHref,
  delayedObservedAt,
  displayOf,
  editUrl,
  filterBeaches,
  historyUrl,
  isZoneVerified,
  parseBeachMemo,
  parseBeachQuery,
  parsePublished,
  queryBeaches,
  sidoList,
  tabCounts,
  zoneDisplayName,
  zoneList,
  type BeachSummary,
} from "./beaches";
import { pageRows, pageWindow } from "./paging";

// 해변 관리 화면 (BRD-150, ADM-BCH)
// - 해변 정보는 저장소 파일 세 가지에서 읽음(읽기 전용)
// - 지금 표시 상태는 게시본 그대로. 못 받거나 게시본에 없으면 판단불가 계열 '확인 못 함'

const NOW = Date.parse("2026-11-11T03:10:00Z");
const VALID = "2026-11-11T03:45:00Z";

const PUBLISHED = {
  available: true,
  snapshotVersion: "20261111T030000Z",
  generatedAt: "2026-11-11T03:00:12Z",
  maintenance: { active: false, until: null },
  beaches: {
    b0001: { category: "clear", reasons: [], validUntil: VALID },
    b0002: {
      category: "unavailable",
      validUntil: VALID,
      reasons: [
        {
          code: "warning",
          type: "wind_wave",
          level: "advisory",
          scope: "강원중부앞바다",
          source: "기상청",
          at: "2026-11-11T02:00:00Z",
        },
        {
          code: "observation_delayed",
          scope: "연곡 파고부이",
          source: "기상청",
          at: "2026-11-11T01:00:00Z",
        },
      ],
    },
    // 모르는 사유 code: 이용불가는 그대로 두고 이름만 '이용 제한'
    b0003: {
      category: "unavailable",
      validUntil: VALID,
      reasons: [{ code: "control_closed", scope: "x", source: "y", at: null }],
    },
    b0004: { category: "undetermined", reasons: [], validUntil: VALID },
    b0005: {
      category: "undetermined",
      validUntil: VALID,
      reasons: [{ code: "warning_unknown", scope: "x", source: "기상청" }],
    },
  },
};

describe("지금 표시 상태", () => {
  const view = parsePublished(PUBLISHED);

  it("게시본의 분류·사유를 그대로 쓰고 배지는 실제 사유를 먼저 보여 준다", () => {
    expect(displayOf(view, "b0001", NOW)).toMatchObject({
      kind: "published",
      category: "clear",
      labels: [{ kind: "clear" }],
    });
    const blocked = displayOf(view, "b0002", NOW);
    expect(blocked).toMatchObject({
      kind: "published",
      category: "unavailable",
      labels: [
        { kind: "warning", type: "wind_wave", level: "advisory" },
        { kind: "observation_delayed" },
      ],
    });
    expect(displayOf(view, "b0005", NOW)).toMatchObject({
      category: "undetermined",
      labels: [{ kind: "warning_unknown" }],
    });
  });

  it("모르는 사유는 분류를 바꾸지 않고 일반 단어(이용 제한·확인 못 함)", () => {
    expect(displayOf(view, "b0003", NOW)).toMatchObject({
      category: "unavailable",
      labels: [{ kind: "restricted" }],
    });
    expect(displayOf(view, "b0004", NOW)).toMatchObject({
      category: "undetermined",
      labels: [{ kind: "unconfirmed" }],
    });
  });

  it("응답 전은 불러오는 중, 못 받음·게시 버킷 없음·게시본에 없음은 판단불가 계열 '확인 못 함'", () => {
    expect(displayOf("loading", "b0001", NOW)).toEqual({ kind: "loading" });
    expect(displayOf(null, "b0001", NOW)).toEqual({
      kind: "unconfirmed",
      why: "unavailable",
    });
    const off = parsePublished({ available: false, reason: "not_configured" });
    expect(off).toEqual({ available: false, reason: "not_configured" });
    expect(displayOf(off, "b0001", NOW)).toEqual({
      kind: "unconfirmed",
      why: "unavailable",
    });
    expect(displayOf(view, "b9999", NOW)).toEqual({
      kind: "unconfirmed",
      why: "missing",
    });
    // 어느 경우도 특보 없음(clear) 색이 아님
    expect(badgeTone({ kind: "unconfirmed" })).toBe("unknown");
  });

  it("validUntil이 지나도 게시 분류·사유는 바꾸지 않고(G1) 지남 표시만 켠다", () => {
    const later = Date.parse(VALID) + 1;
    for (const id of ["b0001", "b0002", "b0004", "b0005"]) {
      const before = displayOf(view, id, NOW);
      const after = displayOf(view, id, later);
      expect(before).toMatchObject({ kind: "published", expired: false });
      expect(after).toMatchObject({ kind: "published", expired: true });
      if (before.kind !== "published" || after.kind !== "published") continue;
      expect(after.category).toBe(before.category);
      expect(after.labels).toEqual(before.labels);
      expect(after.reasons).toEqual(before.reasons);
    }
    expect(displayOf(view, "b0001", later)).toMatchObject({
      category: "clear",
      labels: [{ kind: "clear" }],
    });
    // 경계: validUntil 그 시각까지는 지나지 않음
    expect(displayOf(view, "b0001", Date.parse(VALID))).toMatchObject({
      expired: false,
    });
  });

  it("게시본이 점검 중이면 '점검 중'으로 보이고 마지막 게시 분류는 바꾸지 않고 함께 둔다(D23-11)", () => {
    const until = "2026-11-11T05:00:00Z";
    const maint = parsePublished({
      ...PUBLISHED,
      maintenance: { active: true, until },
    });
    expect(maint?.available).toBe(true);
    for (const id of ["b0001", "b0002", "b0004", "b0005"]) {
      const shown = displayOf(maint, id, NOW);
      expect(shown).toMatchObject({ kind: "maintenance", until });
      if (shown.kind !== "maintenance") continue;
      expect(shown.last).toEqual(displayOf(view, id, NOW));
    }
    // 게시본에 없는 해변도 점검 중이 먼저, 마지막 분류는 '게시본에 없음'
    expect(displayOf(maint, "b9999", NOW)).toEqual({
      kind: "maintenance",
      until,
      last: { kind: "unconfirmed", why: "missing" },
    });
    // 끝나는 시각을 정하지 않은 점검
    const noUntil = parsePublished({
      ...PUBLISHED,
      maintenance: { active: true, until: null },
    });
    expect(displayOf(noUntil, "b0001", NOW)).toMatchObject({
      kind: "maintenance",
      until: null,
    });
    // 게시본을 못 받으면 점검인지 모르므로 '확인 못 함' 그대로
    expect(displayOf(null, "b0001", NOW)).toEqual({
      kind: "unconfirmed",
      why: "unavailable",
    });
  });

  it("점검 칸이 없거나 모양이 틀리면 전체를 못 읽은 것으로 봄(점검 아님으로 채우지 않음)", () => {
    const { maintenance: _drop, ...noMaintenance } = PUBLISHED;
    void _drop;
    expect(parsePublished(noMaintenance)).toBeNull();
    expect(
      parsePublished({
        ...PUBLISHED,
        maintenance: { active: "yes", until: null },
      }),
    ).toBeNull();
    expect(
      parsePublished({
        ...PUBLISHED,
        maintenance: { active: true, until: "곧" },
      }),
    ).toBeNull();
    expect(
      parsePublished({ ...PUBLISHED, maintenance: { active: true } }),
    ).toBeNull();
  });

  it("모양이 틀린 응답은 해변 하나만 빼지 않고 전체를 못 읽은 것으로 봄", () => {
    const bad = structuredClone(PUBLISHED) as {
      beaches: Record<string, { category: string }>;
    };
    bad.beaches.b0004!.category = "safe";
    expect(parsePublished(bad)).toBeNull();
    expect(parsePublished({ ...PUBLISHED, generatedAt: "어제" })).toBeNull();
    const noValid = structuredClone(PUBLISHED) as {
      beaches: Record<string, { validUntil?: string }>;
    };
    delete noValid.beaches.b0001!.validUntil;
    expect(parsePublished(noValid)).toBeNull();
    expect(parsePublished({ ...PUBLISHED, available: "yes" })).toBeNull();
    expect(parsePublished(null)).toBeNull();
  });

  it("배지 색: 특보·이용 제한은 이용불가, 특보 확인 못 함·확인 못 함은 판단불가, 관측 지연은 지연", () => {
    expect(
      badgeTone({ kind: "warning", type: "tsunami", level: "warning" }),
    ).toBe("blocked");
    expect(badgeTone({ kind: "restricted" })).toBe("blocked");
    expect(badgeTone({ kind: "warning_unknown" })).toBe("unknown");
    expect(badgeTone({ kind: "observation_delayed" })).toBe("stale");
    expect(badgeTone({ kind: "clear" })).toBe("clear");
  });

  it("로컬 개발 예시 응답도 같은 검사를 통과한다", () => {
    expect(parsePublished(localPublishedView())?.available).toBe(true);
  });
});

describe("저장소 파일 읽기", () => {
  // 운영 기간 연도는 빌드 시각의 한국 연도라 시험은 데이터 연도(2026)로 고정
  const beaches = loadBeaches(undefined, "2026");

  it("data/beaches 파일마다 한 곳씩, beach-meta.json 별칭·beach-coverage.csv 검증 결과와 이어 붙인다", () => {
    expect(beaches).toHaveLength(222);
    expect(beaches.every((b) => b.inMeta)).toBe(true);
    expect(beaches.every((b) => b.check !== null)).toBe(true);
    const gangmun = beaches.find((b) => b.id === "b0001")!;
    expect(gangmun).toMatchObject({
      slug: "gangmun",
      nameKo: "강문해수욕장",
      sido: "강원",
      sigungu: "강릉시",
      zones: { sea: "S1151200", land: "L1022510" },
      stations: {
        waveHeight: { id: "22451", name: "연곡 파고부이", distanceKm: 8.3 },
      },
      photo: { source: "한국관광공사", license: "kogl-type1" },
      season: {
        year: "2026",
        status: "open",
        openDate: "2026-07-10",
        closeDate: "2026-08-23",
      },
    });
    expect(gangmun.check).toMatchObject({
      stage: "SOURCE_CANDIDATE",
      sea: { zone: "S1151200", status: "검증" },
      land: { zone: "L1022510", status: "검증" },
    });
  });

  it("측정소가 없는 지표는 null(화면은 '가까운 관측 없음'), 0이나 빈 값으로 바꾸지 않음", () => {
    const noWave = beaches.find((b) => b.stations.waveHeight === null);
    expect(noWave).toBeDefined();
    expect(summaryOf(noWave!).waveHeight).toBe(false);
  });

  it("목록에는 요약만 넘기고, 운영 메모·판단 상태는 해변 정보에 없다", () => {
    const summary = summaryOf(beaches[0]!);
    expect(Object.keys(summary)).not.toContain("check");
    const text = JSON.stringify(beaches);
    expect(text).not.toMatch(/"memo"|"category"|"reasons"/);
  });

  describe("모양이 틀리면 빌드를 멈춤", () => {
    // beach-coverage.csv에서 읽는 칸 머리줄
    const COLUMNS =
      "id,stage,coords_source,sea_zone,sea_status,sea_basis,sea_rule_url,sea_checked_at_kst,land_zone,land_status,land_basis,land_rule_url,land_checked_at_kst,station_basis,response_check,exclusion,review_reason";
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("파일 이름과 ID가 다르면 던진다", () => {
      dir = mkdtempSync(path.join(tmpdir(), "beaches-"));
      mkdirSync(path.join(dir, "beaches"));
      writeFileSync(
        path.join(dir, "beach-meta.json"),
        JSON.stringify({ beaches: {} }),
      );
      writeFileSync(path.join(dir, "beach-coverage.csv"), `${COLUMNS}\n`);
      writeFileSync(
        path.join(dir, "beaches", "b0001.json"),
        JSON.stringify({ id: "b0002" }),
      );
      expect(() => loadBeaches(dir)).toThrow(/b0001\.json/);
    });

    it("검증 기록에서 읽는 칸이 하나라도 없으면 데이터 줄이 없어도 던진다", () => {
      dir = mkdtempSync(path.join(tmpdir(), "beaches-"));
      mkdirSync(path.join(dir, "beaches"));
      writeFileSync(
        path.join(dir, "beach-meta.json"),
        JSON.stringify({ beaches: {} }),
      );
      writeFileSync(
        path.join(dir, "beach-coverage.csv"),
        `${COLUMNS.replace(",response_check", "")}\n`,
      );
      expect(() => loadBeaches(dir)).toThrow(/response_check/);
    });
  });
});

describe("CSV 읽기", () => {
  it("따옴표 칸 안의 쉼표·줄바꿈·겹따옴표를 그대로 읽는다", () => {
    expect(parseCsv('id,basis\nb1,"a, b\n""c"""\nb2,x\n')).toEqual([
      { id: "b1", basis: 'a, b\n"c"' },
      { id: "b2", basis: "x" },
    ]);
  });

  it("칸 수가 다르거나 따옴표가 닫히지 않으면 던진다", () => {
    expect(() => parseCsv("a,b\n1\n")).toThrow(/칸 수/);
    expect(() => parseCsv('a\n"1\n')).toThrow(/따옴표/);
  });
});

describe("찾기·링크", () => {
  const list = [
    {
      id: "b0001",
      nameKo: "강문해수욕장",
      slug: "gangmun",
      sido: "강원",
      sigungu: "강릉시",
      aliases: ["강문"],
    },
    {
      id: "b0094",
      nameKo: "송도해수욕장",
      slug: "songdo",
      sido: "부산",
      sigungu: "서구",
      aliases: ["송도"],
    },
  ] as unknown as BeachSummary[];

  it("이름·별칭·slug·ID에서 띄어쓰기·대소문자 없이 찾고 지역으로 거른다", () => {
    expect(filterBeaches(list, "강 문", null).map((b) => b.id)).toEqual([
      "b0001",
    ]);
    expect(filterBeaches(list, "SONGDO", null).map((b) => b.id)).toEqual([
      "b0094",
    ]);
    expect(filterBeaches(list, "", "부산").map((b) => b.id)).toEqual(["b0094"]);
    expect(filterBeaches(list, "강문", "부산")).toEqual([]);
  });

  it("GitHub에서 수정은 그 값이 있는 파일 편집 화면, 변경 이력은 그 파일 커밋 기록", () => {
    expect(editUrl("beach", "b0001")).toBe(
      "https://github.com/404soonotfound/baradun_v2/edit/main/data/beaches/b0001.json",
    );
    expect(editUrl("meta", "b0001")).toBe(
      "https://github.com/404soonotfound/baradun_v2/edit/main/data/beach-meta.json",
    );
    expect(historyUrl("coverage", "b0001")).toBe(
      "https://github.com/404soonotfound/baradun_v2/commits/main/data/beach-coverage.csv",
    );
  });
});

describe("운영 메모 응답", () => {
  it("다른 해변 응답·모양이 틀린 응답은 받지 않는다", () => {
    const ok = { beachId: "b0001", memo: null, version: 0, updatedAt: null };
    expect(parseBeachMemo(ok, "b0001")).toEqual(ok);
    expect(parseBeachMemo(ok, "b0002")).toBeNull();
    expect(parseBeachMemo({ ...ok, version: -1 }, "b0001")).toBeNull();
    expect(parseBeachMemo({ ...ok, memo: 3 }, "b0001")).toBeNull();
  });
});

describe("특보 구역 공식 이름표(annex-tables.json)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("annex5.zones와 annex9.sigungu[].rows를 읽어 공식 이름을 매기고, 표에 없는 코드는 코드와 '이름 확인 못 함'을 둔다", () => {
    const names = loadZoneNames();
    expect(names.sea.S1151200).toBe("강원중부앞바다");
    expect(names.land.L1022510).toBe("강릉평지");
    expect(
      zoneDisplayName("S1151200", names.sea.S1151200 ?? null, "이름 확인 못 함"),
    ).toBe("강원중부앞바다");
    expect(zoneDisplayName("S9999999", null, "이름 확인 못 함")).toBe(
      "S9999999 · 이름 확인 못 함",
    );
  });

  it("annex9에서 같은 코드에 이름이 둘이거나 구조가 틀리면 빌드를 멈춘다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "annex-"));
    const bad = path.join(dir, "annex.json");
    writeFileSync(
      bad,
      JSON.stringify({
        annex5: { zones: { S1: { name: "앞바다" } } },
        annex9: {
          sigungu: {
            a: { rows: [{ code: "L1", name: "강릉" }] },
            b: { rows: [{ code: "L1", name: "동해" }] },
          },
        },
      }),
    );
    expect(() => loadZoneNames(bad)).toThrow(/L1/);

    const missing = path.join(dir, "missing.json");
    writeFileSync(missing, JSON.stringify({ annex5: {} }));
    expect(() => loadZoneNames(missing)).toThrow(/annex9/);
  });
});

describe("해변 목록 V2 탭·필터·정렬·페이징·쿼리", () => {
  const sample = (over: Partial<BeachSummary>): BeachSummary => ({
    id: "b0001",
    slug: "sample",
    nameKo: "샘플해변",
    sido: "강원",
    sigungu: "강릉시",
    hidden: false,
    aliases: [],
    inMeta: true,
    seaZone: "S1151200",
    seaZoneName: "강원중부앞바다",
    seaStatus: "검증",
    landStatus: "검증",
    stations: 2,
    waveHeight: true,
    wavePeriod: true,
    season: null,
    hasPhoto: false,
    hasCheck: true,
    ...over,
  });

  const rows: BeachSummary[] = [
    sample({
      id: "b0001",
      nameKo: "강문해변",
      aliases: ["강문대"],
      sido: "강원",
      sigungu: "강릉시",
      seaZone: "S1151200",
      seaZoneName: "강원중부앞바다",
    }),
    sample({
      id: "b0002",
      nameKo: "경포해변",
      sido: "강원",
      sigungu: "강릉시",
      seaZone: "S1151200",
      seaZoneName: "강원중부앞바다",
    }),
    sample({
      id: "b0003",
      nameKo: "숨긴해변",
      sido: "부산",
      sigungu: "해운대구",
      hidden: true,
      seaZone: "S1311100",
      seaZoneName: "부산앞바다",
    }),
    sample({
      id: "b0004",
      nameKo: "협재해변",
      aliases: ["금능"],
      sido: "제주",
      sigungu: "제주시",
      seaZone: "S1261100",
      seaZoneName: "제주도북부앞바다",
      stations: 0,
      waveHeight: false,
      wavePeriod: false,
    }),
    sample({
      id: "b0005",
      nameKo: "미검증해변",
      sido: "충남",
      sigungu: "태안군",
      seaZone: "S9999999",
      seaZoneName: null,
      seaStatus: "미검증",
    }),
    sample({
      id: "b0006",
      nameKo: "기록없음해변",
      sido: "경북",
      sigungu: "포항시",
      seaZone: "S1141100",
      seaZoneName: "동해남부앞바다",
      hasCheck: false,
      seaStatus: null,
      landStatus: null,
    }),
  ];

  const view = parsePublished({
    available: true,
    snapshotVersion: "20261111T030000Z",
    generatedAt: "2026-11-11T03:00:12Z",
    maintenance: { active: false, until: null },
    beaches: {
      b0001: { category: "clear", reasons: [], validUntil: VALID },
      b0002: {
        category: "unavailable",
        validUntil: VALID,
        reasons: [
          {
            code: "warning",
            type: "wind_wave",
            level: "advisory",
            scope: "강원중부앞바다",
            source: "기상청",
            at: "2026-11-11T02:00:00Z",
          },
        ],
      },
      // 측정소 없음(b0004)이라도 게시본의 특보 없음 분류를 그대로 유지함
      b0004: { category: "clear", reasons: [], validUntil: VALID },
      b0005: {
        category: "undetermined",
        validUntil: VALID,
        reasons: [
          {
            code: "observation_delayed",
            scope: "태안 부이",
            source: "기상청",
            at: "2026-11-11T01:00:00Z",
          },
        ],
      },
      b0006: { category: "clear", reasons: [], validUntil: VALID },
    },
  });

  it("탭마다 개수를 계산하고 탭별로 거른다(비노출·가까운 관측 없음·구역 검증 안 됨 포함)", () => {
    expect(tabCounts(rows, view, NOW)).toEqual({
      all: 6,
      undetermined: 1, // b0005 (비노출 b0003은 status.json에 없어도 판단불가로 치지 않음)
      unavailable: 1, // b0002
      hidden: 1, // b0003
      no_station: 1, // b0004
      unverified: 2, // b0005(미검증), b0006(hasCheck: false)
    });
    expect(
      queryBeaches(
        rows,
        { tab: "undetermined", q: "", sido: null, zone: null, sort: "status" },
        view,
        NOW,
      ).map((b) => b.id),
    ).toEqual(["b0005"]);
    expect(
      queryBeaches(
        rows,
        { tab: "unavailable", q: "", sido: null, zone: null, sort: "status" },
        view,
        NOW,
      ).map((b) => b.id),
    ).toEqual(["b0002"]);
    expect(
      queryBeaches(
        rows,
        { tab: "hidden", q: "", sido: null, zone: null, sort: "status" },
        view,
        NOW,
      ).map((b) => b.id),
    ).toEqual(["b0003"]);
    expect(
      queryBeaches(
        rows,
        { tab: "no_station", q: "", sido: null, zone: null, sort: "status" },
        view,
        NOW,
      ).map((b) => b.id),
    ).toEqual(["b0004"]);
    expect(
      queryBeaches(
        rows,
        { tab: "unverified", q: "", sido: null, zone: null, sort: "status" },
        view,
        NOW,
      ).map((b) => b.id),
    ).toEqual(["b0005", "b0006"]);
    expect(isZoneVerified(rows[0]!)).toBe(true);
    expect(isZoneVerified(rows[4]!)).toBe(false);
    expect(isZoneVerified(rows[5]!)).toBe(false);
    // 관측 지연 사유에 측정 시각이 있으면 꺼내고 없으면 null
    expect(delayedObservedAt(displayOf(view, "b0005", NOW))).toBe(
      "2026-11-11T01:00:00Z",
    );
    expect(delayedObservedAt(displayOf(view, "b0001", NOW))).toBeNull();
  });

  it("게시본을 불러오는 중이면 판단불가·이용불가 수는 null, 못 받으면 모두 '확인 못 함'(판단불가)", () => {
    expect(tabCounts(rows, "loading", NOW)).toEqual({
      all: 6,
      undetermined: null,
      unavailable: null,
      hidden: 1,
      no_station: 1,
      unverified: 2,
    });
    // 게시본 실패(null) 또는 available: false → 비노출 포함 모두 확인 못 함
    expect(tabCounts(rows, null, NOW)).toEqual({
      all: 6,
      undetermined: 6,
      unavailable: 0,
      hidden: 1,
      no_station: 1,
      unverified: 2,
    });
    expect(displayOf(null, "b0001", NOW)).toEqual({
      kind: "unconfirmed",
      why: "unavailable",
    });
  });

  it("지역(시·도)은 지리 순서로 정렬하고, 별칭·특보 구역 필터와 조합한다", () => {
    expect(sidoList(rows)).toEqual(["강원", "경북", "부산", "충남", "제주"]);
    const allBeaches = loadBeaches(undefined, "2026").map(summaryOf);
    expect(sidoList(allBeaches)).toEqual([...SIDO_ORDER]);
    // 모르는 시·도는 지리 순서 뒤 한국어 사전순
    expect(
      sidoList([
        sample({ sido: "미지" }),
        sample({ sido: "제주" }),
        sample({ sido: "가나" }),
        sample({ sido: "강원" }),
      ]),
    ).toEqual(["강원", "제주", "가나", "미지"]);

    expect(
      queryBeaches(
        rows,
        { tab: "all", q: "금능", sido: null, zone: null, sort: "status" },
        view,
        NOW,
      ).map((b) => b.id),
    ).toEqual(["b0004"]);
    expect(
      queryBeaches(
        rows,
        {
          tab: "all",
          q: "",
          sido: "강원",
          zone: "S1151200",
          sort: "region",
        },
        view,
        NOW,
      ).map((b) => b.id),
    ).toEqual(["b0001", "b0002"]);
    expect(zoneList(rows).find((z) => z.code === "S9999999")).toEqual({
      code: "S9999999",
      name: null,
    });
  });

  it("앱 표시 순은 판단불가·이용불가·미확인·비노출·특보 없음 순서이고 지역 순은 지리 순서다", () => {
    expect(
      queryBeaches(
        rows,
        { tab: "all", q: "", sido: null, zone: null, sort: "status" },
        view,
        NOW,
      ).map((b) => b.id),
    ).toEqual(["b0005", "b0002", "b0003", "b0001", "b0006", "b0004"]);
    expect(
      queryBeaches(
        rows,
        { tab: "all", q: "", sido: null, zone: null, sort: "region" },
        view,
        NOW,
      ).map((b) => b.id),
    ).toEqual(["b0001", "b0002", "b0006", "b0003", "b0005", "b0004"]);
  });

  it("페이징 경계(11행/쪽): 222곳은 21쪽이고 마지막 쪽과 범위 밖 쪽을 안전하게 자른다", () => {
    expect(BEACH_PAGE_SIZE).toBe(11);
    const items = Array.from({ length: 222 }, (_, i) => i + 1);
    expect(pageWindow(222, 0, BEACH_PAGE_SIZE)).toEqual({
      page: 0,
      pages: 21,
      from: 1,
      to: 11,
      atStart: true,
      atEnd: false,
    });
    const last = pageWindow(222, 99, BEACH_PAGE_SIZE);
    expect(last).toEqual({
      page: 20,
      pages: 21,
      from: 221,
      to: 222,
      atStart: false,
      atEnd: true,
    });
    expect(pageRows(items, 20, BEACH_PAGE_SIZE)).toEqual([221, 222]);
    expect(pageRows(items, -3, BEACH_PAGE_SIZE)).toHaveLength(11);
  });

  it("주소 쿼리 파싱과 직렬화가 잘못된 값을 막고 상태를 보존한다", () => {
    expect(parseBeachQuery(new URLSearchParams(""))).toEqual({
      tab: "all",
      q: "",
      sido: null,
      zone: null,
      sort: "status",
      page: 0,
    });
    const parsed = parseBeachQuery(
      new URLSearchParams(
        "tab=no_station&q=협재&sido=제주&zone=S1261100&sort=region&page=3",
      ),
    );
    expect(parsed).toEqual({
      tab: "no_station",
      q: "협재",
      sido: "제주",
      zone: "S1261100",
      sort: "region",
      page: 2,
    });
    expect(beachListHref(parsed)).toBe(
      "/beaches/?tab=no_station&q=%ED%98%91%EC%9E%AC&sido=%EC%A0%9C%EC%A3%BC&zone=S1261100&sort=region&page=3",
    );
    expect(
      parseBeachQuery(
        new URLSearchParams("tab=bogus&sort=weird&page=0&sido= "),
      ),
    ).toEqual({
      tab: "all",
      q: "",
      sido: null,
      zone: null,
      sort: "status",
      page: 0,
    });
    expect(
      parseBeachQuery(new URLSearchParams("page=abc")).page,
    ).toBe(0);
    expect(
      beachListHref({
        tab: "all",
        q: "",
        sido: null,
        zone: null,
        sort: "status",
        page: 0,
      }),
    ).toBe("/beaches/");
  });
});
