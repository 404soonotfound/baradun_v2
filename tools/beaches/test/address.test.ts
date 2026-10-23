import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { addressLocality, legalLocalities, legalNameSet } from "../address.mjs";
import { annex9Lookup } from "../annex.mjs";
import { linkOfficial, linkOfficials, normName } from "../official-link.mjs";

const legalRows = legalLocalities([
  "경상북도 포항시 남구 구룡포읍", "경상북도 포항시 북구 흥해읍", "경상북도 포항시 북구 청하면",
  "전남광주통합특별시 여수시 만흥동", "전남광주통합특별시 여수시 삼산면", "전남광주통합특별시 고흥군 도양읍",
  "인천광역시 영종구 을왕동", "인천광역시 중구 신흥동1가",
  "경상남도 창원시 진해구 명동", "강원특별자치도 강릉시 강문동", "강원특별자치도 강릉시 사천면",
]);

describe("주소를 현행 법정 읍면동·시도·시군·구와 대조", () => {
  it("읍면동 없는 도로명 주소도 명시된 구가 존재하지 않으면 거부함", () => {
    expect(addressLocality("경상북도 포항시 가짜구 해안로 1", "경북", "포항시", legalRows)).toMatchObject({ status: "INVALID_LOCALITY" });
    expect(addressLocality("경상북도 포항시 남구 해안로 1", "경북", "포항시", legalRows)).toMatchObject({ status: "NO_LOCALITY" });
  });
  it("구가 있는 시의 읍면과 구 소속을 검증함", () => {
    const r = addressLocality("경상북도 포항시 남구 구룡포읍 1", "경북", "포항시", legalRows);
    expect(r).toMatchObject({ status: "VERIFIED_LOCALITY", locality: "구룡포읍", district: "남구" });
    expect(r.rows).toHaveLength(1);
    expect(addressLocality("포항시 남구 흥해읍 1", "경북", "포항시", legalRows).status).toBe("INVALID_LOCALITY");
  });
  it("괄호 안 동과 건물명이 붙은 동을 집합에서 검증함", () => {
    for (const addr of ["여수시 망양로 1 (만흥동)", "여수시 망양로 1 (만흥동, 아파트)"])
      expect(addressLocality(addr, "전남", "여수시", legalRows)).toMatchObject({ status: "VERIFIED_LOCALITY", locality: "만흥동" });
  });
  it.each(["여수시 도양읍 1", "여수시 없는면 1", "경상북도 여수시 삼산면 1", "고흥군 삼산면 1"])("다른 시군 읍면·없는 읍면·다른 시도 %s를 거부함", (addr) => {
    const r = addressLocality(addr, "전남", "여수시", legalRows);
    expect(r.status).toBe("INVALID_LOCALITY");
    expect(r.rows).toBeUndefined();
  });
  it("인천 중구→영종구는 현행 이름으로 대조한 뒤 별표를 조회함", () => {
    const r = addressLocality("인천광역시 영종구 을왕동 1", "인천", "중구", legalRows);
    expect(r).toMatchObject({ status: "VERIFIED_LOCALITY", sigungu: "영종구", locality: "을왕동" });
    expect(r.rows).toHaveLength(1);
  });
  it("공식 저장본의 개편 전 인천 중구 주소도 명시된 영종구 별칭으로 검증함", () => {
    expect(addressLocality("인천 중구 을왕동 810-97", "인천", "중구", legalRows)).toMatchObject({ status: "VERIFIED_LOCALITY", sigungu: "영종구", locality: "을왕동" });
  });
  it("창원의 검증된 읍면동도 별표 키가 없으면 구역을 추정하지 않음", () => {
    const r = addressLocality("경상남도 창원시 진해구 명동 1", "경남", "창원시", legalRows);
    expect(r.status).toBe("VERIFIED_LOCALITY");
    expect(r.rows).toEqual([]);
  });
  it("all·제외목록도 법정 이름 집합에 없는 이름으로 확정하지 않음", () => {
    const set = legalNameSet(legalRows);
    expect(annex9Lookup("강원", "강릉시", "없는면", set)).toEqual([]);
    expect(annex9Lookup("전남", "여수시", "없는동", set)).toEqual([]);
    expect(annex9Lookup("전남", "여수시", "만흥동")).toEqual([]);
  });
  it("읍면이 없는 도로명 주소는 미독해로 남기며 복수 후보는 거부함", () => {
    expect(addressLocality("여수시 망양로 1", "전남", "여수시", legalRows).status).toBe("NO_LOCALITY");
    expect(addressLocality("여수시 삼산면 1 (만흥동)", "전남", "여수시", legalRows).status).toBe("INVALID_LOCALITY");
  });
});

const entries = JSON.parse(readFileSync(new URL("../name-map-2026.json", import.meta.url), "utf8")).entries;
const src = (name, sigungu = "고성군", sido = "강원") => ({ sido_nm: sido, gugun_nm: sigungu, sta_nm: name });
const row = (name, id = 1, sigungu = "고성군", sido = "강원") => ({ name, row: id, sigungu, sido });
describe("이름 중간의 리·진을 지우지 않는 공식 이름 연결", () => {
  it("사천과 사천진은 다르고, 리·진이 들어간 지명도 그대로 유지함", () => {
    expect(normName("사천")).not.toBe(normName("사천진"));
    expect(normName("진리해수욕장")).toBe("진리");
    expect(linkOfficial(src("사천", "강릉시"), [row("사천진", 1, "강릉시")], entries).method).toBe("UNLINKED");
  });
  it.each([["공현1리", "공현진1리"], ["공현2리", "공현진2리"], ["가진리", "가진"], ["교암리", "교암"], ["반암리", "반암"], ["초도리", "초도"]])("기존 예외 %s↔%s는 명시 대응표로 유지함", (from, to) => {
    expect(linkOfficial(src(from), [row(to)], entries)).toMatchObject({ method: "MAP", row: { name: to } });
  });
  it("복수 후보·중복 대응표·한 공식 행의 복수 해변 연결을 거부함", () => {
    expect(linkOfficial(src("공현1리"), [row("공현진1리"), row("공현진1리", 2)], entries).method).toBe("UNLINKED");
    expect(linkOfficial(src("공현1리"), [row("공현진1리")], [...entries, entries.find((e) => e.key === "강원|고성군|공현1리")]).method).toBe("UNLINKED");
    const links = linkOfficials([src("공현1리"), src("공현진1리")], [row("공현진1리")], entries);
    expect([...links.values()].map((l) => l.method)).toEqual(["UNLINKED", "UNLINKED"]);
  });
  it("RULE 후보가 2개일 때 대응표가 그 후보 중 하나를 고를 때만 연결하고 그 밖에는 UNLINKED를 유지함", () => {
    const candidates = [row("화진포(거진)", 56), row("화진포(현내)", 57), row("초도", 58)];
    expect(linkOfficial(src("화진포"), candidates, entries)).toMatchObject({
      method: "MAP",
      row: { name: "화진포(거진)", row: 56 },
    });
    expect(linkOfficial(src("화진포"), candidates, [])).toMatchObject({
      method: "UNLINKED",
      candidates: ["화진포(거진)(56행)", "화진포(현내)(57행)"],
    });
    expect(linkOfficial(src("화진포"), candidates, [{ key: "강원|고성군|화진포", xlsx_name: "초도", basis: "후보 밖 이름" }])).toMatchObject({
      method: "UNLINKED",
      candidates: ["화진포(거진)(56행)", "화진포(현내)(57행)"],
    });
  });
});
