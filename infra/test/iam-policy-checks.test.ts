import { describe, expect, it } from "vitest";
import {
  MAX_MANAGED_POLICY_CHARS,
  arnMatches,
  excludedPropertyErrors,
  fetchReference,
  managedPolicyChars,
  policyActionErrors,
  referenceActionErrors,
  resolveSchemaPermission,
  schemaCoverageErrors,
  statementScopeErrors,
  type ServiceReference,
} from "../scripts/iam-policy-checks";

const references: Record<string, ServiceReference> = {
  lambda: {
    Actions: [{ Name: "GetFunction" }, { Name: "PutFunctionRecursionConfig" }],
  },
  s3: {
    Actions: [{ Name: "PutBucketCORS" }],
    Operations: [
      {
        Name: "DeleteBucketCors",
        AuthorizedActions: [{ Service: "s3", Name: "PutBucketCORS" }],
      },
    ],
  },
};

describe("공식 IAM·CFN 검증기", () => {
  it("IAM이 허용하는 단일 Statement도 검사하고 NotAction은 거부한다", () => {
    expect(
      policyActionErrors({
        Statement: { Effect: "Allow", Action: "s3:PutBucketCORS" },
      }),
    ).toEqual([]);
    expect(
      policyActionErrors({
        Statement: { Effect: "Allow", NotAction: ["s3:*", "s3:NotReal"] },
      }),
    ).toContain("NotAction은 허용하지 않음");
  });

  it("정책과 fixture에 같은 API 이름을 넣어도 공식 Action 대조에서 둘 다 거부한다", () => {
    const errors = referenceActionErrors(
      [
        { file: "policy.json", action: "s3:DeleteBucketCors" },
        { file: "iam-actions.json", action: "s3:DeleteBucketCors" },
      ],
      references,
    );
    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain("iam-actions.json");
    expect(resolveSchemaPermission("s3:DeleteBucketCors", references)).toEqual([
      "s3:PutBucketCORS",
    ]);
  });

  it("공식 스키마가 추가한 작업은 손으로 쓴 표와 무관하게 누락을 잡는다", () => {
    const schemas = {
      "AWS::Lambda::Function": {
        typeName: "AWS::Lambda::Function",
        handlers: {
          update: { permissions: ["lambda:PutFunctionRecursionConfig"] },
        },
      },
    };
    const resources = {
      Function: { Type: "AWS::Lambda::Function", Properties: {} },
    };
    expect(
      schemaCoverageErrors(
        schemas,
        resources,
        references,
        [{ Effect: "Allow", Action: "lambda:GetFunction", Resource: "*" }],
        new Set(),
        {},
      ),
    ).toEqual([expect.stringContaining("lambda:PutFunctionRecursionConfig")]);
  });

  it.each([undefined, []])(
    "API 매핑이 없거나 비면 원래 권한을 조용히 건너뛰지 않는다 (%j)",
    (AuthorizedActions) => {
      const refs = {
        s3: {
          Actions: [],
          Operations: [{ Name: "CreateSession", AuthorizedActions }],
        },
      };
      expect(resolveSchemaPermission("s3:CreateSession", refs)).toBeUndefined();
      expect(
        schemaCoverageErrors(
          {
            Bucket: {
              typeName: "Bucket",
              handlers: { create: { permissions: ["s3:CreateSession"] } },
            },
          },
          { Bucket: { Type: "Bucket" } },
          refs,
          [],
          new Set(),
          {},
        ),
      ).toEqual([expect.stringContaining("s3:CreateSession")]);
    },
  );

  it("잘못된 권한과 근거 없는 제외는 위치가 있는 오류로 실패한다", () => {
    expect(resolveSchemaPermission("malformed", references)).toBeUndefined();
    expect(
      schemaCoverageErrors(
        {
          Bucket: {
            typeName: "Bucket",
            handlers: { create: { permissions: ["malformed"] } },
          },
        },
        { MyBucket: { Type: "Bucket" } },
        references,
        [],
        new Set(),
        { Bucket: [{ permissions: ["s3:PutBucketCORS"] }] },
      ),
    ).toEqual(
      expect.arrayContaining([
        "Bucket: 제외 근거가 없음",
        "Bucket: 무조건 제외는 허용하지 않음",
        expect.stringContaining(
          "Bucket.create: 잘못된 스키마 권한 형식 malformed",
        ),
      ]),
    );
  });

  it("공식 참조에 생긴 이름은 notInReference 제외를 자동 만료시킨다", () => {
    const exclusion = {
      Bucket: [
        {
          permissions: ["s3:PutBucketCORS"],
          reason: "예전 참조에는 없었음",
          notInReference: true,
        },
      ],
    };
    expect(
      schemaCoverageErrors(
        {},
        { MyBucket: { Type: "Bucket" } },
        references,
        [],
        new Set(),
        exclusion,
      ),
    ).toContain(
      "Bucket: 공식 참조에 등장한 제외 권한 재검토 필요: s3:PutBucketCORS",
    );
  });

  const cloudfrontRef: Record<string, ServiceReference> = {
    cloudfront: {
      Actions: [
        { Name: "GetDistribution", Resources: [{ Name: "distribution" }] },
        {
          Name: "TagResource",
          Resources: [{ Name: "distribution" }],
          ConditionKeys: ["aws:RequestTag/${TagKey}"],
        },
      ],
      Resources: [
        {
          Name: "distribution",
          ARNFormats: [
            "arn:${Partition}:cloudfront::${Account}:distribution/${Id}",
          ],
          ConditionKeys: ["aws:ResourceTag/${TagKey}"],
        },
      ],
    },
    iam: {
      Actions: [{ Name: "PassRole", Resources: [{ Name: "role" }] }],
      Resources: [
        {
          Name: "role",
          ARNFormats: [
            "arn:${Partition}:iam::${Account}:role/${RoleNameWithPath}",
          ],
        },
      ],
    },
  };

  it("같은 Action이어도 틀린 Resource 종류·예약 태그·태그 결측을 거부한다", () => {
    const type = "AWS::CloudFront::Distribution";
    const schema = {
      typeName: type,
      tagging: { cloudFormationSystemTags: false },
      handlers: { read: { permissions: ["cloudfront:GetDistribution"] } },
    };
    const resources = { Distribution: { Type: type, Properties: {} } };
    const statement = {
      Effect: "Allow",
      Action: "cloudfront:GetDistribution",
      Resource: "arn:aws:cloudfront::717304679248:distribution/*",
      Condition: {
        StringEquals: {
          "aws:ResourceTag/aws:cloudformation:stack-name": "BaradunV2",
        },
      },
    };
    expect(
      schemaCoverageErrors(
        { [type]: schema },
        resources,
        cloudfrontRef,
        [statement],
        new Set(),
        {},
      ),
    ).toEqual([expect.stringContaining("cloudFormationSystemTags=false")]);
    expect(
      statementScopeErrors(
        {
          ...statement,
          Condition: undefined,
          Resource: "arn:aws:cloudfront::717304679248:function/*",
        },
        statement.Action,
        type,
        schema,
        resources,
        cloudfrontRef,
      ),
    ).toContain("SAR 리소스 종류에 맞는 Resource가 없음");
    expect(
      statementScopeErrors(
        {
          ...statement,
          Condition: {
            StringEquals: { "aws:ResourceTag/baradun:stack": "BaradunV2" },
          },
        },
        statement.Action,
        type,
        schema,
        resources,
        cloudfrontRef,
      ),
    ).toContain(
      "템플릿·스키마에 태그 조건 근거 없음: aws:ResourceTag/baradun:stack",
    );
  });

  it("서울 리전 조건의 Resource *는 승인된 리소스 종류(Cognito 사용자 풀 등)에만 허락한다", () => {
    const statement = {
      Effect: "Allow",
      Action: "cognito-idp:CreateUserPool",
      Resource: "*",
      Condition: { StringEquals: { "aws:RequestedRegion": "ap-northeast-2" } },
    };
    const check = (type: string, value: string) =>
      statementScopeErrors(
        {
          ...statement,
          Condition: { StringEquals: { "aws:RequestedRegion": value } },
        },
        statement.Action,
        type,
        { typeName: type },
        {},
        {},
      );
    expect(check("AWS::Cognito::UserPool", "ap-northeast-2")).toEqual([]);
    expect(check("AWS::Cognito::UserPool", "us-east-1")).toContain(
      "리전 조건의 리소스별 근거 없음: aws:RequestedRegion",
    );
    expect(check("AWS::Cognito::UserPoolClient", "ap-northeast-2")).toContain(
      "리전 조건의 리소스별 근거 없음: aws:RequestedRegion",
    );
  });

  it("Lambda PassRole 허용을 S3 복제·SNS 역할 전달 허용으로 오인하지 않는다", () => {
    const statement = {
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: "arn:aws:iam::717304679248:role/BaradunV2-*",
      Condition: {
        StringEquals: {
          "iam:PassedToService": [
            "lambda.amazonaws.com",
            "scheduler.amazonaws.com",
          ],
        },
      },
    };
    for (const type of ["AWS::S3::Bucket", "AWS::SNS::Topic"]) {
      const schema = {
        typeName: type,
        handlers: { create: { permissions: ["iam:PassRole"] } },
      };
      expect(
        schemaCoverageErrors(
          { [type]: schema },
          { Resource: { Type: type } },
          cloudfrontRef,
          [statement],
          new Set(),
          {},
        ),
      ).toEqual([expect.stringContaining("PassRole 서비스가 없음")]);
    }
    expect(
      statementScopeErrors(
        statement,
        "iam:PassRole",
        "AWS::Lambda::Function",
        { typeName: "AWS::Lambda::Function" },
        {},
        cloudfrontRef,
      ),
    ).toEqual([]);
  });

  it("사용자 태그는 모든 배포에 명시돼야 RequestTag·ResourceTag 근거로 인정한다", () => {
    const type = "AWS::CloudFront::Distribution";
    const resources = {
      Distribution: {
        Type: type,
        Properties: { Tags: [{ Key: "baradun:stack", Value: "BaradunV2" }] },
      },
    };
    for (const [action, key] of [
      ["cloudfront:GetDistribution", "aws:ResourceTag/baradun:stack"],
      ["cloudfront:TagResource", "aws:RequestTag/baradun:stack"],
    ]) {
      expect(
        statementScopeErrors(
          {
            Resource: "arn:aws:cloudfront::717304679248:distribution/*",
            Condition: { StringEquals: { [key]: "BaradunV2" } },
          },
          action,
          type,
          { typeName: type },
          resources,
          cloudfrontRef,
        ),
      ).toEqual([]);
    }
  });

  it("ARN 공용 매처는 별표와 물음표를 모두 IAM 와일드카드로 다룬다", () => {
    expect(
      arnMatches(
        "arn:aws:iam::*:role/Baradun?Operator*",
        "arn:aws:iam::717304679248:role/BaradunXOperatorAdmin",
      ),
    ).toBe(true);
    expect(
      arnMatches(
        "arn:aws:iam::*:role/Baradun?Operator*",
        "arn:aws:iam::717304679248:role/BaradunOperatorAdmin",
      ),
    ).toBe(false);
  });

  it("제외한 권한의 속성은 조건부 분기·배열 안에 있어도 사용으로 잡는다", () => {
    const errors = excludedPropertyErrors(
      {
        Function: {
          Type: "AWS::Lambda::Function",
          Properties: {
            RecursiveLoop: {
              "Fn::If": ["Enabled", "Allow", { Ref: "AWS::NoValue" }],
            },
          },
        },
        Distribution: {
          Type: "AWS::CloudFront::Distribution",
          Properties: {
            DistributionConfig: {
              Origins: [{ VpcOriginConfig: { Id: "origin" } }],
            },
          },
        },
      },
      {
        "AWS::Lambda::Function": [
          {
            permissions: ["lambda:PutFunctionRecursionConfig"],
            absentProperties: ["RecursiveLoop"],
            reason: "재귀 설정 미사용",
          },
        ],
        "AWS::CloudFront::Distribution": [
          {
            permissions: ["cloudfront:GetVpcOrigin"],
            absentProperties: ["DistributionConfig/Origins/VpcOriginConfig"],
            reason: "VPC 오리진 미사용",
          },
        ],
      },
    );
    expect(errors).toHaveLength(2);
  });

  it("크기 한도와 계산은 스크립트·가드레일의 공용 정의를 쓴다", () => {
    expect(MAX_MANAGED_POLICY_CHARS).toBe(6144);
    expect(managedPolicyChars(' {\n "Version": "2012-10-17" } ')).toBe(24);
  });

  it.each(["DNS", "HTTP", "JSON", "timeout"])(
    "%s 실패를 처리되지 않은 예외 대신 오류 결과로 돌려준다",
    async (kind) => {
      const fetcher = (async (
        _url: string | URL | Request,
        init?: RequestInit,
      ) => {
        if (kind === "DNS") throw new Error("DNS 실패");
        if (kind === "timeout") {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("시간 초과")),
              { once: true },
            );
          });
        }
        return kind === "HTTP"
          ? new Response("", { status: 503 })
          : new Response("잘못된 JSON");
      }) as typeof fetch;
      const result = await fetchReference(
        "https://example.test/official.json",
        (r) => r.json(),
        fetcher,
        10,
      );
      expect(result.error).toContain("https://example.test/official.json");
      expect(result.value).toBeUndefined();
    },
  );
});
