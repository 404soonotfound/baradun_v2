import { describe, expect, it } from "vitest";
// services 쪽 값도 가져와서 infra 설정과 맞는지 비교함(한쪽만 바뀌면 테스트가 깨짐)
import { COLLECT_POLICY } from "../../services/src/collectors/policy";
import { API_KEY_PARAMETER_PREFIX as SERVICES_KEY_PREFIX } from "../../services/src/core/secrets/api-keys";
import {
  API_KEY_PARAMETER_PREFIX,
  COLLECTOR_SCHEDULE_MINUTES,
  COLLECTOR_TIMEOUT_SECONDS,
} from "../lib/settings";
import {
  allIamPolicies,
  resourceText,
  template,
  toList,
} from "./stack-template";

// 수집 Lambda·실행 일정·권한 테스트 (BRD-56 PR ②)
// template = CDK가 만든 CloudFormation 템플릿(JSON). AWS에 배포하지 않고 이 JSON 내용만 검사함

// 템플릿 안 리소스 하나의 모양. Properties는 리소스 종류마다 달라서 any(아무 값)로 둠
type Resource = { Type: string; Properties: Record<string, any> };
// 템플릿의 모든 리소스. "리소스 ID → 내용" 목록
const resources = template.toJSON().Resources as Record<string, Resource>;

// 수집 함수의 리소스 ID 찾기
// CDK는 ID 뒤에 무작위처럼 보이는 글자를 붙임(예: CollectOceanFunction1AAA04CC) → 앞부분으로 찾음
function functionId(name: "Ocean" | "Warnings"): string {
  const ids = Object.keys(
    template.findResources("AWS::Lambda::Function"),
  ).filter((id) => id.startsWith(`Collect${name}Function`));
  expect(ids).toHaveLength(1); // 정확히 하나여야 함
  return ids[0]!; // !: "여기는 값이 꼭 있음"이라고 타입 검사에 알려 줌(바로 위에서 확인)
}

// 함수가 쓰는 권한 묶음(역할, Role)의 리소스 ID
// 템플릿에는 {"Fn::GetAtt": ["역할ID", "Arn"]} 모양으로 들어 있음 → 첫 칸이 역할 ID
function roleOf(fnId: string): string {
  return resources[fnId]!.Properties.Role["Fn::GetAtt"][0];
}

// 역할이 허락받은 동작 목록을 "동작 → 그 동작을 할 수 있는 리소스 주소들"로 모음
// 예: "dynamodb:GetItem" → ["StorageStateTable08B675A0.Arn"]
function allowedActions(role: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const policy of allIamPolicies().filter((p) => p.roles.includes(role))) {
    for (const s of policy.statements.filter((x) => x.Effect === "Allow")) {
      for (const action of toList(s.Action)) {
        result.set(action, [
          ...(result.get(action) ?? []), // 앞에서 모은 것(없으면 빈 목록)
          ...toList(s.Resource).map(resourceText), // 이번 문장의 리소스 주소
        ]);
      }
    }
  }
  return result;
}

describe("수집 Lambda", () => {
  // it.each: 목록의 값마다 같은 테스트를 한 번씩 돌림. %s 자리에 값이 들어감
  it.each(["Ocean", "Warnings"] as const)(
    "%s: Node 22·ARM 칩·시간 제한·테이블 이름 설정",
    (name) => {
      const p = resources[functionId(name)]!.Properties;
      expect(p.Runtime).toBe("nodejs22.x");
      expect(p.Architectures).toEqual(["arm64"]);
      expect(p.Timeout).toBe(COLLECTOR_TIMEOUT_SECONDS);
      // 함수가 읽는 설정값은 테이블 이름 두 개뿐
      expect(Object.keys(p.Environment.Variables).sort()).toEqual([
        "OPS_TABLE_NAME",
        "STATE_TABLE_NAME",
      ]);
    },
  );

  it("시간 제한(60초)이 '내가 함' 표시 시간(2분)보다 짧다", () => {
    // 짧아야 한 실행이 끝나기 전에 다른 실행이 같은 시간대를 맡지 않음(settings.ts 설명)
    expect(COLLECTOR_TIMEOUT_SECONDS * 1000).toBeLessThan(
      COLLECT_POLICY.slotLeaseMs,
    );
  });
});

