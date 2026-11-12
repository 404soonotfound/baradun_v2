#!/usr/bin/env node
// 게시 함수를 사람이 직접 부르는 도구 (결정 기록 D20-1~4, #256·#331). 의존성 없이 node와 AWS CLI만 씀
// 사용:
//   node tools/republish/republish.mjs --function <PublisherFunctionName> --version <게시 버전> [--action republish|rollback] [--yes]
// - republish(기본, 급할 때만): 옛 게시 파일을 내용 그대로 새 버전 번호로 다시 내보냄(D20-4)
//   관측·확인 시각을 고치지 않으므로 시간이 지나면 화면은 '판단불가'로 보여줌. 게시 코드 오류의 기준 복구는 git revert 배포
// - rollback: 되돌리기. 공지만 그 게시본 때 상태로 되살리고 특보·관측은 지금 수집 사실로 새로 게시(D20-1~3)
// --yes를 주지 않으면 부를 명령만 보여 주고 끝남(아무것도 부르지 않음). --yes를 주면 aws lambda invoke를 실행함
// S3·DynamoDB 쓰기는 게시 함수(publisher 역할) 하나만 함(아키텍처 6.2 단일 작성자)
// → 이 도구를 쓰는 사람에게는 그 함수의 lambda:InvokeFunction 권한만 있으면 됨. 비밀값을 읽거나 남기지 않음
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VERSION_PATTERN = /^\d{8}T\d{6}Z$/;
// Lambda 함수 이름 또는 ARN에 쓰이는 글자만(셸을 거치지 않지만 잘못 붙여 넣은 값을 먼저 걸러냄)
export const FUNCTION_PATTERN = /^[A-Za-z0-9_:-]{1,170}$/;
export const ACTIONS = ["republish", "rollback"];

export function parseArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(`--${name}`);
    const next = i >= 0 ? argv[i + 1] : undefined;
    return next !== undefined && !next.startsWith("--") ? next : undefined;
  };
  const functionName = value("function");
  const version = value("version");
  const action = value("action") ?? "republish";
  if (!functionName || !FUNCTION_PATTERN.test(functionName)) {
    throw new Error(
      "--function <게시 함수 이름>을 주세요(스택 출력 PublisherFunctionName)",
    );
  }
  if (!version || !VERSION_PATTERN.test(version)) {
    throw new Error(
      "--version은 게시 버전 형식이어야 해요(예: 20261017T053000Z)",
    );
  }
  if (!ACTIONS.includes(action)) {
    throw new Error(`--action은 ${ACTIONS.join(" 또는 ")}만 받아요`);
  }
  return { functionName, version, action, yes: argv.includes("--yes") };
}

// aws CLI 인자. 응답은 파일 대신 화면(/dev/stdout)으로 받아 작업 폴더에 파일이 남지 않게 함
export function invokeArgs({ functionName, version, action }) {
  return [
    "lambda",
    "invoke",
    "--function-name",
    functionName,
    "--cli-binary-format",
    "raw-in-base64-out",
    "--payload",
    JSON.stringify({ action, version }),
    "/dev/stdout",
  ];
}

const NOTES = {
  republish: [
    "옛 게시 파일을 내용 그대로 새 버전 번호로 다시 내보내요(급할 때만).",
    "관측·확인 시각은 고치지 않아요. 시간이 지나면 화면은 '판단불가'로 보여줘요.",
    "수집 일정을 멈추지 않으면 다음 자동 게시가 다시 덮어요(infra/README).",
  ],
  rollback: [
    "공지만 그 게시본 때 상태로 되살리고, 특보·관측은 지금 수집 사실로 새로 게시해요.",
    "되돌린 공지는 다시 적용하기 전까지 자동 게시에 실리지 않아요.",
  ],
};

export function main(argv = process.argv.slice(2), run = spawnSync) {
  const args = parseArgs(argv);
  const cli = invokeArgs(args);
  for (const line of NOTES[args.action]) console.log(`- ${line}`);
  // 값에 따옴표·공백이 없음을 위에서 확인했으므로 payload만 작은따옴표로 감싸 보여 줌
  console.log(
    `\naws ${cli.map((part) => (part.startsWith("{") ? `'${part}'` : part)).join(" ")}\n`,
  );
  if (!args.yes) {
    console.log("부르지 않았어요. 실행하려면 --yes를 붙여 다시 실행하세요.");
    return 0;
  }
  const result = run("aws", cli, { stdio: "inherit" });
  if (result.error) throw result.error;
  // 게시 함수는 실패를 오류로 던짐 → 응답에 FunctionError가 보이면 로그 그룹(BaradunV2-PublishLogs…)을 확인
  return result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
