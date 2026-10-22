// data.go.kr 응답(JSON.parse 결과)의 행 목록 꺼내기. getPwnCd·getTsunamiMsg·수집기 저장이 같은 규칙을 씀
// 모양: { response: { body: { items: { item } } } }. 행이 여러 개면 배열, 한 개면 객체로 옴 → 배열로 맞춤
// 목록 자리가 없으면 null(빈 목록으로 바꾸지 않음). 행 하나하나의 모양 검사는 부르는 쪽이 함

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function responseItems(json: unknown): unknown[] | null {
  const response = isObject(json) ? json.response : undefined;
  const body = isObject(response) ? response.body : undefined;
  const items = isObject(body) ? body.items : undefined;
  const item = isObject(items) ? items.item : undefined;
  return Array.isArray(item) ? item : isObject(item) ? [item] : null;
}
