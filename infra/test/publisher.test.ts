import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_PREFIX, PUBLISHER_TIMEOUT_SECONDS } from "../lib/settings";
import {
  allIamPolicies,
  resourceText,
  template,
  toList,
} from "./stack-template";

// publish-snapshot Lambda (BRD-61 PR ②, 아키텍처 6.2)
// services/src/publisher/policy.ts의 lockTtlMs(2분). 그 파일은 확장자 없는 import를 써서
// infra 타입 검사(NodeNext)에서 가져오지 않고 값을 적어 둠. 한쪽을 바꾸면 함께 바꿈
const PUBLISH_LOCK_TTL_MS = 2 * 60 * 1000;

// 실행 일정 없이 수집기가 깨움 · 역할은 PublisherRole(data/ 쓰기를 가진 유일한 역할) · 잠금보다 짧은 시간 제한

type Resource = { Type: string; Properties: Record<string, any> };
const resources = template.toJSON().Resources as Record<string, Resource>;

function publisherId(): string {
  const ids = Object.keys(
    template.findResources("AWS::Lambda::Function"),
  ).filter((id) => id.startsWith("PublishFunction"));
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

const fn = () => resources[publisherId()]!.Properties;

describe("publish-snapshot 함수", () => {
  it("Node 22·ARM·publishHandler, PublisherRole을 씀", () => {
    expect(fn().Runtime).toBe("nodejs22.x");
    expect(fn().Architectures).toEqual(["arm64"]);
    expect(fn().Handler).toBe("index.publishHandler");
    const role = fn().Role["Fn::GetAtt"][0] as string;
    expect(role.startsWith("PublisherRole")).toBe(true);
  });

  it("시간 제한이 게시 잠금(2분)보다 짧다", () => {
    expect(fn().Timeout).toBe(PUBLISHER_TIMEOUT_SECONDS);
    expect(PUBLISHER_TIMEOUT_SECONDS * 1000).toBeLessThan(PUBLISH_LOCK_TTL_MS);
  });

  it("설정값은 버킷 이름과 테이블 이름 두 개뿐", () => {
    const vars = fn().Environment.Variables;
    expect(Object.keys(vars).sort()).toEqual([
      "OPS_TABLE_NAME",
      "SNAPSHOT_BUCKET",
      "STATE_TABLE_NAME",
    ]);
    expect(vars.SNAPSHOT_BUCKET).toEqual({
      Ref: expect.stringMatching(/^SiteBucket/),
    });
  });

  it("비동기 호출 실패를 다시 부르지 않는다(다음 수집이 깨움)", () => {
    const configs = Object.values(
      template.findResources("AWS::Lambda::EventInvokeConfig"),
    ).filter((c) => c.Properties.FunctionName?.Ref === publisherId());
    expect(configs).toHaveLength(1);
    expect(configs[0]!.Properties.MaximumRetryAttempts).toBe(0);
  });

  it("실행 일정이 없다(수집기가 깨움)", () => {
    const targets = Object.values(
      template.findResources("AWS::Scheduler::Schedule"),
    ).map((s) => resourceText(s.Properties.Target.Arn));
    expect(targets).not.toContain(`${publisherId()}.Arn`);
  });

  it("자기 로그 그룹 하나에만 기록하고, 보존 기간을 정해 둔다", () => {
    const logGroupIds = Object.keys(
      template.findResources("AWS::Logs::LogGroup"),
    ).filter((id) => id.startsWith("PublishLogs"));
    expect(logGroupIds).toHaveLength(1);
    expect(fn().LoggingConfig.LogGroup).toEqual({ Ref: logGroupIds[0] });

    const role = fn().Role["Fn::GetAtt"][0] as string;
    const logResources = allIamPolicies()
      .filter((p) => p.roles.includes(role))
      .flatMap((p) => p.statements)
      .filter(
        (s) =>
          s.Effect === "Allow" &&
          toList(s.Action).some((a) => a.startsWith("logs:")),
      )
      .flatMap((s) => toList(s.Resource).map(resourceText));
    expect(logResources).toEqual([`${logGroupIds[0]}.Arn`]);
  });

  it("S3 권한은 data/ 아래 읽기·쓰기·지우기와 data/ 목록뿐(조건부 쓰기는 Get·Put으로 됨)", () => {
    const role = fn().Role["Fn::GetAtt"][0] as string;
    const s3Statements = allIamPolicies()
      .filter((p) => p.roles.includes(role))
      .flatMap((p) => p.statements)
      .filter((s) => toList(s.Action).some((a) => a.startsWith("s3:")));
    const objectActions = s3Statements
      .filter((s) => toList(s.Action).includes("s3:PutObject"))
      .flatMap((s) => toList(s.Action))
      .sort();
    expect(objectActions).toEqual([
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]);
    for (const s of s3Statements) {
      for (const r of toList(s.Resource).map(resourceText)) {
        if (r.includes("/"))
          expect(r.endsWith(`/${DATA_PREFIX}*`), r).toBe(true);
      }
    }
  });
});

// 점검·강제 업데이트 설정(BRD-43). 두 값은 서로 다른 패키지(services·apps/web)에 있고 서로 가져오지 않음(17.2 경계)
// → 인프라 테스트가 두 파일을 글자로 읽어 비교함. 모양이 바뀌어 읽지 못하면 그것도 실패로 드러남
describe("manifest 설정과 화면 빌드 번호 (BRD-43)", () => {
  const REPO_ROOT = path.join(__dirname, "..", "..");
  const read = (file: string, pattern: RegExp): number => {
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
    const match = pattern.exec(text);
    expect(match, `${file}에서 값을 찾지 못함: ${pattern}`).not.toBeNull();
    return Number(match![1]);
  };

  it("MANIFEST_SETTINGS.minWebBuild는 배포된 WEB_BUILD보다 클 수 없다(새 화면을 먼저 배포한 뒤 올림)", () => {
    const webBuild = read(
      "apps/web/src/lib/snapshot/build.ts",
      /export const WEB_BUILD = (\d+);/,
    );
    const minWebBuild = read(
      "services/src/publisher/policy.ts",
      /minWebBuild: (\d+),/,
    );
    // 어기면 모든 사용자가 강제 업데이트 화면에 갇힘(새로고침해도 이전 화면 파일만 받음). infra/README '강제 업데이트'
    expect(minWebBuild).toBeLessThanOrEqual(webBuild);
  });
});