describe("실행 일정 (N3)", () => {
  // services의 주기 설정(예: 30분마다, 10분 시작)으로 "매시 몇 분" 글자를 만듦
  // 예: { periodMinutes: 30, offsetMinutes: 10 } → "10,40"
  function minutesOf(schedule: {
    periodMinutes: number;
    offsetMinutes: number;
  }): string {
    const minutes: number[] = [];
    // 시작 분부터 주기만큼 더해 가며 60분 전까지 모음
    for (let m = schedule.offsetMinutes; m < 60; m += schedule.periodMinutes)
      minutes.push(m);
    return minutes.join(",");
  }

  it("infra 실행 분이 services의 주기 설정과 같다", () => {
    expect(COLLECTOR_SCHEDULE_MINUTES.ocean).toBe(
      minutesOf(COLLECT_POLICY.oceanSchedule),
    );
    expect(COLLECTOR_SCHEDULE_MINUTES.warnings).toBe(
      minutesOf(COLLECT_POLICY.warningsSchedule),
    );
  });

  it.each([
    ["Ocean", "cron(10,40 * * * ? *)"],
    ["Warnings", "cron(3,18,33,48 * * * ? *)"],
  ] as const)("%s: %s 한국 시각으로 그 함수를 실행한다", (name, expression) => {
    // 일정 중에서 대상(Target)이 이 함수인 것만 고름
    const schedules = Object.values(
      template.findResources("AWS::Scheduler::Schedule"),
    ).filter(
      (s) =>
        resourceText(s.Properties.Target.Arn) === `${functionId(name)}.Arn`,
    );
    expect(schedules).toHaveLength(1);
    expect(schedules[0]!.Properties.ScheduleExpression).toBe(expression);
    expect(schedules[0]!.Properties.ScheduleExpressionTimezone).toBe(
      "Asia/Seoul",
    );
  });
});

describe("수집 함수 권한 (필요한 것만)", () => {
  it.each([
    ["Ocean", "kma-apihub"],
    ["Warnings", "data-go-kr"],
  ] as const)(
    "%s: State 읽기·쓰기, Ops 기록, 자기 API 키(%s) 읽기만 할 수 있다",
    (name, key) => {
      const actions = allowedActions(roleOf(functionId(name)));
      // 허락된 동작은 정확히 이 4개
      // 로그 쓰기 권한은 AWS가 미리 만들어 둔 정책(AWSLambdaBasicExecutionRole)을 붙이는 방식이라 이 목록에 안 나옴
      expect([...actions.keys()].sort()).toEqual([
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "ssm:GetParameter",
      ]);
      // 읽기(GetItem)는 State 테이블에만
      // expect.stringMatching(/…/): 정확한 글자 대신 "이 모양이면 통과"로 비교
      expect(actions.get("dynamodb:GetItem")).toEqual([
        expect.stringMatching(/^StorageStateTable.*\.Arn$/),
      ]);
      // 고치기(UpdateItem)는 Ops 테이블에만
      expect(actions.get("dynamodb:UpdateItem")).toEqual([
        expect.stringMatching(/^StorageOpsTable.*\.Arn$/),
      ]);
      // API 키는 자기 것 하나만(주소 끝이 그 키 이름)
      expect(actions.get("ssm:GetParameter")).toEqual([
        expect.stringMatching(
          new RegExp(`:parameter/baradun/v2/api-keys/${key}$`),
        ),
      ]);
    },
  );

  it("API 키 보관 경로가 services와 같다", () => {
    // 다르면 함수는 권한이 없는 주소에서 키를 찾다가 실패함
    expect(API_KEY_PARAMETER_PREFIX).toBe(SERVICES_KEY_PREFIX);
  });
});
