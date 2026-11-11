import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localPublishedView } from "./auth/local-beaches";
import { loadBeaches, parseCsv, summaryOf } from "./beach-data";
import {
  badgeTone,
  displayOf,
  editUrl,
  filterBeaches,
  historyUrl,
  parseBeachMemo,
  parsePublished,
  type BeachSummary,
} from "./beaches";

// 해변 관리 화면 (BRD-150, ADM-BCH)
// - 해변 정보는 저장소 파일 세 가지에서 읽음(읽기 전용)
// - 지금 표시 상태는 게시본 그대로. 못 받거나 게시본에 없으면 판단불가 계열 '확인 못 함'

const NOW = Date.parse("2026-11-11T03:10:00Z");
const VALID = "2026-11-11T03:45:00Z";

const PUBLISHED = {
  available: true,
  snapshotVersion: "20261111T030000Z",
  generatedAt: "2026-11-11T03:00:12Z",
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
    expect(beaches).toHaveLength(206);
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
