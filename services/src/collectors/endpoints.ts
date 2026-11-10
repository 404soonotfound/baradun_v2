// 수집기 호출 주소와 날씨 발표 시각(아키텍처 5장). 수집기와 운영 API(데이터 출처 화면)가 함께 씀
// 값만 둠(다른 모듈을 가져오지 않음) → 운영 API 묶음에 수집기 코드가 들어가지 않음

export const ENDPOINTS = {
  // 기상청 기상특보(getPwnCd)·지진해일 통보(getTsunamiMsg)
  pwncd: "https://apis.data.go.kr/1360000/WthrWrnInfoService/getPwnCd",
  tsunami: "https://apis.data.go.kr/1360000/EqkInfoService/getTsunamiMsg",
  // 기상청 API허브 해양 관측(sea_obs.php·kma_buoy.php)
  oceanBase: "https://apihub.kma.go.kr/api/typ01/url/",
  // 국립해양조사원 이안류 지수
  rip: "https://apis.data.go.kr/1192136/ripCurrent/GetRipCurrentApiService",
  // 기상청 단기예보(실황·단기)·중기예보
  weatherShort: "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/",
  weatherMid: "https://apis.data.go.kr/1360000/MidFcstInfoService/",
  // 한국관광공사 TourAPI
  catalog: "https://apis.data.go.kr/B551011/KorService2",
} as const;

// 날씨 발표 시(KST). 실황은 매시, 단기예보 하루 8회, 중기예보 하루 2회
export const WEATHER_ISSUE_HOURS = {
  now: Array.from({ length: 24 }, (_, h) => h),
  short: [2, 5, 8, 11, 14, 17, 20, 23],
  mid: [6, 18],
} as const;
