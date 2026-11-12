# @baradun/design-tokens

사용자 사이트(`apps/web`)와 운영자 사이트(`apps/admin`)가 함께 쓰는 디자인 토큰이에요(결정 기록 D17-3). 앱끼리 공유는 `packages/contracts`로만 한다는 규칙의 예외라서, 이 패키지에는 토큰 값과 그 값을 만드는·검사하는 도구만 둬요. 데이터·판단 코드·화면 코드는 넣지 않아요.

- `tokens.json`: 원본 한 파일이에요. 라이트는 `$value`, 다크는 `$extensions.baradun.dark`에 둬요.
- `baradun-tokens <CSS 경로> [--admin]`: Tailwind 4 테마 변수 CSS를 만들어요. 각 앱의 `npm run tokens`가 불러요. `--admin`은 운영자 사이트만 넘겨요.
- `color.success.*`(bg·fg·border·icon)는 운영자 사이트 전용 작업 성공색이에요(저장·게시 완료·수집 정상, 결정 E6·BRD-165). 초록이라 노션 4장 '초록은 쓰지 않아요'의 예외예요. `--admin`일 때만 CSS에 나가서 사용자 사이트에서는 쓸 수 없어요. 해변 '특보 없음'(파랑 `status.clear`)과 섞어 쓰지 않아요.
- `baradun-tokens-check`: 대비 기준과 금지 색을 검사해요(`npm run check:tokens -w apps/web`, CI).
- `admin-`로 시작하는 크기·모서리 토큰(`h-admin-control`·`rounded-admin-box` 등)은 운영자 사이트에서만 써요. 운영 화면 시안 4차 S3의 촘촘한 값(버튼·입력 36, 모서리 4·6·8)을 담고 있어요(BRD-173). 색·글자는 두 사이트가 같은 토큰을 써요.
- 앱 코드에서 값이 필요하면 `@baradun/design-tokens/tokens.json`을 가져와요. 빌드 때 묶이므로 앱의 devDependencies에 둬요.
