import { describe, expect, it } from "vitest";
import {
  allIamPolicies,
  coversDataPrefix,
  isObjectWrite,
  resourceText,
  template,
  toList,
} from "./stack-template";
import {
  GITHUB_OIDC_SUBJECT,
  INQUIRY_STATUS_INDEX,
  RUN_LOG_KEY_PREFIX,
  PUBLISH_RUN_KEY,
  PUBLISH_SUMMARY_KEY,
} from "../lib/settings";
// services 감사 키 접두어와 IAM 조건이 맞는지 비교함(한쪽만 바뀌면 테스트가 깨짐)
import { AUDIT_PREFIX, NOTICE_PK } from "../../services/src/admin/keys";
import { RUN_LOG_PREFIX } from "../../services/src/core/collect/run-log";
import {
  PUBLISH_RUN_PK,
  PUBLISH_SUMMARY_PK,
} from "../../services/src/core/collect/publish-summary";

// 역할의 논리 ID를 찾음 (CDK가 이름 뒤에 해시를 붙이므로 앞부분으로 찾기)
function roleId(prefix: string): string {
  const ids = Object.keys(template.findResources("AWS::IAM::Role")).filter(
    (id) => id.startsWith(prefix),
  );
  expect(ids).toHaveLength(1);
  return ids[0];
}

describe("data/ 쓰기 권한", () => {
  it("data/에 쓰거나 지울 수 있는 역할은 publisher 하나뿐이다", () => {
    const writers = new Set<string>();
    const siteBucketId = Object.keys(
      template.findResources("AWS::S3::Bucket"),
    ).find((id) => id.startsWith("SiteBucket"));
    expect(siteBucketId).toBeDefined();
    const siteResources = (resources: unknown[]) =>
      resources
        .map(resourceText)
        .filter(
          (resource) =>
            resource === "*" || resource.startsWith(`${siteBucketId}.Arn`),
        );

    for (const policy of allIamPolicies()) {
      // 같은 정책 안에서 data/를 명시적으로 거부하면 제외 (거부가 허용보다 우선)
      const deniesData = policy.statements.some(
        (s) =>
          s.Effect === "Deny" &&
          toList(s.Action).some(isObjectWrite) &&
          siteResources(toList(s.Resource)).some(coversDataPrefix),
      );
      const allowsData = policy.statements.some(
        (s) =>
          s.Effect === "Allow" &&
          toList(s.Action).some(isObjectWrite) &&
          siteResources(toList(s.Resource)).some(coversDataPrefix),
      );
      if (allowsData && !deniesData)
        policy.roles.forEach((r) => writers.add(r));
    }

    expect([...writers]).toEqual([roleId("PublisherRole")]);
  });

  it("publisher는 data/ 밖에는 쓰지 못한다", () => {
    const publisher = roleId("PublisherRole");
    const resources = allIamPolicies()
      .filter((p) => p.roles.includes(publisher))
      .flatMap((p) => p.statements)
      .filter(
        (s) => s.Effect === "Allow" && toList(s.Action).some(isObjectWrite),
      )
      .flatMap((s) => toList(s.Resource).map(resourceText));

    expect(resources.length).toBeGreaterThan(0);
    for (const r of resources) expect(r).toMatch(/\/data\/\*$/);
  });

  it("버킷 정책은 아무에게도 쓰기를 허용하지 않는다", () => {
    const statements = Object.values(
      template.findResources("AWS::S3::BucketPolicy"),
    ).flatMap((p) => p.Properties.PolicyDocument.Statement);

    for (const s of statements.filter((s) => s.Effect === "Allow")) {
      expect(toList<string>(s.Action).some(isObjectWrite)).toBe(false);
    }
  });
});

