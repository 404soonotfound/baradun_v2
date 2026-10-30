import { describe, expect, it } from "vitest";
import {
  allIamPolicies,
  coversDataPrefix,
  isObjectWrite,
  resourceText,
  template,
  toList,
} from "./stack-template";
import { GITHUB_OIDC_SUBJECT } from "../lib/settings";

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
        roleId("InquiryInquiryRole"),
      ].sort(),
    );
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
      ]),
    });
    expect(
      [...byResource.keys()].some((r) => r.startsWith(tableId("Inquiry"))),
    ).toBe(false);
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

  it("스택의 IAM 역할은 수집 4·publisher·문의·배포·Scheduler 대상 역할뿐이다", () => {
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
        roleId("PublisherRole"),
        roleId("InquiryInquiryRole"),
        roleId("DeployRole"),
        ...schedulerRoles,
      ].sort(),
    );
  });

  it("Scheduler 역할은 수집 Lambda 함수를 깨우는(lambda:InvokeFunction) 권한만 갖는다", () => {
    const collectorFunctionIds = Object.keys(
      template.findResources("AWS::Lambda::Function"),
    ).filter((id) => /^Collect(Ocean|Warnings|Catalog|Rip)Function/.test(id));
    expect(collectorFunctionIds).toHaveLength(4);
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
    for (const name of ["Ocean", "Warnings", "Catalog", "Rip"] as const) {
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
