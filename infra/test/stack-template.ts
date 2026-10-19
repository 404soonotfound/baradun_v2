import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { BaradunStack } from "../lib/baradun-stack";

// 가드레일 테스트들이 같이 쓰는 템플릿. AWS 계정 없이 만들어요.
export const template = Template.fromStack(
  new BaradunStack(new App(), "Test", { env: { region: "ap-northeast-2" } }),
);

export type Statement = {
  Effect: "Allow" | "Deny";
  Action: string | string[];
  Resource?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
};

export type PolicyWithStatements = {
  logicalId: string;
  // 이 정책이 붙은 역할의 논리 ID (Ref)
  roles: string[];
  statements: Statement[];
};

// 템플릿 안의 모든 IAM 정책(역할 인라인 정책 포함)을 문장 목록으로 모아요.
export function allIamPolicies(): PolicyWithStatements[] {
  const result: PolicyWithStatements[] = [];

  for (const [logicalId, res] of Object.entries(
    template.findResources("AWS::IAM::Policy"),
  )) {
    result.push({
      logicalId,
      roles: (res.Properties.Roles ?? []).map((r: { Ref: string }) => r.Ref),
      statements: res.Properties.PolicyDocument.Statement,
    });
  }
  for (const [logicalId, res] of Object.entries(
    template.findResources("AWS::IAM::ManagedPolicy"),
  )) {
    result.push({
      logicalId,
      roles: (res.Properties.Roles ?? []).map((r: { Ref: string }) => r.Ref),
      statements: res.Properties.PolicyDocument.Statement,
    });
  }
  for (const [logicalId, res] of Object.entries(
    template.findResources("AWS::IAM::Role"),
  )) {
    for (const p of res.Properties.Policies ?? []) {
      result.push({
        logicalId: `${logicalId}/${p.PolicyName}`,
        roles: [logicalId],
        statements: p.PolicyDocument.Statement,
      });
    }
  }
  return result;
}

export function toList<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// CloudFormation 표현({"Fn::Join"...})을 "SiteBucket.Arn/data/*" 같은 글자로 바꿔요.
export function resourceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if ("Fn::GetAtt" in v) return (v["Fn::GetAtt"] as string[]).join(".");
    if ("Ref" in v) return String(v.Ref);
    if ("Fn::Join" in v) {
      const [sep, parts] = v["Fn::Join"] as [string, unknown[]];
      return parts.map(resourceText).join(sep);
    }
  }
  return JSON.stringify(value);
}

// 이 리소스 주소가 data/ 아래 파일을 포함할 수 있는지 ("*", "버킷/*", "버킷/data/*" 등)
export function coversDataPrefix(resource: string): boolean {
  if (resource === "*") return true;
  const slash = resource.indexOf("/");
  if (slash < 0) return false;
  const path = resource.slice(slash + 1);
  if (path.startsWith("data/")) return true;
  return path.endsWith("*") && "data/".startsWith(path.slice(0, -1));
}

// 객체를 올리거나 지우는 동작인지. "*"·"s3:*"·"s3:Put*" 같은 와일드카드도 잡아요.
export function isObjectWrite(action: string): boolean {
  const pattern = new RegExp(
    `^${action.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
    "i",
  );
  return ["s3:PutObject", "s3:DeleteObject"].some((a) => pattern.test(a));
}
