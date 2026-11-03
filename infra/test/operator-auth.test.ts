import { describe, expect, it } from "vitest";
import { OPERATOR_POOL_NAME, SAMPLE_POOL_NAME } from "../lib/settings";
import { template } from "./stack-template";

// 운영자 로그인 사용자 풀 (BRD-145, 결정 기록 D16-A1·A3~A8, 아키텍처 18.2)
// 운영자 풀(MFA 필수)과 샘플 풀(MFA 없음)로 나눔(D16-A7 실증, 2026-11-03)

type Resource = {
  Properties: Record<string, any>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
};

// 찾기는 각 테스트 안에서 함 → 개수가 틀려도 파일 수집 오류가 아니라 테스트 실패로 보임
function pools(): Record<string, Resource> {
  return template.findResources("AWS::Cognito::UserPool") as Record<
    string,
    Resource
  >;
}

// 이름으로 풀 하나와 논리 ID를 찾음(클라이언트·그룹이 Ref로 가리키는 값)
function pool(name: string): { id: string; resource: Resource } {
  const found = Object.entries(pools()).filter(
    ([, r]) => r.Properties.UserPoolName === name,
  );
  expect(found).toHaveLength(1);
  return { id: found[0]![0], resource: found[0]![1] };
}

function belongingTo(type: string, name: string): Resource[] {
  const { id } = pool(name);
  return Object.values(template.findResources(type)).filter(
    (r) => (r as Resource).Properties.UserPoolId?.Ref === id,
  ) as Resource[];
}

const POOL_NAMES = [OPERATOR_POOL_NAME, SAMPLE_POOL_NAME];

describe("사용자 풀 공통", () => {
  it("운영자 풀과 샘플 풀 두 개다", () => {
    expect(
      Object.values(pools())
        .map((r) => r.Properties.UserPoolName)
        .sort(),
    ).toEqual([...POOL_NAMES].sort());
  });

  it("운영자 풀·클라이언트는 첫 배포 논리 ID를 유지한다(교체되면 계정·인증 앱 등록이 새 풀에 없음)", () => {
    expect(pool(OPERATOR_POOL_NAME).id).toBe("OperatorAuthUserPool43F3839A");
    expect(
      template.findResources("AWS::Cognito::UserPoolClient")[
        "OperatorAuthUserPoolAdminWebClient683D566A"
      ],
    ).toBeDefined();
  });

  it("Essentials 플랜이고 스스로 가입할 수 없다", () => {
    for (const name of POOL_NAMES) {
      const p = pool(name).resource.Properties;
      expect(p.UserPoolTier, name).toBe("ESSENTIALS");
      expect(p.AdminCreateUserConfig, name).toEqual({
        AllowAdminCreateUserOnly: true,
      });
      expect(p.UsernameAttributes, name).toEqual(["email"]);
    }
  });

  it("비밀번호는 12자 이상·숫자 포함·최근 5개 재사용 금지, 임시 비밀번호 7일이다", () => {
    for (const name of POOL_NAMES) {
      expect(
        pool(name).resource.Properties.Policies.PasswordPolicy,
        name,
      ).toEqual({
        MinimumLength: 12,
        RequireNumbers: true,
        RequireLowercase: false,
        RequireUppercase: false,
        RequireSymbols: false,
        PasswordHistorySize: 5,
        TemporaryPasswordValidityDays: 7,
      });
    }
  });

  it("문자 인증·Lambda 트리거·SES 발송·위협 보호·사용자 지정 속성을 쓰지 않는다", () => {
    for (const name of POOL_NAMES) {
      const p = pool(name).resource.Properties;
      expect(p.SmsConfiguration, name).toBeUndefined();
      expect(p.LambdaConfig, name).toBeUndefined();
      expect(p.EmailConfiguration, name).toBeUndefined();
      expect(p.UserPoolAddOns, name).toBeUndefined();
      expect(p.Schema, name).toBeUndefined();
      expect(p.AccountRecoverySetting, name).toEqual({
        RecoveryMechanisms: [{ Name: "verified_email", Priority: 1 }],
      });
    }
  });

  it("이메일을 바꿔도 새 주소를 확인하기 전까지 원래 주소를 유지한다", () => {
    for (const name of POOL_NAMES) {
      expect(
        pool(name).resource.Properties.UserAttributeUpdateSettings,
        name,
      ).toEqual({ AttributesRequireVerificationBeforeUpdate: ["email"] });
    }
  });

  it("지워지거나 교체돼도 계정이 남는다(삭제 보호 + RETAIN)", () => {
    for (const name of POOL_NAMES) {
      const { resource } = pool(name);
      expect(resource.Properties.DeletionProtection, name).toBe("ACTIVE");
      expect(resource.DeletionPolicy, name).toBe("Retain");
      expect(resource.UpdateReplacePolicy, name).toBe("Retain");
    }
  });

  it("계정은 코드로 만들지 않는다(사용자·그룹 소속·도메인 리소스 없음)", () => {
    template.resourceCountIs("AWS::Cognito::UserPoolUser", 0);
    template.resourceCountIs("AWS::Cognito::UserPoolUserToGroupAttachment", 0);
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 0);
  });
});

