// 첫 실행 안내(ON-1) 고지 문구 버전 (BRD-25). messages의 onboarding.notice 문구나 처리방침(terms.privacy)이 바뀌면 1 올림 → 모든 기기가 다시 봄
// 약관 화면(/terms, BRD-36 · 서버 부품)이 같은 값을 보여줘야 해서 React 훅이 없는 이 파일에 둠
// 2: 처리방침에 '이용 통계와 쿠키'(Google Analytics) 절 추가 (BRD-143, 2026-11-02)
// 3: 이용 안내·개인정보 처리방침 전문과 첫 실행 고지 갱신 (BRD-64). 2는 이미 배포돼 2로 확인한 기기도 다시 봄
// 4: 처리방침 '7. 쿠키와 분석 도구'에 확장 이용 통계 이벤트(기능 이용 기록) 안내 반영 (BRD-68)
export const NOTICE_VERSION = 4;
