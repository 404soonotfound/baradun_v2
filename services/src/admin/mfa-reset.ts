import {
  AdminDeleteSoftwareTokenCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { actorOf, recordAudit } from "./audit";
import type { Principal } from "./auth";
import type { DataDependencies } from "./handler";
import { errorJson, errorName, json, readJsonBody, safeLog } from "./http";
import type { RequestIds } from "./http";

// 다른 운영자의 2단계 인증(인증 앱) 초기화 (#335, 결정 기록 D16-A9, 화면 설계서 6장 ADM-CONFIRM)
// - 사용자 결정(2026-11-13): 내 계정 화면에서, 대상은 이메일 직접 입력, 운영자 계정이면 역할과 상관없이 누구나
//   데모(샘플) 계정은 허용표(sample: false)에서 막힘. 대상은 운영자 풀 하나에서만 찾음(데모 풀 계정은 '없음')
// - 순서: 대상 찾기(AdminGetUser) → 본인이면 거부 → 인증 앱이 없으면 바꾸지 않고 '이미 없음' → 지우기(AdminDeleteSoftwareToken) → 감사 기록
//   운영자 풀은 MFA 필수라 다음 로그인 때 인증 앱을 다시 등록하게 됨(MFA_SETUP)
// - 결과가 같은 요청을 다시 보내도 두 번째는 '이미 없음'이라 멱등 키를 따로 두지 않음
// - 감사 기록은 Cognito 변경과 한 트랜잭션이 될 수 없음 → 지운 뒤 기록. 기록에 실패하면 500 + 오류 로그(ops_mfa_reset_unaudited)
//   변경 이력에는 이메일을 넣지 않고 대상 계정의 Cognito sub만 남김(D16-B5 '이메일은 남기지 않음')
// - 운영자가 1명이면 인증 앱을 잃은 사람은 로그인하지 못해 이 화면을 쓸 수 없음 → AWS 콘솔 절차(6장)

type Result = APIGatewayProxyStructuredResultV2;
type Operator = Principal & { kind: "operator" };

// 대상 계정 확인 결과. mfa는 인증 앱(TOTP) 등록 여부
export interface OperatorAccount {
  readonly username: string;
  readonly sub: string;
  readonly mfa: boolean;
}

// 운영자 풀 계정 읽기·인증 앱 지우기. 테스트는 가짜로 바꿔 끼움
export interface MfaResetter {
  // 없으면 null
  find(email: string): Promise<OperatorAccount | null>;
  deleteSoftwareToken(username: string): Promise<void>;
}

// 이메일 모양(앞뒤 공백 없음, 254자 이하). 대소문자는 Cognito가 가리지 않음(signInCaseSensitive: false)
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_MAX = 254;

export function parseMfaResetBody(
  value: unknown,
): { ok: true; email: string } | { ok: false; field: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, field: "body" };
  }
  const keys = Object.keys(value);
  const { email } = value as Record<string, unknown>;
  if (keys.length !== 1 || keys[0] !== "email") {
    return { ok: false, field: "body" };
  }
  if (
    typeof email !== "string" ||
    email.length > EMAIL_MAX ||
    !EMAIL.test(email)
  ) {
    return { ok: false, field: "email" };
  }
  return { ok: true, email };
}

// POST /ops/account/mfa-reset { email }
// 200 { result: "reset" | "already_none" } · 404 not_found(reason: account) · 409 conflict(reason: self) · 400 invalid_request
export async function mfaResetRoute(
  event: APIGatewayProxyEventV2,
  principal: Operator,
  data: DataDependencies,
  ids: RequestIds,
): Promise<Result> {
  const resetter = data.mfaReset;
  if (!resetter) throw new Error("2단계 인증 초기화 설정 없음");
  const body = readJsonBody(event);
  if (!body) return errorJson(400, "invalid_request", ids, { field: "body" });
  const check = parseMfaResetBody(body.value);
  if (!check.ok) {
    return errorJson(400, "invalid_request", ids, { field: check.field });
  }
  const account = await resetter.find(check.email);
  if (!account) {
    safeLog("info", "ops_mfa_reset_not_found", { traceId: ids.traceId });
    return errorJson(404, "not_found", ids, { reason: "account" });
  }
  // 본인은 내 계정의 '인증 앱 다시 등록'으로 바꿈(로그인한 채 자기 인증 앱을 지우지 않게)
  if (account.sub === principal.sub) {
    return errorJson(409, "conflict", ids, { reason: "self" });
  }
  if (!account.mfa) {
    safeLog("info", "ops_mfa_reset_already_none", {
      targetSub: account.sub,
      traceId: ids.traceId,
    });
    return json(200, { result: "already_none" }, ids);
  }
  await resetter.deleteSoftwareToken(account.username);
  try {
    await recordAudit(
      data.client,
      data.opsTable,
      {
        actor: actorOf(principal),
        action: "permission.mfa_reset",
        target: { kind: "account", id: account.sub },
        changes: ["mfa"],
        ids,
      },
      data.now(),
    );
  } catch (error) {
    // 인증 앱은 이미 지워짐. 기록이 빠진 변경을 찾을 수 있게 대상 sub와 요청 ID를 남김
    safeLog("error", "ops_mfa_reset_unaudited", {
      targetSub: account.sub,
      actorSub: principal.sub,
      requestId: ids.requestId,
      traceId: ids.traceId,
      error: errorName(error),
    });
    throw error;
  }
  safeLog("info", "ops_mfa_reset", {
    targetSub: account.sub,
    traceId: ids.traceId,
  });
  return json(200, { result: "reset" }, ids);
}

// 운영자 풀 하나에만 묶은 Cognito 호출(infra가 그 풀 ARN에만 AdminGetUser·AdminDeleteSoftwareToken을 줌)
export function cognitoMfaResetter(
  userPoolId: string,
  client = new CognitoIdentityProviderClient({}),
): MfaResetter {
  return {
    async find(email) {
      try {
        // 이메일은 로그인 별칭이라 Username 자리에 그대로 넣을 수 있음
        const user = await client.send(
          new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }),
        );
        const sub = user.UserAttributes?.find((a) => a.Name === "sub")?.Value;
        if (!user.Username || !sub) throw new Error("계정 모양이 틀림");
        return {
          username: user.Username,
          sub,
          // 목록과 선호 설정 중 하나라도 인증 앱이면 있음으로 봄(한쪽이 비어 '이미 없음'으로 잘못 끝나지 않게)
          mfa:
            (user.UserMFASettingList ?? []).includes("SOFTWARE_TOKEN_MFA") ||
            user.PreferredMfaSetting === "SOFTWARE_TOKEN_MFA",
        };
      } catch (error) {
        if (error instanceof UserNotFoundException) return null;
        throw error;
      }
    },
    async deleteSoftwareToken(username) {
      await client.send(
        new AdminDeleteSoftwareTokenCommand({
          UserPoolId: userPoolId,
          Username: username,
        }),
      );
    },
  };
}
