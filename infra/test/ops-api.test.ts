import { describe, expect, it } from "vitest";
import { template } from "./stack-template";
import { PUBLISHER_TIMEOUT_SECONDS } from "../lib/settings";
import {
  PUBLISH_JOB_RUN_LIMIT_MS,
  PUBLISH_JOB_START_LIMIT_MS,
} from "../../services/src/core/collect/publish-job";

// 운영 API 함수 (BRD-146, D16-B1·B2·E4)

function only(prefix: string, type: string) {
  const found = Object.entries(template.findResources(type)).filter(([id]) =>
    id.startsWith(prefix),
  );
  expect(found).toHaveLength(1);
  return { id: found[0]![0], resource: found[0]![1] };
}

describe("운영 API", () => {
  it("services/src/admin의 opsHandler를 쓰고 두 풀·Ops·문의 테이블·게시 버킷을 환경 변수로 받는다", () => {
    const fn = only("OpsApiFunction", "AWS::Lambda::Function").resource;
    expect(fn.Properties.Handler).toBe("index.opsHandler");
    expect(Object.keys(fn.Properties.Environment.Variables).sort()).toEqual([
      "INQUIRY_TABLE_NAME",
      "OPERATOR_CLIENT_ID",
      "OPERATOR_USER_POOL_ID",
      "OPS_ALARM_PREFIX",
      "OPS_TABLE_NAME",
      "PUBLISHER_FUNCTION_NAME",
      "SAMPLE_CLIENT_ID",
      "SAMPLE_USER_POOL_ID",
      "SNAPSHOT_BUCKET",
    ]);
  });

  it("게시 버킷은 publisher와 같은 사이트 버킷이다(BRD-150)", () => {
    const fn = only("OpsApiFunction", "AWS::Lambda::Function").resource;
    const publisher = only("PublishFunction", "AWS::Lambda::Function").resource;
    expect(fn.Properties.Environment.Variables.SNAPSHOT_BUCKET).toEqual(
      publisher.Properties.Environment.Variables.SNAPSHOT_BUCKET,
    );
    expect(fn.Properties.Environment.Variables.SNAPSHOT_BUCKET).toEqual({
      Ref: expect.stringMatching(/^SiteBucket/),
    });
  });

  it("지금 게시·되돌리기 작업은 스택의 publish-snapshot 함수로 넘긴다(#331)", () => {
    const fn = only("OpsApiFunction", "AWS::Lambda::Function").resource;
    const publisher = only("PublishFunction", "AWS::Lambda::Function").id;
    expect(fn.Properties.Environment.Variables.PUBLISHER_FUNCTION_NAME).toEqual(
      { Ref: publisher },
    );
  });

  it("publisher 함수 제한 시간은 게시 작업 실행 제한보다 짧다(실행 중으로 남은 작업을 늦어짐으로 볼 때 이미 끝난 실행)", () => {
    expect(PUBLISHER_TIMEOUT_SECONDS * 1000).toBeLessThan(
      PUBLISH_JOB_RUN_LIMIT_MS,
    );
    // 시작 제한 안에 맡은 작업도 함수 제한 시간 안에 끝남
    expect(PUBLISHER_TIMEOUT_SECONDS * 1000).toBeLessThan(
      PUBLISH_JOB_START_LIMIT_MS,
    );
  });

  it("함수 URL은 IAM 인증이고, 아직 CloudFront에 연결하지 않는다(BRD-147에서 관리자 배포에 연결)", () => {
    const fn = only("OpsApiFunction", "AWS::Lambda::Function");
    const url = Object.values(template.findResources("AWS::Lambda::Url")).find(
      (u) => u.Properties.TargetFunctionArn?.["Fn::GetAtt"]?.[0] === fn.id,
    );
    expect(url?.Properties.AuthType).toBe("AWS_IAM");
    expect(url?.Properties.Cors).toBeUndefined();
    const cloudfrontInvokes = Object.values(
      template.findResources("AWS::Lambda::Permission"),
    ).filter(
      (p) =>
        p.Properties.Principal === "cloudfront.amazonaws.com" &&
        JSON.stringify(p.Properties.FunctionName).includes(fn.id),
    );
    expect(cloudfrontInvokes).toEqual([]);
  });
});
