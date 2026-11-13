import { spawnSync } from "node:child_process";
import path from "node:path";

const required = {
  web: [
    ["a11y.spec.ts", "light › ko › /"],
    ["csp.spec.ts", "홈(/)에서 CSP 위반 및 하이드레이션 오류가 없다"],
    ["flows.spec.ts", "접수되면 완료를 알리고 임시 저장을 지움"],
    ["states.spec.ts", "'특보 없음' 자리마다 근거와 현장 우선 문구 /"],
    ["states.spec.ts", "이용불가는 실제 사유(풍랑주의보)를 먼저 보여줌"],
    ["states.spec.ts", "관측 지연이면 지난 파고 값을 숨기고 지연이라고 알림"],
    ["states.spec.ts", "처음 열 때 못 받으면 확인 못 함·다시 시도"],
    ["states.spec.ts", "futureConfirm › '특보 없음'을 보여주지 않음"],
    ["states.spec.ts", "missingWarning › '특보 없음'을 보여주지 않음"],
    ["states.spec.ts", "홈: 끊긴 동안 '특보 없음'을 보여주지 않음"],
  ],
  admin: [
    ["inquiries.spec.ts", "처리: 반려는 이유가 있어야 저장되고"],
    ["login.spec.ts", "Trusted Types가 켜져 있고 default 정책 하나만 있다"],
    ["login.spec.ts", "로그인하지 않고 운영 화면에 오면 로그인으로 보낸다"],
    ["login.spec.ts", "비밀번호 → 인증 앱 코드(틀림 → 맞음)"],
    ["notices.spec.ts", "새 공지: 한국 시간으로 쓴 기간을 UTC로 보내고"],
    ["publish.spec.ts", "지금 게시: 확인 창(취소에 먼저 포커스)"],
    ["publish.spec.ts", "편집 권한은 지금 게시·되돌리기·다시 적용을 비활성"],
    ["publish.spec.ts", "데모 계정은 데이터 게시를 볼 수 없다고 알리고"],
    ["shell.spec.ts", "메뉴 순서·지금 화면 표시"],
    ["shell.spec.ts", "운영 홈·준비 중 화면 접근성과 가로 스크롤 없음 (light)"],
  ],
};

const app = process.argv[2];
if (!(app in required)) throw new Error("앱은 web 또는 admin이어야 합니다.");
const result = spawnSync(
  "npx",
  ["--no-install", "playwright", "test", "--grep", "@smoke", "--list"],
  {
    cwd: path.resolve(`apps/${app}`),
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || result.stdout);

const lines = result.stdout.split("\n");
for (const project of ["mobile", "desktop"]) {
  for (const [file, title] of required[app]) {
    if (
      !lines.some(
        (line) =>
          line.includes(`[${project}]`) &&
          line.includes(`› ${file}:`) &&
          line.includes(title),
      )
    ) {
      throw new Error(
        `${app} ${project} 핵심 E2E가 빠졌습니다: ${file} › ${title}`,
      );
    }
  }
}
console.log(`${app}: 핵심 E2E ${required[app].length * 2}건 확인`);
