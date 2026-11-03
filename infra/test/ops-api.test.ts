import { describe, expect, it } from "vitest";
import { template } from "./stack-template";

// 운영 API 함수 (BRD-146, D16-B1·B2·E4)

function only(prefix: string, type: string) {
  const found = Object.entries(template.findResources(type)).filter(([id]) =>
    id.startsWith(prefix),
  );
  expect(found).toHaveLength(1);
  return { id: found[0]![0], resource: found[0]![1] };
}

describe("운영 API", () => {
  it("services/src/admin의 opsHandler를 쓰고 두 풀·Ops 테이블을 환경 변수로 받는다", () => {
    const fn = only("OpsApiFunction", "AWS::Lambda::Function").resource;
    expect(fn.Properties.Handler).toBe("index.opsHandler");
    expect(Object.keys(fn.Properties.Environment.Variables).sort()).toEqual([
      "OPERATOR_CLIENT_ID",
      "OPERATOR_USER_POOL_ID",
      "OPS_TABLE_NAME",
      "SAMPLE_CLIENT_ID",
      "SAMPLE_USER_POOL_ID",
    ]);
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
