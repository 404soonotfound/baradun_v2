# @baradun/design-tokens

사용자 사이트(`apps/web`)와 운영자 사이트(`apps/admin`)가 함께 쓰는 디자인 토큰이에요(결정 기록 D17-3). 앱끼리 공유는 `packages/contracts`로만 한다는 규칙의 예외라서, 이 패키지에는 토큰 값과 그 값을 만드는·검사하는 도구만 둬요. 데이터·판단 코드·화면 코드는 넣지 않아요.

- `tokens.json`: 원본 한 파일이에요. 라이트는 `$value`, 다크는 `$extensions.baradun.dark`에 둬요.
- `baradun-tokens <CSS 경로>`: Tailwind 4 테마 변수 CSS를 만들어요. 각 앱의 `npm run tokens`가 불러요.
- `baradun-tokens-check`: 대비 기준과 금지 색을 검사해요(`npm run check:tokens -w apps/web`, CI).
- 앱 코드에서 값이 필요하면 `@baradun/design-tokens/tokens.json`을 가져와요. 빌드 때 묶이므로 앱의 devDependencies에 둬요.
