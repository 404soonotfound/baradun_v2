import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";
import {
  OPERATOR_GROUPS,
  OPERATOR_POOL_NAME,
  OPERATOR_SESSION,
} from "../settings";

// 운영자 로그인 사용자 풀 (BRD-145, 결정 기록 D15-3·D16-A1·A3~A9, 아키텍처 18.2)
// - Essentials 플랜(Plus 제외, A1). 비밀번호 기록(최근 5개)은 Lite에서 못 씀
// - 스스로 가입 불가, 초대(AdminCreateUser)로만 계정 생성. 계정은 콘솔·CLI로 만들고 코드에 넣지 않음
// - 풀 MFA는 optional: 샘플 계정은 비밀번호만 씀. 운영자 계정의 인증 앱 등록 강제·확인은
//   첫 로그인 화면(BRD-148)과 운영 API(BRD-146)가 맡음. 같은 풀 방식이 실증에서 안 되면 풀을 나눔(I01)
// - 사용자 풀은 지워지거나 교체돼도 계정이 남도록 RETAIN + 삭제 보호
export class OperatorAuth extends Construct {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: OPERATOR_POOL_NAME,
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
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false, email: false },
      // 잠금은 Cognito 기본 동작(A5). 위협 보호(Plus 전용)는 켜지 않음
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // 관리자 앱(브라우저)용 클라이언트. 비밀값 없음, SRP 로그인만
    // - 호스팅 UI·OAuth 안 씀 → 콜백 URL 없음(관리자 도메인은 BRD-144에서 정함)
    // - access·ID 15분, refresh 8시간 + rotation(A3). 유휴 30분·최초 인증 8시간은 앱·API가 강제
    //   rotation을 켜면 ALLOW_REFRESH_TOKEN_AUTH 대신 GetTokensFromRefreshToken으로 갱신함
    // - 없는 계정·틀린 비밀번호 응답을 같게 함(ADM-RESET '등록 안 된 이메일도 같은 문구')
    // - 사용자가 자기 속성을 바꾸지 못하게 쓰기 속성 없음
    this.client = this.userPool.addClient("AdminWebClient", {
      generateSecret: false,
      authFlows: { userSrp: true },
      disableOAuth: true,
      accessTokenValidity: OPERATOR_SESSION.accessToken,
      idTokenValidity: OPERATOR_SESSION.idToken,
      refreshTokenValidity: OPERATOR_SESSION.refreshToken,
      refreshTokenRotationGracePeriod: OPERATOR_SESSION.refreshRotationGrace,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      writeAttributes: new cognito.ClientAttributes(),
    });

    // 권한 그룹. 그룹 이름은 토큰의 cognito:groups에 그대로 들어가고 운영 API가 이 값으로 판단함
    // IAM 역할을 연결하지 않으므로 precedence는 두지 않음
    for (const group of OPERATOR_GROUPS) {
      this.userPool.addGroup(`${group.id}Group`, {
        groupName: group.name,
        description: group.description,
      });
    }
  }
}