describe("GitHub Actions 배포 역할 (OIDC)", () => {
  it("GitHub OIDC 공급자는 하나이고 aud는 sts.amazonaws.com이다", () => {
    template.resourceCountIs("AWS::IAM::OIDCProvider", 1);
    template.hasResourceProperties("AWS::IAM::OIDCProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIdList: ["sts.amazonaws.com"],
    });
  });

  it("신뢰 정책은 저장소·environment를 정확히 고정한다 (와일드카드 없음)", () => {
    const trusts = Object.values(template.findResources("AWS::IAM::Role"))
      .flatMap((r) => r.Properties.AssumeRolePolicyDocument.Statement)
      .filter((s) =>
        toList(s.Action).includes("sts:AssumeRoleWithWebIdentity"),
      );

    expect(trusts).toHaveLength(1);
    for (const s of trusts) {
      // StringLike(와일드카드 비교)는 쓰지 않고 StringEquals만
      expect(Object.keys(s.Condition)).toEqual(["StringEquals"]);
      expect(s.Condition.StringEquals).toEqual({
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": GITHUB_OIDC_SUBJECT,
      });
      expect(JSON.stringify(s.Condition)).not.toContain("*");
    }
  });

  it("sub는 숫자 ID가 붙은 새 형식이다 (2026-07-15 이후 만든 저장소)", () => {
    // 예: repo:404soonotfound@123/baradun_v2@456:environment:production
    expect(GITHUB_OIDC_SUBJECT).toMatch(
      /^repo:404soonotfound@\d+\/baradun_v2@\d+:environment:production$/,
    );
  });

  it("사이트 배포 역할은 data/ 쓰기를 명시적으로 거부한다", () => {
    const deploy = roleId("DeployRole");
    const denies = allIamPolicies()
      .filter((p) => p.roles.includes(deploy))
      .flatMap((p) => p.statements)
      .filter((s) => s.Effect === "Deny");

    // 올리기·지우기 둘 다 data/에서 거부 (순서는 상관없음)
    const dataDeny = denies.find((s) =>
      toList(s.Resource)
        .map(resourceText)
        .some((r) => r.endsWith("/data/*")),
    );
    expect(dataDeny).toBeDefined();
    expect(toList(dataDeny?.Action)).toEqual(
      expect.arrayContaining(["s3:PutObject", "s3:DeleteObject"]),
    );
  });

  it("사이트 배포 역할은 파일 올리기·목록·캐시 비우기만 할 수 있다", () => {
    const deploy = roleId("DeployRole");
    const actions = allIamPolicies()
      .filter((p) => p.roles.includes(deploy))
      .flatMap((p) => p.statements)
      .filter((s) => s.Effect === "Allow")
      .flatMap((s) => toList(s.Action));

    expect(new Set(actions)).toEqual(
      new Set([
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "cloudfront:CreateInvalidation",
      ]),
    );
  });
});

describe("장기 키·과한 권한", () => {
  it("IAM 사용자와 액세스 키를 만들지 않는다", () => {
    template.resourceCountIs("AWS::IAM::User", 0);
    template.resourceCountIs("AWS::IAM::AccessKey", 0);
  });

  it("어떤 허용 문장도 모든 동작(*)을 주지 않는다", () => {
    for (const s of allIamPolicies().flatMap((p) => p.statements)) {
      if (s.Effect !== "Allow") continue;
      for (const a of toList(s.Action))
        expect(a).not.toMatch(/^(\*|[a-z0-9-]+:\*)$/);
    }
  });
});

