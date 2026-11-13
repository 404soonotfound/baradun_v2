import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diffMatrix, parseResponse, rebuildMatrix } from "../live-matrix.mjs";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));

const seaRow = (tm: string, stn: string, wh: string, wd: string, ws: string, tw: string) =>
  `B, ${tm},    ${stn},               관측소, 129.00000000,  37.00000000,   ${wh}, ${wd},   ${ws},   2.7,  ${tw},  17.0, 1022.6,  80.0, ,=`;
const buoyRow = (tm: string, stn: string, wp: string, wo: string) =>
  `${tm} ${stn}  11   2.9   3.1   7   2.9   3.2 1016.7  79.0  17.6  20.9   0.6   0.3   0.2   ${wp} ${wo}`;
const wrap = (rows: string[]) => ["#START7777", "# header", ...rows, "#7777END", ""].join("\n");

function fixture({ sea1, buoy1, sea2, buoy2 }: { sea1: string[]; buoy1: string[]; sea2?: string[]; buoy2?: string[] }) {
  const root = mkdtempSync(join(tmpdir(), "live-matrix-"));
  roots.push(root);
  const put = (p: string, v: string) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), v); };
  const attempts = [];
  const add = (source: string, n: number, tm: string, rows?: string[]) => {
    if (!rows) return;
    put(`responses/${source}-attempt-${n}.txt`, wrap(rows));
    attempts.push({ source, attempt: n, request_url: `https://apihub.kma.go.kr/api/typ01/url/${source}.php?tm=${tm}&stn=0&help=0`, outcome: "RESPONSE_RECEIVED", http_status: 200, response_file: `responses/${source}-attempt-${n}.txt`, finished_at_utc: `fixture-${n}` });
  };
  add("sea_obs", 1, "202610210000", sea1);
  add("kma_buoy", 1, "202610210000", buoy1);
  add("sea_obs", 2, "202611131100", sea2);
  add("kma_buoy", 2, "202611131100", buoy2);
  put("responses/call-ledger.json", JSON.stringify({ attempts }));
  return root;
}
const skeleton = { stations: [{ stn_id: "22001", name: "가" }, { stn_id: "22002", name: "나" }] };

describe("실응답 지표 매트릭스 재생성", () => {
  it("관측소별 가장 늦은 행에서 값을 읽고 -99는 결측, 행 없음은 ROW_ABSENT로 둠", () => {
    const rows = parseResponse("kma_buoy", wrap([buoyRow("202610202350", "22001", "5.0", "100"), buoyRow("202610210000", "22001", "6.1", "221")]));
    expect(rows.get("22001").f[15]).toBe("6.1");

    const root = fixture({ sea1: [seaRow("202610210000", "22001", "0.5", "-99", "-99.0", "21.6")], buoy1: [buoyRow("202610210000", "22001", "6.1", "221")] });
    const [a, b] = rebuildMatrix(skeleton, root).stations;
    expect(a.metrics.waveHeight).toMatchObject({ state: "VALUE_PRESENT", value: 0.5, observed_at_utc: "2026-10-20T15:00:00Z", raw_values: ["0.5"] });
    expect(a.metrics.wind).toMatchObject({ state: "MISSING", value: null, raw_values: ["-99", "-99.0"] });
    expect(a.metrics.waveDirection).toMatchObject({ state: "VALUE_PRESENT", value: 221 });
    expect(b.metrics.waveHeight).toMatchObject({ state: "ROW_ABSENT", observed_at_utc: null, value: null });
    expect(b.metrics.waveHeight).not.toHaveProperty("raw_values");
  });

  it("보충 응답은 기본 칸이 VALUE_PRESENT가 아닐 때만 올리고, 확인된 값을 덮거나 결측으로 낮추지 않음", () => {
    const root = fixture({
      sea1: [seaRow("202610210000", "22001", "0.5", "-99", "-99.0", "21.6")],
      buoy1: [],
      sea2: [seaRow("202611131100", "22001", "-99.0", "38", "1.5", "20.0"), seaRow("202611131100", "22002", "0.9", "-99", "-99.0", "19.0")],
      buoy2: [buoyRow("202611131100", "22002", "4.2", "90")],
    });
    const m = rebuildMatrix(skeleton, root);
    const [a, b] = m.stations;
    expect(a.metrics.waveHeight).toMatchObject({ value: 0.5, response_file: "responses/sea_obs-attempt-1.txt" }); // 보충의 결측이 덮지 않음
    expect(a.metrics.waterTemp).toMatchObject({ value: 21.6, response_file: "responses/sea_obs-attempt-1.txt" }); // 보충 값이 덮지 않음
    expect(a.metrics.wind).toMatchObject({ state: "VALUE_PRESENT", value: { direction_deg: 38, speed_ms: 1.5 }, observed_at_utc: "2026-11-13T02:00:00Z", response_file: "responses/sea_obs-attempt-2.txt" });
    expect(a.metrics.wavePeriod).toMatchObject({ state: "ROW_ABSENT", response_file: "responses/kma_buoy-attempt-1.txt" }); // 보충에도 없으면 기본 그대로
    expect(b.metrics.wind).toMatchObject({ state: "ROW_ABSENT", response_file: "responses/sea_obs-attempt-1.txt" }); // 보충 결측으로 바꾸지 않음
    expect(b.metrics.wavePeriod).toMatchObject({ state: "VALUE_PRESENT", value: 4.2, response_file: "responses/kma_buoy-attempt-2.txt" });
    expect(m.supplements[0].sea_obs.request_url).toContain("tm=202611131100");
  });

  it("저장본 지표가 응답 원문·규칙과 다르면 diffMatrix가 칸을 알려 줌", () => {
    const root = fixture({ sea1: [seaRow("202610210000", "22001", "0.5", "-99", "-99.0", "21.6")], buoy1: [] });
    const stored = rebuildMatrix(skeleton, root);
    expect(diffMatrix(stored, root).diffs).toEqual([]);
    stored.stations[0].metrics.wind = { ...stored.stations[0].metrics.wind, state: "VALUE_PRESENT", value: { direction_deg: 0, speed_ms: 0 } };
    expect(diffMatrix(stored, root).diffs).toEqual(["22001 wind"]);
  });

  it("HTTP 200 수신이 아닌 시도나 한쪽 응답만 있는 회차는 거부함", () => {
    const root = fixture({ sea1: [], buoy1: [], sea2: [] });
    expect(() => rebuildMatrix(skeleton, root)).toThrow(/2회차에 sea_obs·kma_buoy 응답이 모두 있지 않음/);
  });
});
