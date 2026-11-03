import { describe, expect, it } from "vitest";
import { template } from "./stack-template";

// 운영자 로그인 사용자 풀 (BRD-145, 결정 기록 D16-A1·A3~A8, 아키텍처 18.2)

type Resource = {
  Properties: Record<string, any>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
};

function only(type: string): Resource {
  const found = Object.values(template.findResources(type));
  expect(found).toHaveLength(1);
  return found[0] as Resource;
}

describe("운영자 사용자 풀", () => {
  // 찾기는 각 테스트 안에서 함 → 개수가 틀려도 파일 수집 오류가 아니라 테스트 실패로 보임
  const pool = () => only("AWS::Cognito::UserPool");
  const p = () => pool().Properties;

  it("Essentials 플랜이고 스스로 가입할 수 없다", () => {
    expect(p().UserPoolTier).toBe("ESSENTIALS");
    expect(p().AdminCreateUserConfig).toEqual({
      AllowAdminCreateUserOnly: true,
    });
    expect(p().UsernameAttributes).toEqual(["email"]);
  });

  it("비밀번호는 12자 이상·숫자 포함·최근 5개 재사용 금지, 임시 비밀번호 7일이다", () => {
    expect(p().Policies.PasswordPolicy).toEqual({
      MinimumLength: 12,
      RequireNumbers: true,
      RequireLowercase: false,
      RequireUppercase: false,
      RequireSymbols: false,
      PasswordHistorySize: 5,
      TemporaryPasswordValidityDays: 7,
    });
  });

  it("MFA는 선택이고 인증 앱(TOTP)만 쓴다. 문자·이메일 인증은 없다", () => {
    expect(p().MfaConfiguration).toBe("OPTIONAL");
    expect(p().EnabledMfas).toEqual(["SOFTWARE_TOKEN_MFA"]);
    expect(p().SmsConfiguration).toBeUndefined();
    expect(p().AccountRecoverySetting).toEqual({
      RecoveryMechanisms: [{ Name: "verified_email", Priority: 1 }],
    });
  });

  it("Lambda 트리거·SES 발송·위협 보호·사용자 지정 속성을 쓰지 않는다", () => {
    expect(p().LambdaConfig).toBeUndefined();
    expect(p().EmailConfiguration).toBeUndefined();
    expect(p().UserPoolAddOns).toBeUndefined();
    expect(p().Schema).toBeUndefined();
  });

  it("이메일을 바꿔도 새 주소를 확인하기 전까지 원래 주소를 유지한다", () => {
    expect(p().UserAttributeUpdateSettings).toEqual({
      AttributesRequireVerificationBeforeUpdate: ["email"],
    });
  });

  it("지워지거나 교체돼도 계정이 남는다(삭제 보호 + RETAIN)", () => {
    expect(p().DeletionProtection).toBe("ACTIVE");
    expect(pool().DeletionPolicy).toBe("Retain");
    expect(pool().UpdateReplacePolicy).toBe("Retain");
  });

  it("계정은 코드로 만들지 않는다(사용자·그룹 소속 리소스 없음)", () => {
    template.resourceCountIs("AWS::Cognito::UserPoolUser", 0);
    template.resourceCountIs("AWS::Cognito::UserPoolUserToGroupAttachment", 0);
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 0);
  });
});

describe("관리자 앱 클라이언트", () => {
  const c = () => only("AWS::Cognito::UserPoolClient").Properties;

  it("비밀값 없이 SRP 로그인만 허락하고 OAuth·호스팅 UI를 쓰지 않는다", () => {
    expect(c().GenerateSecret).toBe(false);
    expect(c().ExplicitAuthFlows).toEqual(["ALLOW_USER_SRP_AUTH"]);
    expect(c().AllowedOAuthFlowsUserPoolClient).toBe(false);
    expect(c().AllowedOAuthFlows).toBeUndefined();
    expect(c().CallbackURLs).toBeUndefined();
  });

  it("access·ID 15분, refresh 8시간 + rotation이다", () => {
    expect(c().AccessTokenValidity).toBe(15);
    expect(c().IdTokenValidity).toBe(15);
    expect(c().RefreshTokenValidity).toBe(480);
    expect(c().TokenValidityUnits).toEqual({
      AccessToken: "minutes",
      IdToken: "minutes",
      RefreshToken: "minutes",
    });
    expect(c().RefreshTokenRotation).toEqual({
      Feature: "ENABLED",
      RetryGracePeriodSeconds: 0,
    });
  });

  it("없는 계정 응답을 숨기고, 토큰 폐기를 켜고, 사용자가 쓸 수 있는 속성은 locale뿐이다", () => {
    expect(c().PreventUserExistenceErrors).toBe("ENABLED");
    expect(c().EnableTokenRevocation).toBe(true);
    expect(c().WriteAttributes).toEqual(["locale"]);
  });
});

describe("권한 그룹", () => {
  const groups = Object.values(
    template.findResources("AWS::Cognito::UserPoolGroup"),
  ).map((g) => (g as Resource).Properties);

  it("보기·편집·노출 변경·샘플 4개이고 IAM 역할을 연결하지 않는다", () => {
    expect(groups.map((g) => g.GroupName).sort()).toEqual([
      "editor",
      "publisher",
      "sample",
      "viewer",
    ]);
    for (const g of groups) {
      expect(g.RoleArn).toBeUndefined();
      expect(g.Precedence).toBeUndefined();
    }
  });
});