describe("MFA", () => {
  it("운영자 풀은 MFA 필수이고 인증 앱(TOTP)만 쓴다", () => {
    const p = pool(OPERATOR_POOL_NAME).resource.Properties;
    expect(p.MfaConfiguration).toBe("ON");
    expect(p.EnabledMfas).toEqual(["SOFTWARE_TOKEN_MFA"]);
  });

  it("샘플 풀은 MFA를 쓰지 않는다", () => {
    const p = pool(SAMPLE_POOL_NAME).resource.Properties;
    expect(p.MfaConfiguration).toBe("OFF");
    expect(p.EnabledMfas).toBeUndefined();
  });
});

describe("관리자 앱 클라이언트", () => {
  it("풀마다 하나씩이다", () => {
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 2);
    for (const name of POOL_NAMES) {
      expect(
        belongingTo("AWS::Cognito::UserPoolClient", name),
        name,
      ).toHaveLength(1);
    }
  });

  it("비밀값 없이 SRP 로그인만 허락하고 OAuth·호스팅 UI를 쓰지 않는다", () => {
    for (const name of POOL_NAMES) {
      const c = belongingTo("AWS::Cognito::UserPoolClient", name)[0]!
        .Properties;
      expect(c.GenerateSecret, name).toBe(false);
      expect(c.ExplicitAuthFlows, name).toEqual(["ALLOW_USER_SRP_AUTH"]);
      expect(c.AllowedOAuthFlowsUserPoolClient, name).toBe(false);
      expect(c.AllowedOAuthFlows, name).toBeUndefined();
      expect(c.CallbackURLs, name).toBeUndefined();
    }
  });

  it("access·ID 15분, refresh 8시간 + rotation이다", () => {
    for (const name of POOL_NAMES) {
      const c = belongingTo("AWS::Cognito::UserPoolClient", name)[0]!
        .Properties;
      expect(c.AccessTokenValidity, name).toBe(15);
      expect(c.IdTokenValidity, name).toBe(15);
      expect(c.RefreshTokenValidity, name).toBe(480);
      expect(c.TokenValidityUnits, name).toEqual({
        AccessToken: "minutes",
        IdToken: "minutes",
        RefreshToken: "minutes",
      });
      expect(c.RefreshTokenRotation, name).toEqual({
        Feature: "ENABLED",
        RetryGracePeriodSeconds: 0,
      });
    }
  });

  it("없는 계정 응답을 숨기고, 토큰 폐기를 켜고, 사용자가 쓸 수 있는 속성은 locale뿐이다", () => {
    for (const name of POOL_NAMES) {
      const c = belongingTo("AWS::Cognito::UserPoolClient", name)[0]!
        .Properties;
      expect(c.PreventUserExistenceErrors, name).toBe("ENABLED");
      expect(c.EnableTokenRevocation, name).toBe(true);
      expect(c.WriteAttributes, name).toEqual(["locale"]);
    }
  });
});

describe("권한 그룹", () => {
  const groupNames = (name: string) =>
    belongingTo("AWS::Cognito::UserPoolGroup", name)
      .map((g) => g.Properties.GroupName)
      .sort();

  it("운영자 풀은 보기·편집·노출 변경, 샘플 풀은 샘플 그룹만 둔다", () => {
    expect(groupNames(OPERATOR_POOL_NAME)).toEqual([
      "editor",
      "publisher",
      "viewer",
    ]);
    expect(groupNames(SAMPLE_POOL_NAME)).toEqual(["sample"]);
    template.resourceCountIs("AWS::Cognito::UserPoolGroup", 4);
  });

  it("그룹에 IAM 역할·우선순위를 연결하지 않는다", () => {
    for (const g of Object.values(
      template.findResources("AWS::Cognito::UserPoolGroup"),
    )) {
      expect((g as Resource).Properties.RoleArn).toBeUndefined();
      expect((g as Resource).Properties.Precedence).toBeUndefined();
    }
  });
});
