// 아는 기관 표 (BRD-113). 데이터에 오는 기관 이름(한국어 원문)을 여기서만 비교함
// 화면 이름은 문구 키(observation.agency.<key>), 모르는 기관은 지어내지 않고 원문 그대로 씀

export const AGENCY = {
  kma: "기상청",
  khoa: "국립해양조사원",
  kto: "한국관광공사",
} as const;

export type AgencyKey = keyof typeof AGENCY;

// 원문 이름 → 아는 기관 키. 모르면 null
export function agencyKeyOf(source: string): AgencyKey | null {
  for (const key of Object.keys(AGENCY) as AgencyKey[]) {
    if (AGENCY[key] === source) return key;
  }
  return null;
}

// 출처 원문 주소(공공누리 제1유형: 링크가 가능하면 출처 링크 제공). 데이터 출처 화면·화면 출처 줄이 같이 씀
export const SOURCE_URL = {
  ripCurrent: "https://www.data.go.kr/data/15156028/openapi.do", // 국립해양조사원 이안류 지수 조회
  surfing: "https://www.data.go.kr/data/15142490/openapi.do", // 국립해양조사원 서핑지수 조회
  tourApi: "https://www.data.go.kr/data/15101578/openapi.do", // 한국관광공사 국문 관광정보 서비스(TourAPI)
} as const;
