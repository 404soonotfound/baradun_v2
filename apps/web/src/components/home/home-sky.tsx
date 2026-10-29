// 홈 바다 배경 (노션 4장 1절 '바다 배경 (홈)'·7절 밤바다, BRD-129). 꾸밈이라 화면 읽기에서 숨김
// 색은 모두 토큰(color.home.*)이라 다크에서 밤바다로 바뀜. 물결 경로는 Figma 원본 그대로

// 모바일(Figma s.homebg 171:380): 화면 맨 위부터 620px 그라데이션 + 150px 아래 흰 물결 3겹(390×360)
// 본문 위 여백(pt-5, 홈 화면 추가는 노치만큼 더)과 좌우 여백만큼 밖으로 넓혀 화면 끝까지 칠함
export function HomeSky() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute -top-5 -right-gutter -left-gutter -z-10 h-[620px] bg-home-sky standalone:-top-[calc(20px+env(safe-area-inset-top))] lg:hidden"
    >
      <svg
        className="home-wave-fade absolute inset-x-0 top-[150px] h-[360px] w-full"
        viewBox="0 0 390 360"
        preserveAspectRatio="none"
      >
        <path
          d="M0 110C60 94 110 94 170 108C230 122 290 124 390 102V360H0V110Z"
          className="fill-home-wave-1"
        />
        <path
          d="M0 160C70 142 130 148 200 162C270 176 320 176 390 154V360H0V160Z"
          className="fill-home-wave-2"
        />
        <path
          d="M0 220C80 204 150 212 220 224C290 236 330 234 390 216V360H0V220Z"
          className="fill-home-wave-3"
        />
      </svg>
    </div>
  );
}

// PC 히어로 아래 물결(Figma 181:776, 1280×120). 맨 앞 물결은 화면 바탕색이라 아래 묶음과 이어짐
export function HeroWaves() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-[120px] w-full lg:block"
      viewBox="0 0 1280 120"
      preserveAspectRatio="none"
    >
      <path
        d="M0 46C160 20 320 20 480 44C640 68 800 70 960 44C1120 18 1200 18 1280 34V120H0V46Z"
        className="fill-home-hero-wave-1"
      />
      <path
        d="M0 70C200 48 360 52 560 72C760 92 900 92 1080 70C1260 48 1240 56 1280 62V120H0V70Z"
        className="fill-home-hero-wave-2"
      />
      <path
        d="M0 92C220 76 420 80 640 94C860 108 1040 108 1280 88V120H0V92Z"
        className="fill-bg-page"
      />
    </svg>
  );
}
