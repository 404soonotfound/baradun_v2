import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";
import {
  OPERATOR_GROUPS,
  OPERATOR_POOL_NAME,
  OPERATOR_SESSION,
  SAMPLE_GROUP,
  SAMPLE_POOL_NAME,
} from "../settings";

// 운영자 로그인 사용자 풀 2개 (BRD-145, 결정 기록 D15-3·D16-A1·A3~A9, 아키텍처 18.2)
// - 운영자 풀: MFA 필수(인증 앱만). 이 풀이 발급한 토큰은 Cognito가 인증 앱을 거친 것으로 봄
// - 샘플 풀: 읽기 전용 샘플 계정만, MFA 없음(비밀번호만)
// - 풀을 나눈 이유: 서울 리전 토큰에 amr·acr이 없어 한 풀(MFA 선택)로는 운영 API가 현재 세션의
//   인증 앱 사용을 확인할 수 없었음(2026-11-03 실증, D16-A7 → I01 채택)
// - 두 풀 공통: Essentials(Plus 제외, A1), 초대(AdminCreateUser)로만 계정 생성, 계정은 코드에 넣지 않음,
//   지워지거나 교체돼도 계정이 남도록 RETAIN + 삭제 보호
export class OperatorAuth extends Construct {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  readonly samplePool: cognito.UserPool;
  readonly sampleClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // 운영자 풀 논리 ID(UserPool)는 첫 배포 때 그대로 둠 → 교체 없이 MFA 설정만 바뀜
    this.userPool = createPool(this, "UserPool", OPERATOR_POOL_NAME, {
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false, email: false },
    });
    this.client = addAdminWebClient(this.userPool);
    // IAM 역할을 연결하지 않으므로 precedence는 두지 않음
    for (const group of OPERATOR_GROUPS) {
      this.userPool.addGroup(`${group.id}Group`, {
        groupName: group.name,
        description: group.description,
      });
    }

    this.samplePool = createPool(this, "SamplePool", SAMPLE_POOL_NAME, {
      mfa: cognito.Mfa.OFF,
    });
    this.sampleClient = addAdminWebClient(this.samplePool);
    this.samplePool.addGroup(`${SAMPLE_GROUP.id}Group`, {
      groupName: SAMPLE_GROUP.name,
      description: SAMPLE_GROUP.description,
    });
  }
}

function createPool(
  scope: Construct,
  id: string,
  userPoolName: string,
  mfa: Pick<cognito.UserPoolProps, "mfa" | "mfaSecondFactor">,
): cognito.UserPool {
  return new cognito.UserPool(scope, id, {
    userPoolName,
    featurePlan: cognito.FeaturePlan.ESSENTIALS,
    selfSignUpEnabled: false,
    signInAliases: { email: true },
    signInCaseSensitive: false,
    autoVerify: { email: true },
    // 이메일을 바꾸면 새 주소를 확인하기 전까지 원래 주소로 로그인·비밀번호 찾기를 유지함
    // (access token의 aws.cognito.signin.user.admin 범위로 자기 속성 변경을 시도해도 확인 없이 바뀌지 않게)
    keepOriginal: { email: true },
    // 비밀번호 찾기는 이메일 코드로만. 전화번호(SMS)는 받지 않음 → SMS 요금·역할 없음
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    // A4 제품 정책값: 12자 이상·숫자 포함·최근 5개 재사용 금지. 대소문자·기호는 요구하지 않음
    // A6: 임시 비밀번호 7일(Cognito 기본값을 명시)
    passwordPolicy: {
      minLength: 12,
      requireDigits: true,
      requireLowercase: false,
      requireUppercase: false,
      requireSymbols: false,
      passwordHistorySize: 5,
      tempPasswordValidity: Duration.days(7),
    },
    ...mfa,
    // 잠금은 Cognito 기본 동작(A5). 위협 보호(Plus 전용)는 켜지 않음
    deletionProtection: true,
    removalPolicy: RemovalPolicy.RETAIN,
  });
}

// 관리자 앱(브라우저)용 클라이언트. 비밀값 없음, SRP 로그인만
// - 호스팅 UI·OAuth 안 씀 → 콜백 URL 없음(관리자 도메인은 BRD-144에서 정함)
// - access·ID 15분, refresh 8시간 + rotation(A3). 유휴 30분·최초 인증 8시간은 앱·API가 강제
//   rotation을 켜면 ALLOW_REFRESH_TOKEN_AUTH 대신 GetTokensFromRefreshToken으로 갱신함
// - 없는 계정·틀린 비밀번호 응답을 같게 함(ADM-RESET '등록 안 된 이메일도 같은 문구')
// - 쓰기 속성은 locale 하나만. 빈 목록은 Cognito가 '기본(표준 속성 모두 쓰기)'으로 처리하므로
//   이메일 등 계정 식별 속성을 사용자가 access token으로 바꾸지 못하게 명시적으로 좁힘
function addAdminWebClient(pool: cognito.UserPool): cognito.UserPoolClient {
  return pool.addClient("AdminWebClient", {
    generateSecret: false,
    authFlows: { userSrp: true },
    disableOAuth: true,
    accessTokenValidity: OPERATOR_SESSION.accessToken,
    idTokenValidity: OPERATOR_SESSION.idToken,
    refreshTokenValidity: OPERATOR_SESSION.refreshToken,
    refreshTokenRotationGracePeriod: OPERATOR_SESSION.refreshRotationGrace,
    preventUserExistenceErrors: true,
    enableTokenRevocation: true,
    writeAttributes: new cognito.ClientAttributes().withStandardAttributes({
      locale: true,
    }),
  });
}
