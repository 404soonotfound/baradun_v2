import { describe, expect, it } from "vitest";
import {
  allIamPolicies,
  coversDataPrefix,
  isObjectWrite,
  resourceText,
  template,
  toList,
} from "./stack-template";

// 역할의 논리 ID를 찾아요 (CDK가 이름 뒤에 해시를 붙이므로 앞부분으로 찾기)
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

    for (const policy of allIamPolicies()) {
      // 같은 정책 안에서 data/를 명시적으로 거부하면 제외 (거부가 허용보다 우선)
      const deniesData = policy.statements.some(
        (s) =>
          s.Effect === "Deny" &&
          toList(s.Action).some(isObjectWrite) &&
          toList(s.Resource).map(resourceText).some(coversDataPrefix),
      );
      const allowsData = policy.statements.some(
        (s) =>
          s.Effect === "Allow" &&
          toList(s.Action).some(isObjectWrite) &&
          toList(s.Resource).map(resourceText).some(coversDataPrefix),
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