// 테이블 논리 ID (StorageStateTable… 앞부분으로 찾기)
function tableId(name: "State" | "Ops" | "Inquiry"): string {
  const ids = Object.keys(
    template.findResources("AWS::DynamoDB::Table"),
  ).filter((id) => id.startsWith(`Storage${name}Table`));
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

// 허용 문장에서 DynamoDB 동작을 "테이블 논리 ID → 동작 집합"으로 모음
function dynamoActionsByResource(roles?: string[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const policy of allIamPolicies()) {
    if (roles && !policy.roles.some((r) => roles.includes(r))) continue;
    for (const s of policy.statements) {
      if (s.Effect !== "Allow") continue;
      const actions = toList(s.Action).filter((a) => /^dynamodb:/i.test(a));
      if (actions.length === 0) continue;
      for (const r of toList(s.Resource).map(resourceText)) {
        const set = result.get(r) ?? new Set<string>();
        actions.forEach((a) => set.add(a));
        result.set(r, set);
      }
    }
  }
  return result;
}

describe("DynamoDB 권한 (BRD-55)", () => {
  it("DynamoDB 권한이 있는 역할은 정해진 실행 역할뿐이다", () => {
    const holders = new Set<string>();
    for (const policy of allIamPolicies()) {
      const hasDynamo = policy.statements.some(
        (s) =>
          s.Effect === "Allow" &&
          toList(s.Action).some((a) => /^(\*|dynamodb:)/i.test(a)),
      );
      if (hasDynamo) policy.roles.forEach((r) => holders.add(r));
    }
    expect([...holders].sort()).toEqual(
      [
        roleId("PublisherRole"),
        roleId("CollectOceanRole"),
        roleId("CollectWarningsRole"),
        roleId("CollectCatalogRole"),
        roleId("CollectRipRole"),
        roleId("CollectWeatherRole"),
        roleId("InquiryInquiryRole"),
        roleId("OpsApiRole"),
      ].sort(),
    );
  });

  it("운영 API 역할은 Ops 읽기·쓰기·감사 조회, 문의 읽기·상태 바꾸기·목록 GSI 조회만 하고 State 권한은 없다(G1)", () => {
    const byResource = dynamoActionsByResource([roleId("OpsApiRole")]);
    // 트랜잭션 Put·Update는 품목별 동작으로 판정됨. Scan·Delete·문의 만들기(Put)는 없음
    expect(Object.fromEntries(byResource)).toEqual({
      [`${tableId("Ops")}.Arn`]: new Set([
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:UpdateItem",
      ]),
      [`${tableId("Inquiry")}.Arn`]: new Set([
        "dynamodb:GetItem",
        "dynamodb:UpdateItem",
      ]),
      // 목록은 상태 GSI 하나에만 Query(테이블 전체 Query·Scan 없음)
      [`${tableId("Inquiry")}.Arn/index/${INQUIRY_STATUS_INDEX.name}`]: new Set(
        ["dynamodb:Query"],
      ),
    });
  });

  // 감사 기록(BRD-155, D16-B5): 쓰기만 주고 수정·삭제 권한 없음
  it("수집 실행 기록 키 앞부분이 수집기와 운영 API에서 같다", () => {
    expect(RUN_LOG_KEY_PREFIX).toBe(RUN_LOG_PREFIX);
  });

  it("게시 요약 키가 publisher와 운영 API에서 같다(BRD-187)", () => {
    expect(PUBLISH_SUMMARY_KEY).toBe(PUBLISH_SUMMARY_PK);
  });

  it("게시 실행 결과 키가 publisher와 운영 API에서 같다(#331)", () => {
    expect(PUBLISH_RUN_KEY).toBe(PUBLISH_RUN_PK);
  });

  it("운영 API 역할은 이 스택 경보의 설정·기록 읽기만 받는다(BRD-187)", () => {
    const statements = allIamPolicies()
      .filter((p) => p.roles.includes(roleId("OpsApiRole")))
      .flatMap((p) => p.statements)
      .filter((s) =>
        toList(s.Action).some((a) => String(a).startsWith("cloudwatch:")),
      );
    expect(statements).toHaveLength(1);
    expect(statements[0]!.Effect).toBe("Allow");
    expect(toList(statements[0]!.Action).sort()).toEqual([
      "cloudwatch:DescribeAlarmHistory",
      "cloudwatch:DescribeAlarms",
    ]);
    const resources = toList(statements[0]!.Resource).map(resourceText);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatch(/:alarm:.*-\*$/);
  });

  it("운영 API 역할은 인증키 파라미터 두 개의 태그만 읽고 값(GetParameter)은 못 읽는다(ADM-SRC)", () => {
    const statements = allIamPolicies()
      .filter((p) => p.roles.includes(roleId("OpsApiRole")))
      .flatMap((p) => p.statements)
      .filter((s) =>
        toList(s.Action).some((a) => String(a).startsWith("ssm:")),
      );
    expect(statements).toHaveLength(1);
    expect(statements[0]!.Effect).toBe("Allow");
    expect(toList(statements[0]!.Action)).toEqual(["ssm:ListTagsForResource"]);
    const resources = toList(statements[0]!.Resource).map(resourceText);
    expect(resources).toHaveLength(2);
    expect(resources.join(" ")).toMatch(
      /parameter\/baradun\/v2\/api-keys\/data-go-kr.*parameter\/baradun\/v2\/api-keys\/kma-apihub/,
    );
  });

  it("운영 API 역할의 Ops Query는 감사 키·공지·수집 실행 기록·게시 요약·게시 실행 결과 파티션에만 되고, 감사 키 수정·삭제는 명시적으로 거부된다", () => {
    const statements = allIamPolicies()
      .filter((p) => p.roles.includes(roleId("OpsApiRole")))
      .flatMap((p) => p.statements)
      .filter((s) =>
        toList(s.Resource)
          .map(resourceText)
          .includes(`${tableId("Ops")}.Arn`),
      );
    const query = statements.filter(
      (s) =>
        s.Effect === "Allow" && toList(s.Action).includes("dynamodb:Query"),
    );
    expect(query).toHaveLength(1);
    expect(toList(query[0]!.Action)).toEqual(["dynamodb:Query"]);
    // 감사 기록 월 파티션·공지 파티션(BRD-151)·수집 실행 기록(BRD-149)만
    expect(query[0]!.Condition).toEqual({
      "ForAllValues:StringLike": {
        "dynamodb:LeadingKeys": [
          `${AUDIT_PREFIX}*`,
          NOTICE_PK,
          `${RUN_LOG_PREFIX}*`,
          PUBLISH_SUMMARY_PK,
          PUBLISH_RUN_PK,
        ],
      },
      Null: { "dynamodb:LeadingKeys": "false" },
    });

    const denies = statements.filter((s) => s.Effect === "Deny");
    expect(denies).toHaveLength(1);
    expect(toList(denies[0]!.Action).sort()).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:UpdateItem",
    ]);
    expect(denies[0]!.Condition).toEqual({
      "ForAnyValue:StringLike": {
        "dynamodb:LeadingKeys": [`${AUDIT_PREFIX}*`],
      },
    });
    // 지우기는 허용 문장에도 없음(Deny는 이중 안전장치)
    for (const s of statements.filter((x) => x.Effect === "Allow")) {
      expect(toList(s.Action)).not.toContain("dynamodb:DeleteItem");
    }
  });

  it("문의 역할은 Inquiry 항목 쓰기·멱등 기록 읽기·이메일 삭제만 할 수 있다", () => {
    const byResource = dynamoActionsByResource([roleId("InquiryInquiryRole")]);
    expect(Object.fromEntries(byResource)).toEqual({
      // 트랜잭션 Put은 dynamodb:PutItem으로 판정됨(품목별 동작). TransactWriteItems라는 동작은 없음
      // GetItem은 같은 멱등 키의 첫 결과 읽기(BRD-103). Query·Scan은 없음
      [`${tableId("Inquiry")}.Arn`]: new Set([
        "dynamodb:DeleteItem",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
      ]),
    });
  });

  it("publisher는 State 읽기, Ops 읽기·쓰기만 갖고 Inquiry 권한은 없다", () => {
    const byResource = dynamoActionsByResource([roleId("PublisherRole")]);

    expect(Object.fromEntries(byResource)).toEqual({
      [`${tableId("State")}.Arn`]: new Set([
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:BatchGetItem",
      ]),
      [`${tableId("Ops")}.Arn`]: new Set([
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
      ]),
    });
    expect(
      [...byResource.keys()].some((r) => r.startsWith(tableId("Inquiry"))),
    ).toBe(false);
  });

  it("publisher의 Ops Query는 공지 파티션에만 허용된다(BRD-151)", () => {
    const publisher = roleId("PublisherRole");
    const query = allIamPolicies()
      .filter((p) => p.roles.includes(publisher))
      .flatMap((p) => p.statements)
      .filter(
        (s) =>
          s.Effect === "Allow" &&
          toList(s.Action).includes("dynamodb:Query") &&
          toList(s.Resource).some((r) =>
            resourceText(r).includes(tableId("Ops")),
          ),
      );
    expect(query).toHaveLength(1);
    expect(toList(query[0]!.Action)).toEqual(["dynamodb:Query"]);
    expect(query[0]!.Condition).toEqual({
      "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [NOTICE_PK] },
      Null: { "dynamodb:LeadingKeys": "false" },
    });
  });

  it("어떤 역할도 Scan·테이블 관리·와일드카드 DynamoDB 동작을 갖지 않는다", () => {
    const actions = [...dynamoActionsByResource().values()].flatMap((s) => [
      ...s,
    ]);
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      expect(a).not.toContain("*");
      expect(a).not.toMatch(
        /^dynamodb:(Scan|PartiQL|(Create|Delete|Update|Describe)Table|UpdateTimeToLive|.*Backup|Restore)/i,
      );
    }
  });
});

