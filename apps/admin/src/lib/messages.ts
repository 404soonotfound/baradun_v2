import ko from "../../messages/ko.json";

// 운영자 화면 문구 키 (BRD-147). 화면 문구를 코드에 직접 쓰지 않음
// 운영자 화면 언어는 한국어 하나로 시작함. 영어가 필요해지면 문구 파일을 늘림
export const messages = ko;

// 문구의 {이름} 자리를 값으로 바꿈
export function fill(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) =>
    key in values ? String(values[key]) : all,
  );
}
