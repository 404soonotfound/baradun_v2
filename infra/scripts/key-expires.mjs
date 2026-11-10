#!/usr/bin/env node
// 인증키 만료일 태그 (GH-382): npm run keys:expires -- <키 이름> <YYYY-MM-DD> [--profile <AWS 프로필>]
// 운영 데이터 출처 화면(/ops/sources)이 SSM 파라미터 태그 expires=YYYY-MM-DD(KST 날짜)로 만료일·남은 날을 보여 줌
// - 키 값은 읽지도 바꾸지도 않음. 태그만 달고 다시 읽어 확인함
// - 키를 갱신할 때만 씀(배포마다 하는 일 아님)
import { spawnSync } from "node:child_process";
import { API_KEY_NAMES, API_KEY_PARAMETER_PREFIX } from "../lib/settings.ts";
import { isCalendarDate, KEY_EXPIRES_TAG, REGION } from "./deploy-plan.ts";

function fail(message) {
  console.error(`\n[멈춤] ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const profileAt = args.indexOf("--profile");
let profile = process.env.AWS_PROFILE ?? "soo-login";
if (profileAt >= 0) {
  profile = args[profileAt + 1];
  if (!profile || profile.startsWith("--"))
    fail("--profile 뒤에 값을 써 주세요");
  args.splice(profileAt, 2);
}
const [name, date] = args;
const usage = `사용법: npm run keys:expires -- <${API_KEY_NAMES.join("|")}> <YYYY-MM-DD>`;
if (!name || !date || args.length !== 2) fail(usage);
if (!API_KEY_NAMES.includes(name)) {
  fail(`모르는 키 이름이에요: ${name}\n${usage}`);
}
if (!isCalendarDate(date)) {
  fail(`날짜는 달력에 있는 YYYY-MM-DD(KST)로 써 주세요: ${date}`);
}
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
}).format(new Date());
if (date < today) {
  console.warn(
    `   주의: ${date}는 오늘(${today}, KST)보다 앞이에요. 화면에 '만료일 지남'으로 보여요.`,
  );
}

const env = { ...process.env, AWS_PROFILE: profile, AWS_REGION: REGION };
for (const key of [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]) {
  delete env[key];
}
const aws = (cmdArgs) => {
  const result = spawnSync(
    "aws",
    [...cmdArgs, "--region", REGION, "--output", "json"],
    {
      env,
      encoding: "utf8",
    },
  );
  if (result.error) fail(`aws를 실행하지 못했어요: ${result.error.message}`);
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    fail(
      `aws ${cmdArgs.slice(0, 2).join(" ")} 실패. 로그인이 필요하면: aws login --profile ${profile}`,
    );
  }
  return result.stdout;
};

const parameter = `${API_KEY_PARAMETER_PREFIX}${name}`;
aws([
  "ssm",
  "add-tags-to-resource",
  "--resource-type",
  "Parameter",
  "--resource-id",
  parameter,
  "--tags",
  `Key=${KEY_EXPIRES_TAG},Value=${date}`,
]);
const tags =
  JSON.parse(
    aws([
      "ssm",
      "list-tags-for-resource",
      "--resource-type",
      "Parameter",
      "--resource-id",
      parameter,
    ]),
  ).TagList ?? [];
const saved = tags.find((t) => t.Key === KEY_EXPIRES_TAG)?.Value;
if (saved !== date)
  fail(`태그를 다시 읽었는데 값이 달라요: ${saved ?? "없음"}`);
// 대소문자만 다른 태그(Expires 등)가 남아 있으면 화면이 '형식 오류'로 볼 수 있어 알림
const stray = tags.filter(
  (t) =>
    t.Key !== KEY_EXPIRES_TAG &&
    t.Key?.trim().toLowerCase() === KEY_EXPIRES_TAG,
);
if (stray.length > 0) {
  console.warn(
    `   주의: 대소문자만 다른 태그 ${stray.map((t) => t.Key).join(", ")}가 남아 있어요. 지우려면:\n` +
      `   aws ssm remove-tags-from-resource --resource-type Parameter --resource-id ${parameter} --tag-keys ${stray.map((t) => t.Key).join(" ")}`,
  );
}
console.log(`${parameter}: ${KEY_EXPIRES_TAG}=${date} 확인`);
