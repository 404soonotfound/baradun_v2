// 대표 사진 공공누리 유형 다시 확인 (BRD-58, 결정 기록 11장 10/21·2026-10-23 사용자 결정)
// TourAPI 응답(JSON.parse 결과)에서 그 사진의 유형만 읽음. 1유형(Type1)만 허용
// 사진을 찾지 못하면 missing(관광지 대표 이미지가 바뀌었거나 사진이 빠짐). 응답이 정상이 아니면 failed(확인 결과 아님)

import { responseItems } from "../warnings/response-items";

// first = 관광지 대표 이미지(detailCommon2), detail = 상세 이미지 목록(detailImage2)
export type PhotoImage = "first" | "detail";

export type PhotoCheck =
  | { status: "type1" | "not_type1" | "missing" }
  | { status: "failed"; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// http·https 차이는 같은 사진으로 봄(저장소에는 https로 넣음)
export function sameImage(a: unknown, b: string): boolean {
  return (
    typeof a === "string" &&
    a !== "" &&
    a.replace(/^https?:\/\//, "") === b.replace(/^https?:\/\//, "")
  );
}

const typeOf = (item: Record<string, unknown>) =>
  item.cpyrhtDivCd === "Type1" ? "type1" : "not_type1";

export function checkPhoto(
  json: unknown,
  image: PhotoImage,
  url: string,
  contentId: string,
): PhotoCheck {
  const response = isObject(json) ? json.response : undefined;
  const header = isObject(response) ? response.header : undefined;
  if (!isObject(header)) return { status: "failed", reason: "format:header" };
  // TourAPI 정상은 "0000"
  if (header.resultCode !== "0000") {
    return {
      status: "failed",
      reason: `resultCode:${String(header.resultCode ?? "")}`,
    };
  }
  const body = isObject(response) ? response.body : undefined;
  // 결과 0건이면 items가 빈 글자로 옴 → 관광지가 없어짐(missing). 그 밖의 모양은 형식 오류(missing으로 읽지 않음)
  const items =
    responseItems(json) ?? (isObject(body) && body.items === "" ? [] : null);
  if (items === null || !items.every(isObject)) {
    return { status: "failed", reason: "format:items" };
  }

  if (image === "first") {
    const item = items.find((i) => String(i.contentid) === contentId);
    // contentId를 지정해 조회했으니 관광지가 없어지면 0건(빈 items)으로 옴
    // 행이 있는데 그 contentid가 없으면 형식 이상(필드가 바뀐 응답일 수 있음) → 사진을 지우는 근거로 쓰지 않음
    if (!item) {
      return items.length === 0
        ? { status: "missing" }
        : { status: "failed", reason: "format:contentid" };
    }
    return sameImage(item.firstimage, url)
      ? { status: typeOf(item) }
      : { status: "missing" };
  }
  const item = items.find((i) => sameImage(i.originimgurl, url));
  if (item) return { status: typeOf(item) };
  // 목록이 잘렸으면(전체 수 > 받은 수) 뒤쪽에 있을 수 있음 → 못 찾았다고 확정하지 않음
  const total = isObject(body) ? Number(body.totalCount) : NaN;
  if (Number.isFinite(total) && total > items.length) {
    return { status: "failed", reason: `truncated:${items.length}/${total}` };
  }
  return { status: "missing" };
}