// 역할 하나가 허락받은 동작을 "동작 → 리소스 주소 목록"으로 모음
function allowedActionsOfRole(role: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const policy of allIamPolicies().filter((p) => p.roles.includes(role))) {
    for (const s of policy.statements.filter((x) => x.Effect === "Allow")) {
      for (const action of toList(s.Action)) {
        result.set(action, [
          ...(result.get(action) ?? []),
          ...toList(s.Resource).map(resourceText),
        ]);
      }
    }
  }
  return result;
}

describe("함수·역할별 최소 권한 범위 (BRD-67)", () => {
  const roles = template.findResources("AWS::IAM::Role");

  it("스택의 IAM 역할은 수집 4·publisher·문의·운영 알림·운영 API·배포·Scheduler 대상 역할뿐이다", () => {
    const schedulerRoles = Object.keys(roles).filter((id) =>
      id.startsWith("SchedulerRoleForTarget"),
    );
    expect(schedulerRoles.length).toBeGreaterThan(0);
    expect(Object.keys(roles).sort()).toEqual(
      [
        roleId("CollectOceanRole"),
        roleId("CollectWarningsRole"),
        roleId("CollectCatalogRole"),
        roleId("CollectRipRole"),
        roleId("CollectWeatherRole"),
        roleId("PublisherRole"),
        roleId("InquiryInquiryRole"),
        roleId("OpsNotificationRole"),
        roleId("OpsApiRole"),
        roleId("DeployRole"),
        ...schedulerRoles,
      ].sort(),
    );
  });

  it("운영 API 역할은 Ops·문의 테이블과 자기 로그에만 쓰고, 게시 버킷은 data/ 읽기·목록만 하며 관리형 정책이 없다", () => {
    const api = roleId("OpsApiRole");
    expect(roles[api]!.Properties.ManagedPolicyArns ?? []).toEqual([]);
    const actions = allowedActionsOfRole(api);
    expect([...actions.keys()].sort()).toEqual([
      "cloudwatch:DescribeAlarmHistory",
      "cloudwatch:DescribeAlarms",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
      "lambda:InvokeFunction",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "s3:GetObject",
      "s3:ListBucket",
      "ssm:ListTagsForResource",
    ]);
    // 해변 관리 지금 표시 상태(BRD-150): 사이트 버킷 data/ 아래 읽기와 data/ 접두어 목록만. 쓰기 없음
    const siteBucket = Object.keys(
      template.findResources("AWS::S3::Bucket"),
    ).find((id) => id.startsWith("SiteBucket"));
    expect(actions.get("s3:GetObject")).toEqual([`${siteBucket}.Arn/data/*`]);
    expect(actions.get("s3:ListBucket")).toEqual([`${siteBucket}.Arn`]);
    // 게시 파일 쓰기는 없음(publisher만, 6.2 단일 작성자). 지금 게시·되돌리기는 publisher 함수 호출로만(#331)
    for (const action of ["s3:PutObject", "s3:DeleteObject"]) {
      expect(actions.has(action)).toBe(false);
    }
    const publisherFunction = Object.keys(
      template.findResources("AWS::Lambda::Function"),
    ).filter((id) => id.startsWith("PublishFunction"));
    expect(publisherFunction).toHaveLength(1);
    // 버전·별칭 주소(:*) 없이 publish-snapshot 함수 하나에만
    expect(actions.get("lambda:InvokeFunction")).toEqual([
      `${publisherFunction[0]}.Arn`,
    ]);
    const list = allIamPolicies()
      .filter((p) => p.roles.includes(api))
      .flatMap((p) => p.statements)
      .filter(
        (s) =>
          s.Effect === "Allow" && toList(s.Action).includes("s3:ListBucket"),
      );
    expect(list).toHaveLength(1);
    expect(list[0]!.Condition).toEqual({
      StringLike: { "s3:prefix": ["data/*"] },
    });
    const logGroup = Object.keys(
      template.findResources("AWS::Logs::LogGroup"),
    ).find((id) => id.startsWith("OpsApiLogs"));
    for (const action of ["logs:CreateLogStream", "logs:PutLogEvents"]) {
      expect(actions.get(action)).toEqual([`${logGroup}.Arn`]);
    }
  });

  it("운영 알림 역할은 기존 운영 SNS 주제·실패 대기열·자기 로그에만 쓴다", () => {
    const notification = roleId("OpsNotificationRole");
    expect(roles[notification]!.Properties.ManagedPolicyArns ?? []).toEqual([]);
    const actions = allowedActionsOfRole(notification);
    expect([...actions.keys()].sort()).toEqual([
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "sns:Publish",
      "sqs:SendMessage",
    ]);
    const topic = Object.keys(template.findResources("AWS::SNS::Topic")).find(
      (id) => id.startsWith("OpsTopic"),
    );
    const logGroup = Object.keys(
      template.findResources("AWS::Logs::LogGroup"),
    ).find((id) => id.startsWith("OpsNotificationLogs"));
    const queue = Object.keys(template.findResources("AWS::SQS::Queue")).find(
      (id) => id.startsWith("OpsNotificationFailures"),
    );
    expect(actions.get("sns:Publish")).toEqual([String(topic)]);
    expect(actions.get("sqs:SendMessage")).toEqual([`${queue}.Arn`]);
    for (const action of ["kms:Decrypt", "kms:GenerateDataKey"]) {
      expect(actions.get(action)).toHaveLength(1);
      expect(actions.get(action)?.[0]).toContain(":kms:ap-northeast-2:");
      expect(actions.get(action)?.[0]).toMatch(/:key\/\*$/);
    }
    for (const action of ["logs:CreateLogStream", "logs:PutLogEvents"]) {
      expect(actions.get(action)).toEqual([`${logGroup}.Arn`]);
    }

    const kmsStatement = allIamPolicies()
      .filter((policy) => policy.roles.includes(notification))
      .flatMap((policy) => policy.statements)
      .find((statement) =>
        toList(statement.Action).includes("kms:GenerateDataKey"),
      );
    expect(kmsStatement?.Condition).toEqual({
      "ForAnyValue:StringEquals": { "kms:ResourceAliases": "alias/aws/sns" },
      StringEquals: { "kms:ViaService": "sns.ap-northeast-2.amazonaws.com" },
    });
  });

  it("Scheduler 역할은 수집 Lambda 함수를 깨우는(lambda:InvokeFunction) 권한만 갖는다", () => {
    const collectorFunctionIds = Object.keys(
      template.findResources("AWS::Lambda::Function"),
    ).filter((id) =>
      /^Collect(Ocean|Warnings|Catalog|Rip|Weather)Function/.test(id),
    );
    expect(collectorFunctionIds).toHaveLength(5);
    const allowedTargets = new Set(
      collectorFunctionIds.flatMap((id) => [`${id}.Arn`, `${id}.Arn:*`]),
    );

    const schedulerRoles = Object.keys(roles).filter((id) =>
      id.startsWith("SchedulerRoleForTarget"),
    );
    for (const role of schedulerRoles) {
      expect(roles[role]!.Properties.ManagedPolicyArns ?? []).toEqual([]);
      const actions = allowedActionsOfRole(role);
      expect([...actions.keys()]).toEqual(["lambda:InvokeFunction"]);
      for (const r of actions.get("lambda:InvokeFunction") ?? []) {
        expect(allowedTargets.has(r), r).toBe(true);
      }
    }
  });

  it("publisher 허용 동작은 S3(data/)·DynamoDB(State 읽기·Ops)·자기 로그뿐이고 관리형 정책이 없다", () => {
    const publisher = roleId("PublisherRole");
    expect(roles[publisher]!.Properties.ManagedPolicyArns ?? []).toEqual([]);
    const actions = allowedActionsOfRole(publisher);
    expect([...actions.keys()].sort()).toEqual([
      "dynamodb:BatchGetItem",
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:PutObject",
    ]);
  });

  it("수집기 PutItem은 State·Ops 테이블에만 허용된다", () => {
    const expected = [
      `${tableId("Ops")}.Arn`,
      `${tableId("State")}.Arn`,
    ].sort();
    for (const name of [
      "Ocean",
      "Warnings",
      "Catalog",
      "Rip",
      "Weather",
    ] as const) {
      const actions = allowedActionsOfRole(roleId(`Collect${name}Role`));
      expect((actions.get("dynamodb:PutItem") ?? []).sort()).toEqual(expected);
    }
  });

  it("문의 역할은 자기 로그·Inquiry 테이블·사진 버킷 객체·문의 알림 주제에만 권한을 갖는다", () => {
    const inquiry = roleId("InquiryInquiryRole");
    expect(roles[inquiry]!.Properties.ManagedPolicyArns ?? []).toEqual([]);

    const photoBuckets = Object.keys(
      template.findResources("AWS::S3::Bucket"),
    ).filter((id) => id.startsWith("InquiryPhotos"));
    expect(photoBuckets).toHaveLength(1);
    const topics = Object.keys(
      template.findResources("AWS::SNS::Topic"),
    ).filter((id) => id.startsWith("InquiryTopic"));
    expect(topics).toHaveLength(1);
    const logGroups = Object.keys(
      template.findResources("AWS::Logs::LogGroup"),
    ).filter((id) => id.startsWith("InquiryLogs"));
    expect(logGroups).toHaveLength(1);

    const actions = allowedActionsOfRole(inquiry);
    expect([...actions.keys()].sort()).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
      "sns:Publish",
    ]);
    for (const action of ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]) {
      expect(actions.get(action)).toEqual([`${photoBuckets[0]}.Arn/*`]);
    }
    expect(actions.get("sns:Publish")).toEqual([`${topics[0]}`]);
    for (const action of ["logs:CreateLogStream", "logs:PutLogEvents"]) {
      expect(actions.get(action)).toEqual([`${logGroups[0]}.Arn`]);
    }
  });
});
