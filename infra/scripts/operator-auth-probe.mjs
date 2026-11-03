#!/usr/bin/env node
// 운영자 사용자 풀 실증 도구 (BRD-145). 관리자 앱과 같은 SRP 로그인으로 실제 풀을 확인함.
// - 사용자가 직접 실행함. 배포·계정 생성은 하지 않고, 로그인한 그 계정의 세션만 다룸
// - 토큰·비밀번호·인증 앱 코드는 출력하지 않음. 토큰은 정해 둔 클레임만 골라 보여 줌
// - 인증 앱 등록(first-login)에서만 등록용 비밀키를 한 번 보여 줌(인증 앱에 넣을 값)
//
// 사용법(infra/에서):
//   OPERATOR_USER_POOL_ID=… OPERATOR_CLIENT_ID=… node scripts/operator-auth-probe.mjs <first-login|login>
//   first-login: 임시 비밀번호 → 새 비밀번호 → 인증 앱 등록 → 등록 확인
//   login: 비밀번호(+인증 앱 코드) 로그인 → 클레임 출력 → refresh 갱신 → 옛 refresh 재사용 거부 확인
import { createInterface } from "node:readline";
import {
  CognitoIdentityProviderClient,
  GetTokensFromRefreshTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import cognito from "amazon-cognito-identity-js";

const { AuthenticationDetails, CognitoUser, CognitoUserPool } = cognito;

// 서울 리전 고정(E5). 풀 ID 앞부분과 같아야 함
const REGION = "ap-northeast-2";

// 화면에 보여 줄 클레임. 이메일·전화번호·이름 같은 개인 정보 클레임은 넣지 않음
const SHOWN_CLAIMS = [
  "token_use",
  "client_id",
  "aud",
  "iss",
  "auth_time",
  "iat",
  "exp",
  "amr",
  "acr",
  "cognito:groups",
  "scope",
];

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경 변수가 없음(배포 출력값을 넣음)`);
  return value;
}

// 입력을 화면에 보이지 않게 받음(비밀번호·코드)
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    if (hidden) {
      rl._writeToOutput = (text) => {
        if (text.startsWith(question)) rl.output.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

// 서명은 검증하지 않고 내용만 읽음. 서명·발급자 검증은 운영 API(BRD-146)가 맡음
function claimsOf(jwt) {
  const payload = JSON.parse(
    Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"),
  );
  const shown = {};
  for (const name of SHOWN_CLAIMS) {
    shown[name] = name in payload ? payload[name] : "(없음)";
  }
  // sub는 계정 식별값이라 앞 8자만 보여 줌(샘플 허용 목록 대조용)
  shown.sub =
    typeof payload.sub === "string" ? `${payload.sub.slice(0, 8)}…` : "(없음)";
  for (const key of ["auth_time", "iat", "exp"]) {
    if (typeof payload[key] === "number")
      shown[key] =
        `${payload[key]} (${new Date(payload[key] * 1000).toISOString()})`;
  }
  return shown;
}

function printClaims(label, session) {
  console.log(`\n[${label}] access token 클레임`);
  console.table(claimsOf(session.getAccessToken().getJwtToken()));
  console.log(`[${label}] ID token 클레임`);
  console.table(claimsOf(session.getIdToken().getJwtToken()));
}

function signIn(user, password) {
  return new Promise((resolve, reject) => {
    const callbacks = {
      onSuccess: (session) => resolve({ session }),
      onFailure: reject,
      newPasswordRequired: () =>
        resolve({ challenge: "NEW_PASSWORD_REQUIRED" }),
      totpRequired: () => resolve({ challenge: "SOFTWARE_TOKEN_MFA" }),
      mfaSetup: () => resolve({ challenge: "MFA_SETUP" }),
      mfaRequired: (name) =>
        reject(new Error(`예상하지 않은 MFA 요청: ${name}`)),
      selectMFAType: () => reject(new Error("예상하지 않은 MFA 선택 요청")),
      customChallenge: () =>
        reject(new Error("예상하지 않은 사용자 지정 인증")),
    };
    user.authenticateUser(
      new AuthenticationDetails({
        Username: user.getUsername(),
        Password: password,
      }),
      callbacks,
    );
  });
}

function completeNewPassword(user, newPassword) {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(
      newPassword,
      {},
      {
        onSuccess: (session) => resolve({ session }),
        onFailure: reject,
        totpRequired: () => resolve({ challenge: "SOFTWARE_TOKEN_MFA" }),
        mfaSetup: () => resolve({ challenge: "MFA_SETUP" }),
      },
    );
  });
}

function sendTotp(user, code) {
  return new Promise((resolve, reject) => {
    user.sendMFACode(
      code,
      { onSuccess: resolve, onFailure: reject },
      "SOFTWARE_TOKEN_MFA",
    );
  });
}

function associateTotp(user) {
  return new Promise((resolve, reject) => {
    user.associateSoftwareToken({
      associateSecretCode: resolve,
      onFailure: reject,
    });
  });
}

function verifyTotp(user, code) {
  return new Promise((resolve, reject) => {
    user.verifySoftwareToken(code, "baradun-admin", {
      onSuccess: resolve,
      onFailure: reject,
    });
  });
}

function preferTotp(user) {
  return new Promise((resolve, reject) => {
    user.setUserMfaPreference(
      null,
      { Enabled: true, PreferredMfa: true },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
  });
}

async function login(pool) {
  const email = await ask("이메일: ");
  const user = new CognitoUser({ Username: email, Pool: pool });
  let result = await signIn(user, await ask("비밀번호: ", { hidden: true }));
  console.log(`첫 응답: ${result.challenge ?? "토큰 발급(2단계 요청 없음)"}`);
  if (result.challenge === "NEW_PASSWORD_REQUIRED") {
    result = await chooseNewPassword(user);
    console.log(
      `새 비밀번호 뒤 응답: ${result.challenge ?? "토큰 발급(2단계 요청 없음)"}`,
    );
  }
  const usedTotp = result.challenge === "SOFTWARE_TOKEN_MFA";
  if (usedTotp) {
    result = {
      session: await sendTotp(
        user,
        await ask("인증 앱 코드: ", { hidden: true }),
      ),
    };
  }
  if (result.challenge)
    throw new Error(`처리하지 않는 응답: ${result.challenge}`);
  return { user, session: result.session, usedTotp };
}

// 비밀번호 규칙 실증: 규칙에 안 맞는 비밀번호는 거부 이름을 보여 주고 같은 세션에서 다시 받음
async function chooseNewPassword(user) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const next = await ask("새 비밀번호: ", { hidden: true });
    if (next !== (await ask("새 비밀번호 다시: ", { hidden: true }))) {
      console.log("[거부] 두 입력이 다름. 다시 입력하세요");
      continue;
    }
    try {
      return await completeNewPassword(user, next);
    } catch (error) {
      if (error?.name !== "InvalidPasswordException") throw error;
      console.log(`[거부] ${error.name}: ${error.message}`);
    }
  }
  throw new Error(
    "새 비밀번호를 3번 안에 정하지 못함. 임시 비밀번호로 다시 시작",
  );
}

async function firstLogin(pool) {
  const { user, session, usedTotp } = await login(pool);
  // 이미 등록한 계정에서 다시 등록하면 기존 인증 앱 키가 무효가 되므로 멈춤(초기화는 D16-A9 절차)
  if (usedTotp)
    throw new Error("이미 인증 앱을 등록한 계정. 확인은 login으로 하세요");
  printClaims("등록 전", session);
  const secret = await associateTotp(user);
  console.log(
    "\n인증 앱에 아래 키를 직접 입력해 등록하세요(이 화면 밖에 저장하지 않음).",
  );
  console.log(`  계정 이름: baradun-admin  키: ${secret}`);
  await verifyTotp(user, await ask("인증 앱에 뜬 코드: ", { hidden: true }));
  await preferTotp(user);
  console.log(
    "[완료] 인증 앱 등록·기본 2단계 설정. 이제 login으로 2단계 로그인을 확인하세요.",
  );
}

async function loginAndRefresh(pool, clientId) {
  const { session } = await login(pool);
  printClaims("로그인", session);

  // rotation을 켜면 REFRESH_TOKEN_AUTH 대신 GetTokensFromRefreshToken으로 갱신함
  const client = new CognitoIdentityProviderClient({ region: REGION });
  const firstRefresh = session.getRefreshToken().getToken();
  const refreshed = await client.send(
    new GetTokensFromRefreshTokenCommand({
      ClientId: clientId,
      RefreshToken: firstRefresh,
    }),
  );
  const r = refreshed.AuthenticationResult ?? {};
  console.log(
    `\n[갱신] 새 refresh token 발급: ${r.RefreshToken && r.RefreshToken !== firstRefresh ? "예(회전)" : "아니오"}`,
  );
  if (r.AccessToken) {
    console.log("[갱신] access token 클레임");
    console.table(claimsOf(r.AccessToken));
  }
  if (r.IdToken) {
    console.log("[갱신] ID token 클레임");
    console.table(claimsOf(r.IdToken));
  }

  // 유예 0초라 옛 refresh token은 바로 거부돼야 함
  try {
    await client.send(
      new GetTokensFromRefreshTokenCommand({
        ClientId: clientId,
        RefreshToken: firstRefresh,
      }),
    );
    console.log(
      "[재사용] 옛 refresh token이 받아들여짐 → 기대와 다름, 기록하세요",
    );
  } catch (error) {
    console.log(`[재사용] 옛 refresh token 거부: ${error.name}`);
  }
}

async function main() {
  const mode = process.argv[2];
  const poolId = requiredEnv("OPERATOR_USER_POOL_ID");
  const clientId = requiredEnv("OPERATOR_CLIENT_ID");
  if (!poolId.startsWith(`${REGION}_`))
    throw new Error(`풀 ID가 ${REGION} 풀이 아님`);
  const pool = new CognitoUserPool({ UserPoolId: poolId, ClientId: clientId });
  if (mode === "first-login") await firstLogin(pool);
  else if (mode === "login") await loginAndRefresh(pool, clientId);
  else throw new Error("first-login 또는 login 중 하나를 넘김");
}

try {
  await main();
} catch (error) {
  // 응답 본문에 계정 정보가 섞일 수 있어 오류 이름과 메시지만 보여 줌
  console.error(
    `[실패] ${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
  );
  process.exitCode = 1;
}
