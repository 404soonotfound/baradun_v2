# infra

AWS CDK(TypeScript) 스택입니다. 구성(S3 사이트·데이터 버킷, CloudFront, DynamoDB, Scheduler, GitHub OIDC, Budgets)의 기준은 Notion 'V2 아키텍처 기준 문서' 11장입니다.

```bash
npm run build -w @baradun/infra             # 타입 검사(tsc)
npm run test -w @baradun/infra              # Vitest (스택 템플릿·권한·가드레일)
npm run check:iam-actions -w @baradun/infra # synth 뒤 고정 IAM·서울 CFN 스키마 대조 (오프라인)
npx cdk synth                               # CloudFormation 템플릿 생성 (infra/에서)
npx cdk diff --method=change-set            # 배포된 스택과 변경 세트 비교
```

사이트 자동 배포(`.github/workflows/deploy.yml`, `npm run deploy:prod`)는 GitHub OIDC로 사이트 전용 역할(`DeployRole`)을 맡아 S3 파일 동기화와 CloudFront 캐시 무효화만 수행하며, CloudFormation이나 CDK 실행 정책을 거치지 않습니다.

인프라 스택 배포는 요청이 있을 때만 사람이 실행하고, 최신 `origin/main`을 꺼낸 배포용 작업 트리에서 합니다. 작업 중인 브랜치에서 배포하면 머지되지 않은 코드가 실환경에 올라갑니다. 아래 명령 하나가 그 순서를 모두 합니다(BRD-169, `infra/scripts/deploy.mjs`).

```bash
cd ../baradun_v2-deploy && npm run deploy:infra   # 프로필 기본값: AWS_PROFILE, 없으면 soo-login
npm run deploy:infra -- --profile baradun-admin   # 다른 프로필
```

배포용 폴더에서 실행합니다. 처음 한 번은 폴더를 만들거나 이 명령이 있는 커밋으로 맞춥니다: `git fetch origin && git worktree add --detach ../baradun_v2-deploy origin/main && cd ../baradun_v2-deploy && npm ci`(이미 있으면 `git checkout --detach origin/main && npm ci`). 실행 중인 명령이 배포할 커밋의 명령과 다르면 멈추고, 배포용 폴더라면 한 번 더 실행하라고 안내합니다(예전 절차로 배포하지 않게).

1. `origin/main` 최신 커밋의 `ci-ok`가 성공인지 확인합니다(GitHub CLI 로그인 필요). 도는 중·실패·결과 없음이면 배포용 폴더를 옮기지 않고 멈춥니다. `ci-ok`는 다른 검사가 모두 끝나야 생기므로, 아직 없더라도 그 커밋의 CI가 돌고 있으면 '도는 중'으로 안내합니다.
2. 배포용 작업 트리(저장소 옆 `{저장소}-deploy`, `BARADUN_DEPLOY_DIR`로 바꿀 수 있음)를 그 커밋으로 맞춥니다. 없으면 만들고, 고친 파일이 있으면 멈춥니다.
3. `npm ci`
4. aws 명령(조회·실행·대기)은 프로필을 그대로 써서 `aws login` 키가 스스로 갱신됩니다(셸에 남은 예전 키 환경 변수는 지움). cdk에만 변경 세트를 만들기 직전에 내보낸 임시 키를 넘기고, 5분 안에 만료되면 멈춥니다. 로그인이 안 돼 있으면 `aws login --profile <프로필>` 안내를 띄우고 멈춥니다. 스택이 진행 중·실패 상태여도 멈춥니다.
5. `cdk deploy --no-execute`로 변경 세트 `deploy-{커밋 7자}-{UTC 시각}`만 만들고, 바뀌는 리소스를 표로 보여 줍니다. 줄 앞 표시는 `!!` 삭제·교체(테이블·버킷·사용자 풀·로그 그룹·대기열·KMS 키처럼 데이터를 담는 리소스는 '교체될 수도 있음'도 포함, 빨간 경고), `**` 권한 리소스, `~` 그 밖의 '교체될 수도 있음'(속성 값이 배포 때 정해져 미리 모른다는 뜻, 대개 교체되지 않음), `*~` 교체될 수도 있는 권한 리소스입니다. 함수 URL(`AWS::Lambda::Url`)은 함수가 바뀔 때마다 '교체될 수도 있음'으로 나와 `~`로 두지만, 관리자 사이트가 그 주소에 연결된 뒤(BRD-147)에는 배포 뒤 주소가 그대로인지 확인합니다. 배포마다 바뀌는 `AWS::CDK::Metadata`는 표시하지 않습니다. 바뀐 것이 없으면 그렇게 알리고 끝냅니다.
6. `yes`를 입력할 때만 변경 세트를 실행하고 끝날 때까지 기다립니다. 다른 입력이면 변경 세트를 남기고, 지우는 명령을 보여 줍니다. 확인하지 못하면(실패·롤백·1시간 넘게 진행 중) 이번 실행의 실패 이벤트를 보여 줍니다. 진행 중이면 다시 배포하지 않습니다.

스택 파라미터(`AlertEmail` 등)는 넘기지 않아 이전 값을 그대로 씁니다(아래 '배포'). 파라미터를 바꾸거나 `cdk bootstrap`처럼 다른 명령이 필요한 배포는 이 명령 대신 각 절의 절차를 따릅니다.

## 운영 도메인 연결 (BRD-162)

대표 주소는 `https://www.baradun.app`입니다(2026-11-02 사용자 결정).

- 가비아 DNS는 루트 주소에 CNAME을 걸 수 없어서 www만 CloudFront로 보냅니다.
- 루트 주소(`baradun.app`)는 지금처럼 Vercel(V1 프로젝트)이 www로 넘깁니다. 비용은 0원입니다.
- 전환은 **출시일**에 합니다. 그 전까지 스택 매개변수 `SiteDomainName`·`SiteCertificateArn`은 비워 둡니다. 비어 있으면 대체 도메인·인증서를 붙이지 않고, 주소 변환 함수도 이동하지 않습니다(지금과 같은 동작).

값을 넣으면 다음처럼 동작합니다.

- CloudFront에 대체 도메인과 인증서를 붙입니다(SNI, `TLSv1.2_2021`).
- 다른 호스트(`*.cloudfront.net` 등)로 온 페이지 주소 요청은 대표 주소의 같은 경로·쿼리로 301 이동합니다(`lib/site/rewrite-index.ts`). 파일 주소(`/data/`·`/_next/`·`sw.js`)는 이동하지 않습니다. 예전 주소에 남은 저장본 화면이 바다 정보를 받다가 다른 출처로 넘어가 막히지 않게 하려는 것입니다.
- 두 값은 함께 넣거나 함께 비워야 합니다. 하나만 넣으면 CloudFormation 규칙(`SiteDomainNeedsCertificate`)이 배포 시작 전에 거부합니다.
- 실행 정책은 바꾸지 않아도 됩니다. ACM 인증서를 API로 붙이는 데 CloudFront 권한만 필요합니다([CloudFront 권한 예시](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/security_iam_id-based-policy-examples.html)). 공식 스키마의 배포 Update 핸들러 권한에도 ACM은 없습니다.

### 미리 할 일 (출시 하루 전까지)

1. **웹 운영 주소 상수**: `apps/web/src/lib/site-env.ts`의 `PRODUCTION_SITE_ORIGIN`을 `https://www.baradun.app`으로 바꾼 PR이 main에 있어야 합니다(BRD-144). 이 값과 저장소 변수 `SITE_URL`이 같아야 운영 빌드(GA·색인·robots·sitemap)가 됩니다.
2. **인증서 요청**: ACM 인증서를 **us-east-1**에 요청합니다. CloudFront는 이 리전 인증서만 받습니다.

   ```bash
   AWS_PROFILE=baradun-admin aws acm request-certificate --region us-east-1 \
     --domain-name www.baradun.app --validation-method DNS
   AWS_PROFILE=baradun-admin aws acm describe-certificate --region us-east-1 \
     --certificate-arn <위 결과의 CertificateArn> \
     --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
   ```

3. **검증 CNAME 추가**: 가비아 DNS 관리에 위 결과의 검증 CNAME(`_xxxx.www` → `_yyyy.acm-validations.aws.`)을 추가합니다. 상태가 `ISSUED`가 될 때까지 기다립니다. 이 레코드는 지우지 않습니다(자동 갱신에 씀).
4. **TTL 낮추기**: 가비아에서 `www` CNAME의 TTL을 300초로 낮춰 둡니다(지금 600초). 전환과 되돌리기가 빨리 퍼집니다.

### 출시일 전환 순서

1. **자동 배포 멈춤**: 저장소 변수 `DEPLOY_PAUSED=true`.
2. **스택 배포**: 최신 `origin/main` 작업 트리에서 도메인·인증서 값을 넣어 배포합니다(맨 위 배포 절차).

   ```bash
   AWS_PROFILE=baradun-admin npx cdk diff --method=change-set \
     --parameters SiteDomainName=www.baradun.app \
     --parameters SiteCertificateArn=<인증서 ARN>
   AWS_PROFILE=baradun-admin npx cdk deploy \
     --parameters SiteDomainName=www.baradun.app \
     --parameters SiteCertificateArn=<인증서 ARN>
   ```

   다음 배포부터는 CloudFormation이 이 값을 그대로 씁니다. 이때부터 CloudFront 기본 주소의 페이지는 www로 이동합니다. www는 아직 Vercel을 가리키므로, 기본 주소로 온 사람은 3단계 전까지 V1 점검 화면을 봅니다.

3. **가비아 www CNAME 변경**: `www` CNAME을 Vercel 주소에서 CloudFront 배포 도메인(`d1gam1q4z69v8c.cloudfront.net`, 출력값 `DistributionDomainName`)으로 바꿉니다.
4. **저장소 변수 변경**: `gh variable set SITE_URL --body https://www.baradun.app` 하고 `DEPLOY_PAUSED`를 지운 뒤 `npm run deploy:prod`로 사이트를 다시 배포합니다. 이 빌드부터 GA·색인·robots·sitemap이 켜집니다.
5. **V1 Vercel 프로젝트 정리**
   - 도메인 목록에서 `www.baradun.app`을 빼고 `baradun.app`만 남깁니다.
   - `vercel.json`에 `{"redirects":[{"source":"/(.*)","destination":"https://www.baradun.app/","permanent":false}]}`를 넣어 다시 배포합니다. V1 경로는 V2에 없어서 모두 첫 화면으로 보냅니다. 안정되면 `permanent: true`로 바꿉니다(BRD-98).
6. **확인**
   - `curl -sI https://www.baradun.app/`: 200, 보안 헤더 6종
   - `curl -sI https://d1gam1q4z69v8c.cloudfront.net/spots/gangmun/`: 301, `location: https://www.baradun.app/spots/gangmun/`
   - `curl -sI https://baradun.app/`: www로 이동
   - `curl -s https://www.baradun.app/robots.txt`: 운영용 내용
   - 운영 페이지에 noindex가 없음
   - GA 실시간 보고서에 방문이 보임
   - 브라우저 콘솔에 CSP 위반이 없음

### 되돌리기

순서대로 합니다. 5단계(V1 Vercel 정리)까지 한 뒤라면 Vercel부터 되돌려야 www가 V1을 다시 보여 줄 수 있습니다.

1. **Vercel 복구 (5단계를 했을 때만)**
   - V1 프로젝트 도메인 목록에 `www.baradun.app`을 다시 추가합니다.
   - `vercel.json`에서 `https://www.baradun.app/`으로 보내는 리디렉션을 빼고(전환 전 설정) 다시 배포합니다. 남겨 두면 www가 자기 자신으로 계속 이동합니다.
2. **가비아 www CNAME 복구**: `www` CNAME을 Vercel이 도메인 화면에서 안내하는 주소로 되돌립니다(전환 전 값은 `2e9e02c1d516eeff.vercel-dns-017.com.`, 다시 추가하면 바뀔 수 있음).
3. **CloudFront 복구**: 두 매개변수를 비워 다시 배포합니다.

   ```bash
   AWS_PROFILE=baradun-admin npx cdk deploy \
     --parameters SiteDomainName= --parameters SiteCertificateArn=
   ```

4. **사이트 재배포**: `SITE_URL`을 CloudFront 기본 주소로 되돌리고 `npm run deploy:prod` 합니다.

## CDK 실행 정책과 역할 권한 상한

CloudFormation 실행 역할(`cdk-hnb659fds-cfn-exec-role-<계정>-ap-northeast-2`)에는 `AdministratorAccess` 대신 최소 권한 고객 관리형 정책 두 개를 상시 부착합니다(BRD-121). IAM 고객 관리형 정책 한도(공백 제외 6,144자, 증액 불가) 안에 들도록 서비스 묶음별로 파일을 나누어 둘 다 붙여 둡니다.

- `bootstrap/cfn-execution-policy.json` (`BaradunCdkExecution`): 사이트 전달·보안(`s3`, `cloudfront`, `wafv2`), IAM 역할·권한 상한·GitHub OIDC(`iam`), CDK 부트스트랩 자산·버전 파라미터 읽기(`s3:GetObject`, `ssm:GetParameter`·`GetParameters`)
- `bootstrap/cfn-execution-workload-policy.json` (`BaradunCdkExecutionWorkload`): 백엔드 테이블(`dynamodb`), 수집·게시·문의 함수(`lambda`), 로그 그룹(`logs`), 일정(`scheduler`), 알림(`sns`), 운영 경보(`cloudwatch`), 월 예산(`budgets`)

실행 정책 작성 규칙은 `test/guardrails.test.ts`와 `scripts/check-iam-actions.mjs`로 검사합니다.

Vitest는 `test/fixtures/iam-actions.json`과 정책·검토된 핸들러 표를 대조합니다. CI는 synth 뒤 `check:iam-actions`로 `test/fixtures/aws-permission-reference.json`에 고정한 공식 자료에도 대조합니다. 이 고정본은 [공개 IAM 권한 참조](https://docs.aws.amazon.com/service-authorization/latest/reference/service-reference.html)의 전체 Action 이름·리소스/조건 정보·사용 중인 스키마 API의 매핑과 [서울 CloudFormation 공개 스키마 ZIP](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/resource-type-schemas.html)의 실제 리소스별 `handlers`·`tagging`을 추출한 것입니다. 원본 URL·SHA-256·검증일을 함께 기록합니다. 정책과 Action 스냅샷 자체를 모두 대조하므로, 서로 같은 오타를 넣어도 실패합니다. PR 필수 검사는 네트워크 없이 실행돼 외부 자료 변경·일시 장애가 PR을 막지 않습니다.

최신 자료는 별도 `IAM official reference audit` 워크플로가 매주 월요일 09:00 KST와 수동 실행 때 검사합니다. `--check-latest`는 검증 입력의 변경이나 다운로드 실패를 해당 실행의 실패로 보고하며 PR의 `ci-ok`에는 연결하지 않습니다. GitHub Actions 알림 설정에서 이 감사 워크플로의 실패 알림을 활성화해야 변경을 알 수 있습니다. 자동 이슈 생성·자동 갱신은 하지 않습니다. 새 리소스 종류를 추가하거나 감사에서 차이가 나면 `npm run check:iam-actions -w @baradun/infra -- --update-reference`로 검토한 고정본을 갱신하고 변경 PR을 만듭니다. 온라인 모드만 공개 문서 네트워크와 `unzip`을 사용합니다. 서비스별 IAM 참조는 병렬 요청·15초 제한, ZIP 다운로드는 45초, 선택 파일 일괄 해제는 15초로 제한하고 실패 시 원인을 표시합니다. AWS 계정 API·자격증명은 사용하지 않습니다.

스키마의 API 이름은 공식 API→IAM 매핑으로 변환하며, 빈 매핑은 허용으로 처리하지 않습니다. 선택 기능 때문에 제외한 권한과 이유는 `scripts/cfn-permission-exclusions.json`에 기록하고, 해당 속성이 템플릿에서 사용되면 실패합니다. 참조에 없는 문자열은 `notInReference`로 표시하며 공식 Action 또는 Operation에 등장하면 제외가 만료돼 검사가 실패합니다. 근거만 적은 무조건 제외는 허용하지 않습니다. API 원문에 대한 미사용 속성 제외를 먼저 검사하므로 S3 복제의 PassRole을 Lambda 허용으로 오인하지 않습니다. 허용 작업도 SAR의 리소스 종류와 조건별 근거를 검사합니다. 리전 조건은 Logs·CloudWatch, PassRole은 Lambda·Scheduler, boundary는 실제 역할의 상한, 태그 조건은 스키마 지원과 모든 대상의 명시적 태그에 대조합니다. 미검토 조건과 지원하지 않는 예약 태그 조건은 실패합니다. 이 검사는 IAM 시뮬레이터가 아니며 모든 물리 ARN·인가 문맥·실제 핸들러 동작을 증명하지 않습니다. 함수·예산의 실제 이름은 별도 합성 테스트로 ARN 패턴에 대조합니다. `list` 핸들러는 스택 CRUD 범위 밖이며 공개 `handlers`가 없는 Budgets는 SAR 기반 Vitest 표로 별도 검사합니다. `--write-snapshot`은 검증 성공 후 Action 스냅샷을 갱신합니다.

CloudFront 함수·배포의 스키마는 `cloudFormationSystemTags: false`이므로 `aws:cloudformation:*` 태그에 의존하지 않습니다([스키마 정의](https://docs.aws.amazon.com/cloudformation-cli/latest/userguide/resource-type-schema.html)). 함수는 이름 기반 ARN으로 제한합니다. 배포에는 CDK에서 사용자 태그 `baradun:stack = BaradunV2`를 명시하고 기존 작업은 이 `ResourceTag`, 생성·태그 선반영은 `CloudFrontTagOnCreate`의 같은 `RequestTag`로 제한합니다. 기존 배포에는 아래 순서로 태그를 먼저 반영해야 합니다. **사용자 태그는 강한 격리 경계가 아닙니다**. 계정 내 다른 배포에도 실행 역할이 `TagResource`로 이 태그를 붙인 뒤 관리할 수 있는 위험이 남습니다. OAC·응답 헤더 정책도 ResourceTag를 지원하지 않아 계정 안의 해당 종류 전체를 관리할 수 있습니다. 네 Create 작업은 ARN 제한을 지원하지 않아 `Resource: "*"`가 남습니다. 더 강한 격리에는 확인한 물리 ID의 ARN을 고정하거나 foundation 스택을 분리해야 합니다. 실제 생성 시 태그 전달과 기존 배포의 태그 존재는 실환경에서 미검증입니다.

- 서비스 단위 와일드카드(`s3:*`, `cloudfront:*` 등)와 데이터 평면 작업(S3 객체 읽기·쓰기·삭제, DynamoDB 항목 조회·쓰기·스캔, `lambda:Invoke*`, 로그 이벤트 조회·쓰기)은 주지 않습니다. 유일한 예외는 Lambda 코드 배포 때 읽는 서울 리전 CDK 자산 버킷(`cdk-hnb659fds-assets-${aws:PrincipalAccount}-ap-northeast-2/*`)의 `s3:GetObject`(`ReadLambdaCodeAssets`)입니다.
- `Resource` ARN의 다섯 번째 콜론 이전(리전·계정 자리)에는 IAM이 정책 변수(`${aws:PrincipalAccount}`)를 허용하지 않으므로 계정 번호(`717304679248`)와 리전(`ap-northeast-2`, CloudFront용 WAF는 `us-east-1`)을 고정합니다(BRD-93, BRD-121). 다섯 번째 콜론 뒤(리소스 이름 자리)인 CDK 자산 버킷 이름과 `Condition` 값에는 정책 변수를 그대로 씁니다. 다른 계정에 배포할 때는 `bootstrap/*.json`과 `test/guardrails.test.ts`의 계정 번호를 함께 바꿉니다.
- 리소스 수준 권한을 지원하지 않는 작업만 `Resource: "*"`로 둡니다. 리전 서비스인 로그 그룹 목록 읽기(`logs:DescribeLogGroups`, CloudFormation이 로그 그룹 `GetAtt`를 읽을 때 필요)와 경보 조회(`cloudwatch:DescribeAlarms`)에는 `aws:RequestedRegion: ap-northeast-2` 조건을 걸고, 전역 서비스인 CloudFront 생성 작업(`cloudfront:CreateDistribution`·`CreateFunction`·`CreateOriginAccessControl`·`CreateResponseHeadersPolicy`)에는 리전 조건을 걸지 않습니다.

### 역할 권한 상한 (Permissions Boundary)

스택이 만드는 모든 역할에는 권한 상한(permissions boundary) `BaradunV2-RoleBoundary`(`bootstrap/role-boundary-policy.json`)가 붙습니다(BRD-89). 실행 정책은 이 boundary가 붙은 역할만 만들고 인라인 정책을 바꾸게 허락하며, 관리형 정책 부착·boundary 떼기(`NoBoundaryRemoval`)·boundary 정책 고치기(`NoBoundaryPolicyEdit`)는 거부합니다.

역할 정책에 새 동작을 추가하면 boundary에도 넣어야 합니다. 빠지면 실행할 때 거부됩니다. `test/guardrails.test.ts`는 빠진 동작 이름만 잡으므로, 새 리소스를 쓰면 boundary의 `Resource` ARN 범위를 직접 확인합니다.

API 키 읽기(`ssm:GetParameter`)는 boundary에서 스택의 Lambda 함수가 보낸 요청(`lambda:SourceFunctionArn`)으로만 허락합니다. IAM 정책 시뮬레이터는 이 조건 키를 평가하지 못하므로, 수집기를 처음 배포할 때 키 읽기가 되는지 로그로 확인합니다(막히면 `api_key` 실패로 기록됨).

### 정책 적용과 되돌리기 절차

boundary 정책과 실행 정책은 스택 밖에서 관리자 권한으로 관리합니다. 아래 절차는 저장소 루트에서 시작하고 같은 셸을 유지합니다. 먼저 기존 정상 관리자 프로필이나 아래에서 검증한 `baradun-admin` 프로필을 선택합니다. 새 관리자 역할 전환과 실행 정책 변경은 각각 검증한 뒤 진행합니다.

```bash
export AWS_PROFILE=baradun-admin
BRD121_ACCOUNT_ID="<계정>"
```

1. **현재 기본 버전(DefaultVersionId)과 직전 정상 버전 기록**:
   IAM 관리형 정책은 버전을 최대 5개까지 저장합니다. 실패했을 때 즉시 되돌릴 수 있도록 **현재 기본 버전(직전 정상 버전)은 절대 지우지 않고**, 5개가 모두 찼다면 기본 버전이 아닌 가장 오래된 버전만 지웁니다.

   ```bash
   BRD121_PREVIOUS_EXECUTION_VERSION=$(aws iam get-policy \
     --policy-arn "arn:aws:iam::$BRD121_ACCOUNT_ID:policy/BaradunCdkExecution" \
     --query 'Policy.DefaultVersionId' --output text)
   BRD121_PREVIOUS_BOUNDARY_VERSION=$(aws iam get-policy \
     --policy-arn "arn:aws:iam::$BRD121_ACCOUNT_ID:policy/BaradunV2-RoleBoundary" \
     --query 'Policy.DefaultVersionId' --output text)

   # 이미 workload 정책이 연결된 계정에서만 기록. 최초 분할에는 이전 버전이 없음.
   BRD121_PREVIOUS_WORKLOAD_VERSION=$(aws iam get-policy \
     --policy-arn "arn:aws:iam::$BRD121_ACCOUNT_ID:policy/BaradunCdkExecutionWorkload" \
     --query 'Policy.DefaultVersionId' --output text)

   # 버전이 5개일 때만: IsDefaultVersion=false인 가장 오래된 버전을 골라 삭제 (현재 DefaultVersionId는 삭제 금지)
   aws iam delete-policy-version \
     --policy-arn "arn:aws:iam::$BRD121_ACCOUNT_ID:policy/<정책_이름>" \
     --version-id <가장_오래된_비기본_버전_ID>
   ```

   세 값은 정책 이름과 함께 별도로 기록합니다. 서로 같은 버전 ID라고 가정하지 않습니다. 조회가 실패하면 `NoSuchEntity`인 최초 workload 생성 경우를 제외하고 작업을 중단합니다. 인증·권한·네트워크 오류를 '정책 없음'으로 처리하지 않습니다. 현재 실행 역할의 정책 연결과 CDKToolkit의 기존 bootstrap 설정·신뢰 계정도 기록하고, 아래 bootstrap 갱신에서 유지합니다.

   **태그 전환 사전 조건**: 기존 정상 실행 정책을 유지합니다. 운영 CloudFront에는 예약 `aws:cloudformation:*` 태그가 생길 것을 기대하지 않습니다. 새 정책을 먼저 기본 버전으로 바꾸면 태그가 없는 기존 배포의 Read·Update·rollback이 거부됩니다. 3단계에서 사용자 태그를 선반영하고 실제 태그와 스택 정상 상태를 확인하기 전에는 4단계로 넘어가지 않습니다.

2. **사전 검증 (`check:iam-actions`·테스트 통과)**:
   AWS Service Authorization Reference 공식 JSON과 대조해 존재하지 않는 IAM Action이나 6,144자 초과가 없는지 먼저 확인합니다.

   ```bash
   npm run build -w @baradun/infra
   npm run test -w @baradun/infra
   (cd infra && npx cdk synth --quiet)
   npm run check:iam-actions -w @baradun/infra
   ```

3. **기존 정책 상태에서 변경 세트 비교 (`--method=change-set`)**:
   `cdk diff` 기본값(`--method=auto`)은 권한이 부족할 때 템플릿 비교로 조용히 폴백합니다. 반드시 `--method=change-set`을 붙여 CloudFormation 변경 세트가 정상으로 만들어지는지 먼저 확인합니다.

   ```bash
   cd infra && npx cdk diff --method=change-set
   ```

   **기존 CloudFront 배포에 태그 선반영**: 현재 정상 실행 정책으로 `SiteDelivery`의 사용자 태그 추가만 배포합니다. 실제 변경 세트에 다른 변경이 섞이면 중단하고 태그만 있는 변경을 따로 준비합니다. 배포가 완료되고 운영 배포에 `baradun:stack = BaradunV2`가 있음을 콘솔 또는 `list-tags-for-resource`로 확인한 뒤 4단계로 진행합니다. 함수에는 태그 전환이 필요 없습니다. 이 선행 배포를 수행·확인하지 않은 상태에서는 축소 정책을 적용하지 않습니다. 축소 정책 적용 이후 태그가 없는 이전 템플릿으로 롤백하려면 **실행 정책부터 직전 정상 버전으로 복구**해야 합니다. 태그를 지운 뒤 제한 정책으로 Read·rollback하려 해서는 안 됩니다. 이 저장소 작업에서는 선행 배포나 AWS 조회를 실행하지 않았습니다.

4. **최초 분할 또는 기존 두 정책 갱신**:
   3단계 이후 작업 디렉터리는 `infra/`입니다. boundary가 바뀌었다면 기록한 기존 버전을 보존하고 먼저 반영합니다. 이후 아래 두 경우 중 해당하는 절차 하나를 끝까지 수행합니다. 각 명령이 실패하면 다음 명령으로 넘어가지 않습니다.

   ```bash
   # (boundary 파일이 바뀌었을 때만)
   aws iam create-policy-version --set-as-default \
     --policy-arn "arn:aws:iam::$BRD121_ACCOUNT_ID:policy/BaradunV2-RoleBoundary" \
     --policy-document file://bootstrap/role-boundary-policy.json
   ```

   **최초 분할**: 기존 통합 실행 정책의 권한을 유지한 채 workload 정책을 생성하고 두 정책을 연결합니다. bootstrap 완료와 실행 역할의 연결을 확인한 뒤, 반드시 기존 `BaradunCdkExecution`도 축소 버전으로 바꿉니다. 연결만 하면 기존 서비스 와일드카드가 그대로 남습니다.

   ```bash
   aws iam create-policy --policy-name BaradunCdkExecutionWorkload \
     --policy-document file://bootstrap/cfn-execution-workload-policy.json
   npx cdk bootstrap "aws://$BRD121_ACCOUNT_ID/ap-northeast-2" \
     --cloudformation-execution-policies "arn:aws:iam::$BRD121_ACCOUNT_ID:policy/BaradunCdkExecution,arn:aws:iam::$BRD121_ACCOUNT_ID:policy/BaradunCdkExecutionWorkload"
   aws iam list-attached-role-policies \
     --role-name "cdk-hnb659fds-cfn-exec-role-$BRD121_ACCOUNT_ID-ap-northeast-2"
   aws iam create-policy-version --set-as-default \
     --policy-arn "arn:aws:iam::$BRD121_ACCOUNT_ID:policy/BaradunCdkExecution" \
     --policy-document file://bootstrap/cfn-execution-policy.json
   ```

   **이미 두 정책이 연결된 경우**: 두 정책 각각의 기존 기본 버전이 기록돼 있는지 확인하고 workload부터 갱신합니다. 두 명령이 모두 끝나야 새 정책 적용이 완료됩니다.

   ```bash
   aws iam create-policy-version --set-as-default \
     --policy-arn "arn:aws:iam::$BRD121_ACCOUNT_ID:policy/BaradunCdkExecutionWorkload" \
     --policy-document file://bootstrap/cfn-execution-workload-policy.json
   aws iam create-policy-version --set-as-default \
     --policy-arn "arn:aws:iam::$BRD121_ACCOUNT_ID:policy/BaradunCdkExecution" \
     --policy-document file://bootstrap/cfn-execution-policy.json
   ```

   공통으로 두 정책의 `DefaultVersionId`와 문서, 실행 역할의 연결 목록을 확인합니다. 두 새 문서가 기본이며 기존 `AdministratorAccess`나 다른 광범위 정책이 추가로 붙어 있지 않아야 축소가 완료된 것입니다. IAM 변경 전파가 끝난 뒤 5단계로 진행합니다.

5. **실제 Update 핸들러를 타는 작은 canary 변경으로 배포 검증**:
   변경 없는(no-op) 배포나 드리프트 감지는 CloudFormation이 리소스 Update 핸들러를 호출하지 않아 실행 정책 권한을 증명하지 못합니다. 실제 Update 핸들러를 타는 무해한 작은 변경(예: 경보 `alarmDescription` 한 줄 수정)으로 `npx cdk diff --method=change-set`과 `npx cdk deploy`가 끝까지 통과하는지 확인한 뒤 설명을 원래대로 되돌려 다시 배포합니다. 경보 canary는 경보 핸들러만 검증합니다. S3·Lambda 등 다른 핸들러와 Create/Delete·롤백까지 검증했다고 기록하지 않으며, 아직 실행하지 않은 경로는 미확인으로 남깁니다.

6. **실패 시 되돌리기 (정책 버전 먼저 복구 → 스택 롤백)**:
   배포 중 권한 부족(`AccessDenied`)이 발생하면 CloudFormation 롤백도 같은 실행 정책을 사용합니다. 따라서 **먼저 실행 정책을 1단계에서 기록한 직전 정상 버전으로 되돌린 뒤** 롤백이 진행되게 합니다.

   ```bash
   aws iam set-default-policy-version \
     --policy-arn "arn:aws:iam::$BRD121_ACCOUNT_ID:policy/BaradunCdkExecution" \
     --version-id "$BRD121_PREVIOUS_EXECUTION_VERSION"

   # 기존 두 정책 갱신에서만 실행. 최초 분할의 새 workload 정책에는 이전 버전이 없음.
   aws iam set-default-policy-version \
     --policy-arn "arn:aws:iam::$BRD121_ACCOUNT_ID:policy/BaradunCdkExecutionWorkload" \
     --version-id "$BRD121_PREVIOUS_WORKLOAD_VERSION"

   # 이번 작업에서 boundary도 바꿨을 때만 복구
   aws iam set-default-policy-version \
     --policy-arn "arn:aws:iam::$BRD121_ACCOUNT_ID:policy/BaradunV2-RoleBoundary" \
     --version-id "$BRD121_PREVIOUS_BOUNDARY_VERSION"
   ```

   **최초 분할 실패**라면 첫 번째 명령으로 기존 통합 정책부터 복구합니다. 새 workload 정책은 이전 버전으로 되돌리지 않고 우선 연결한 채 둡니다. 기존 통합 정책으로 복구했는지 확인한 뒤 스택 롤백이 완료될 때까지 기다립니다. 추가 workload 정책 때문에 기존 통합 정책의 Allow가 제한되지는 않습니다(이 파일에는 Deny 없음). 두 정책 연결 자체를 취소하려면 롤백 완료 뒤 기록한 기존 bootstrap 설정으로 재갱신하고, 실행 역할에서 분리된 것을 확인하기 전에는 새 정책을 삭제하지 않습니다.

7. **`UPDATE_ROLLBACK_FAILED` 복구**:
   롤백 도중 권한이 막혀 `UPDATE_ROLLBACK_FAILED`로 멈췄다면, 6단계처럼 정책 권한을 먼저 복구한 뒤 롤백을 이어서 실행합니다.

   ```bash
   aws cloudformation continue-update-rollback --stack-name BaradunV2
   ```

   `--resources-to-skip <막힌_논리_ID>`(리소스 건너뛰기)는 스택 기록과 실제 리소스 상태가 어긋나므로, boundary 첫 부착 중 롤백이 `NoBoundaryRemoval`에 막힌 경우처럼 원인을 바로 풀 수 없을 때만 최후 수단으로 쓰고 직후 재배포해 상태를 맞춥니다.

## 관리자 권한 운영 (상시 AdministratorAccess 제거, BRD-121)

일상 사용하는 IAM 사용자에 `AdministratorAccess`를 상시 붙여 두지 않습니다. 평소 IAM 사용자는 권한 없이 `sts:AssumeRole`만 허용하고, 인프라 배포나 콘솔 운영 조회가 필요할 때만 **MFA 조건이 걸린 임시 관리자 역할(`BaradunOperatorAdmin`, 최대 세션 1시간)**을 맡아 작업합니다.

관리자 역할 이름에는 `BaradunV2-` 접두어를 쓰지 않습니다. 이 접두어는 CDK 실행 정책의 역할 관리·신뢰 정책 수정·PassRole 대상이며, 스택 밖에서 만든 관리자 역할에는 스택의 boundary가 붙지 않습니다. 관리자 역할을 이 범위에 넣으면 실행 역할이 관리자 역할을 Lambda에 넘기는 권한 상승 경로가 생깁니다. 이미 이전 이름으로 역할을 만들었다면 새 이름의 역할을 생성·검증한 뒤 기존 관리자 역할을 분리·정리합니다. 기존 관리자 경로는 새 경로의 검증이 끝날 때까지 유지합니다.

> **IAM Identity Center(구 AWS SSO) 전환 시점**:
> IAM Identity Center 자체는 추가 요금이 없지만, AWS 계정 접근(Permission Set)을 쓰려면 AWS Organizations 기반의 조직 인스턴스가 필요합니다(단독 계정의 계정 인스턴스는 Permission Set과 AWS 계정 접근을 지원하지 않음 — [AWS 공식 문서](https://docs.aws.amazon.com/singlesignon/latest/userguide/account-instances-identity-center.html)). 그런데 지금 계정은 **AWS Free 플랜**이라 AWS Organizations를 켜면 즉시 Paid 플랜(종량제)으로 자동 전환됩니다([AWS Free Tier 공식 문서](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html)). 따라서 Free 플랜 기간에는 아래 임시 관리자 역할을 쓰고, Paid 플랜으로 전환할 때 IAM Identity Center 도입을 검토합니다.

### MFA 조건 임시 관리자 역할 전환 절차

1. **루트 사용자 보호 및 기존 IAM 사용자의 모든 권한 조사·목록화**:
   작업을 시작하기 전에 계정 루트(Root) 사용자에 MFA가 켜져 있고 복구 이메일·전화번호가 유효한지 먼저 확인합니다. 이어서 대상 IAM 사용자(`<운영자_IAM_사용자>`)에 직접 붙은 관리형 정책뿐 아니라 **소속 그룹 정책, 사용자 인라인 정책, 권한 경계, 액세스 키 목록**을 모두 조회해 기록합니다.

   ```bash
   USER_NAME="<운영자_IAM_사용자>"
   aws iam list-attached-user-policies --user-name "$USER_NAME"
   aws iam list-user-policies --user-name "$USER_NAME"
   aws iam get-user --user-name "$USER_NAME"
   aws iam list-access-keys --user-name "$USER_NAME"
   aws iam list-mfa-devices --user-name "$USER_NAME"

   # 소속 그룹과 각 그룹에 붙은 관리형·인라인 정책까지 모두 확인
   for g in $(aws iam list-groups-for-user --user-name "$USER_NAME" --query 'Groups[].GroupName' --output text); do
     echo "=== Group: $g ==="
     aws iam list-attached-group-policies --group-name "$g"
     aws iam list-group-policies --group-name "$g"
   done
   ```

2. **임시 관리자 역할(`BaradunOperatorAdmin`) 생성**:
   신뢰 정책에 운영자 IAM 사용자 ARN과 MFA 조건(`aws:MultiFactorAuthPresent: "true"`, `aws:MultiFactorAuthAge: "3600"` 이하)을 걸고, 역할의 최대 세션 시간(`--max-session-duration`)을 3600초(1시간)로 설정합니다.
   - `aws:MultiFactorAuthAge`는 역할을 맡는(`sts:AssumeRole`) 시점에 MFA 인증 후 경과 시간만 검사하며, 발급된 세션이 살아 있는 시간을 줄이지 않습니다. 세션의 실질 유효 시간은 역할의 `MaxSessionDuration`(1시간)이 제한합니다.

   ```bash
   cd "$(mktemp -d)"
   cat > trust-policy.json <<'EOF'
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": { "AWS": "arn:aws:iam::<계정>:user/<운영자_IAM_사용자>" },
         "Action": "sts:AssumeRole",
         "Condition": {
           "Bool": { "aws:MultiFactorAuthPresent": "true" },
           "NumericLessThanEquals": { "aws:MultiFactorAuthAge": "3600" }
         }
       }
     ]
   }
   EOF

   aws iam create-role --role-name BaradunOperatorAdmin \
     --max-session-duration 3600 \
     --assume-role-policy-document file://trust-policy.json

   aws iam attach-role-policy --role-name BaradunOperatorAdmin \
     --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
   ```

3. **사용자 인라인 정책으로 역할 전환 허용 추가**:
   기존 관리자 권한을 떼기 전에, 사용자가 MFA를 거쳤을 때 `BaradunOperatorAdmin`을 맡을 수 있는 최소 정책을 먼저 넣습니다.

   ```bash
   cat > assume-admin-policy.json <<'EOF'
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "AllowAssumeAdminRoleWithMfa",
         "Effect": "Allow",
         "Action": "sts:AssumeRole",
         "Resource": "arn:aws:iam::<계정>:role/BaradunOperatorAdmin",
         "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" } }
       }
     ]
   }
   EOF

   aws iam put-user-policy --user-name "<운영자_IAM_사용자>" \
     --policy-name AllowAssumeBaradunAdmin \
     --policy-document file://assume-admin-policy.json
   ```

4. **기존 관리자 세션을 유지한 채 콘솔·CLI 양쪽에서 새 역할 검증**:
   잠김(Lockout)을 막기 위해 **기존 관리자 터미널·콘솔 세션을 닫지 않은 채**, 별도 창에서 새 역할로 전환이 되는지 양쪽 모두 확인합니다.
   - **콘솔**: MFA로 로그인한 뒤 우측 상단 계정 메뉴 → **역할 전환(Switch Role)** → 계정 `<계정>`, 역할 `BaradunOperatorAdmin` 입력 후 전환되는지 확인합니다.
   - **CLI**: `~/.aws/config`에 `baradun-admin` 프로필을 추가하고 `sts get-caller-identity`가 `assumed-role/BaradunOperatorAdmin/...`을 돌려주는지 확인합니다.

   ```ini
   [profile baradun-admin]
   role_arn = arn:aws:iam::<계정>:role/BaradunOperatorAdmin
   source_profile = default
   mfa_serial = arn:aws:iam::<계정>:mfa/<MFA_장치_이름>
   region = ap-northeast-2
   duration_seconds = 3600
   ```

   ```bash
   aws sts get-caller-identity --profile baradun-admin
   ```

5. **상시 관리자 정책 분리 (직접 부착·그룹·인라인 모두)**:
   4단계에서 콘솔·CLI 역할 전환이 모두 확인된 뒤에 1단계에서 목록화한 상시 `AdministratorAccess`(및 다른 넓게 열린 정책·그룹)를 분리합니다.

   ```bash
   aws iam detach-user-policy --user-name "<운영자_IAM_사용자>" \
     --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
   # 1단계에서 확인된 관리자 그룹·추가 인라인 정책이 있으면 함께 제거
   ```

   분리 직후 기본 프로필(`default`)로는 `aws iam list-users`가 거부(`AccessDenied`)되고, `--profile baradun-admin`으로는 정상 동작하는지 확인합니다. 이후 로컬에서 실행하는 `npx cdk diff`·`npx cdk deploy`·운영 CLI 명령은 모두 `AWS_PROFILE=baradun-admin`(또는 `--profile baradun-admin`)으로 실행합니다. 사이트 배포(`npm run deploy:prod`)는 GitHub CLI(`gh`)로 Actions OIDC 워크플로를 호출하므로 로컬 AWS 프로필을 쓰지 않습니다.

6. **장기 액세스 키 정리 (마지막 별도 단계)**:
   콘솔 역할 전환만으로 운영하거나 새 키로 교체할 때는, 기존 액세스 키를 바로 삭제하지 않고 먼저 **비활성화(`Inactive`)**해 둔 뒤 다른 곳에서 쓰이지 않는 것을 확인하고 삭제합니다.

   ```bash
   aws iam update-access-key --user-name "<운영자_IAM_사용자>" \
     --access-key-id <액세스_키_ID> --status Inactive --profile baradun-admin

   # 영향이 없음을 확인한 뒤 삭제
   aws iam delete-access-key --user-name "<운영자_IAM_사용자>" \
     --access-key-id <액세스_키_ID> --profile baradun-admin
   ```

## 비용 방어 범위

기준은 Notion 'V2 아키텍처 기준 문서' 0장 G3와 11장 '과금·보안 가드레일'입니다.

- 월 $1 예산(Budgets, 이 스택의 `CostBudget`)은 이메일 알림이라 과금을 막지 않습니다. 비용 이상 탐지(Cost Anomaly Detection)는 이 스택 밖의 계정 설정이라 `cdk diff`로 보이지 않습니다.
- 지금 계정은 AWS Free 플랜입니다. 사용량은 크레딧에서 빠지고, 크레딧이 떨어지거나 만료일(2027-04-16)이 되면 계정이 닫힙니다.
- CloudFront 정액 요금제는 Free 플랜 계정에서 쓸 수 없어 연결하지 않았습니다. 그래서 `SiteWebAclArn`은 비어 있고 배포에 web ACL이 없습니다.
- 정액 요금제의 '초과 요금 없음'은 CloudFront를 거치는 트래픽에만 해당합니다. Lambda·DynamoDB·S3 요청은 따로 청구됩니다.

계속 운영하려면 만료 전에 Paid로 전환하고 정액 Free를 연결합니다.

1. 콘솔에서 CloudFront 배포를 정액 Free에 먼저 구독합니다. 요금제가 web ACL을 붙입니다.
2. 붙은 web ACL ARN을 `npx cdk deploy --parameters SiteWebAclArn=<ARN>`으로 넘깁니다.
3. 요금제를 쓰는 배포는 web ACL을 뗄 수 없습니다. 구독한 뒤에는 `--no-previous-parameters`로 배포하지 않습니다. 이 옵션을 쓰면 파라미터가 빈 값으로 돌아가 web ACL이 빠집니다.

## 데이터 문의 접수(BRD-63)

문의 API는 기존 CloudFront 배포의 `/api/inquiries*` 동작에서 AWS_IAM 함수 URL로 전달합니다. 함수 URL은 공개 인증 `NONE`을 쓰지 않으며, CloudFront OAC가 오리진 요청을 SigV4로 서명합니다. CloudFront Function은 메서드·경로·JSON 형식·32KiB 크기·본문 해시 헤더를 먼저 검사하고 Lambda가 같은 항목과 실제 본문 SHA-256을 다시 검사합니다.

현재 Free 플랜 계정에서는 정액 CloudFront 플랜의 포함 WAF를 쓸 수 없습니다. 따라서 WAF 없이 CloudFront Function 선행 거부, Lambda 재검증, IP를 저장하지 않는 전체 10건/분 제한, 메일 20건/일 제한을 적용합니다. Paid 전환 뒤 정액 플랜과 포함 WAF 사용을 다시 검토합니다.

2026-10-26 서울 리전의 Service Quotas `Concurrent executions`(`L-B99A9384`)와 Lambda `GetAccountSettings`는 모두 10이었습니다. Lambda가 요구하는 미예약 100개를 남길 수 없어 문의 함수의 예약 동시 실행 2는 설정하지 않았습니다. 한도가 102 이상으로 올라간 뒤 다음 명령과 콘솔의 Lambda 동시 실행 화면을 함께 확인하고 설정합니다.

```bash
aws service-quotas get-service-quota \
  --service-code lambda \
  --quota-code L-B99A9384 \
  --region ap-northeast-2
aws lambda get-account-settings --region ap-northeast-2
```

웹은 JSON 문자열을 만든 뒤 그 **동일한 문자열**의 SHA-256을 소문자 16진수로 계산해 `x-amz-content-sha256`에 넣습니다. 해시를 계산한 뒤 JSON을 다시 직렬화하면 서명이 맞지 않습니다.

```ts
const body = JSON.stringify(request);
const digest = await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(body),
);
const hash = [...new Uint8Array(digest)]
  .map((value) => value.toString(16).padStart(2, "0"))
  .join("");

await fetch("/api/inquiries", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-amz-content-sha256": hash,
  },
  body,
});
```

사진은 다음 순서로 보냅니다.

1. `POST /api/inquiries/uploads`에 `photos` 배열을 보내 presigned POST 양식을 받습니다. JPEG·PNG·WebP, 최대 3장, 파일당 4MiB입니다(결정 기록 12장 결정 23. 웹은 기기에서 긴 변 2048px·JPEG 품질 약 0.82로 줄여 4MiB 안에 맞춤).
2. 응답의 `url`과 `fields`를 그대로 `multipart/form-data` POST(`method: "POST"`)에 넣고 마지막에 사진 파일을 붙입니다. S3 정책의 `content-length-range`가 파일당 4MiB를 강제하고, 문의 접수 때 Lambda가 객체 크기를 다시 확인합니다.
3. 업로드 응답의 `photoId`와 `key`를 `POST /api/inquiries`의 `photos`에 넣습니다.

### 멱등 키(BRD-103)

`POST /api/inquiries` 본문에는 `idempotencyKey`(UUID v4, 소문자)가 꼭 있어야 합니다. 헤더가 아니라 본문에 두는 이유는 본문 SHA-256(`x-amz-content-sha256`) 검사에 키도 함께 묶이고, CloudFront 오리진 요청 정책·OAC 서명 헤더를 바꾸지 않아도 되기 때문입니다.

- 웹은 문의 한 건에 키 하나를 만들고, 같은 내용(유형·본문·이메일·해변·활동·사진 내용)으로 다시 보내면 같은 키와 이미 올린 사진 참조를 그대로 씁니다. 내용이 바뀌거나 접수되면 새 키를 씁니다. 키는 화면 메모리에만 두고 기기에 저장하지 않습니다.
- Lambda는 먼저 `IDEMPOTENCY#<키>` 항목을 강한 일관성으로 읽습니다. 있으면 내용 지문(멱등 키를 뺀 요청 값의 SHA-256)을 비교해, 같으면 첫 응답(같은 `inquiryId`·`receivedAt`·사진 결과)을 201로 다시 주고 다르면 `409 idempotency_conflict`로 거부합니다. 이때는 속도 제한을 세지 않고 문의·알림을 새로 만들지 않습니다.
- 없으면 속도 제한을 한 번 센 뒤 사진을 검사하고, 멱등 항목(`attribute_not_exists(pk)` 조건)·문의·이메일을 한 트랜잭션으로 씁니다. 같은 키 요청이 동시에 와서 조건에 지면 이긴 쪽 기록을 읽어 같은 응답을 주고 알림은 보내지 않습니다. 동시 요청은 둘 다 속도 제한에 한 번씩 셉니다.
- 멱등 항목에는 내용 지문·문의 ID·접수 시각·사진 결과만 두고 본문·이메일 원문은 넣지 않습니다. TTL은 1일입니다.
- 앞선 요청이 사진 검사를 마쳐 `pending/` 객체가 `accepted/`로 옮겨졌으면, 다시 온 요청은 `accepted/` 사본을 통과한 사진으로 봅니다(`accepted/`에는 검사를 통과한 사진만 복사됨).
- 저장 뒤 알림 오류는 접수 실패로 바꾸지 않습니다(503이면 재시도가 첫 결과만 받아 알림이 빠짐). 사진 양식 발급(`/uploads`)은 문의를 만들지 않으므로 키를 받지 않습니다. 업로드가 끝나지 않은 사진은 `pending/`에 남았다가 30일 수명 주기로 지워집니다.

### 업로드 양식 검증(BRD-103)

양식 `url`은 서울 리전 버킷의 가상 호스트 주소 `https://<버킷>.s3.ap-northeast-2.amazonaws.com/`만 허용하고, `fields`는 `key`·`bucket`·`Content-Type`·`Policy`·`X-Amz-Algorithm`·`X-Amz-Credential`·`X-Amz-Date`·`X-Amz-Signature`(·`X-Amz-Security-Token`)만 허용합니다(계약 `InquiryUploadTarget`·`InquiryUploadFields`). Lambda는 내보내기 전에 계약으로 다시 검사하고, 맞지 않으면 503으로 끝냅니다.

웹은 사진을 올리기 전에 양식마다 다음을 모두 확인하고, 하나라도 틀리면 사진을 하나도 올리지 않고 문의도 보내지 않습니다(화면은 '서버 응답을 확인하지 못했어요'와 '문의는 접수되지 않았어요'를 함께 안내).

- 주소가 빌드 설정의 버킷 주소와 글자까지 같음(https, 다른 호스트·포트·경로·질의 거부). 아무 `*.amazonaws.com`이나 받지 않습니다.
- `method`가 `POST`.
- 양식 `expiresAt`과 S3 정책의 `expiration`이 모두 지금보다 뒤이고 10분 + 시계 차이 5분 안. 앞 사진을 올리는 사이 만료되면 다음 사진을 올리지 않습니다.
- `fields.key`가 양식 `key`(`pending/` 형식)와 같고, `fields.bucket`이 빌드 설정 버킷, `Content-Type`이 그 사진의 형식(JPEG·PNG·WebP)과 같음. 정책 조건에도 같은 버킷·키·콘텐츠 타입이 걸려 있음.

웹 빌드는 버킷 이름을 `NEXT_PUBLIC_INQUIRY_PHOTO_BUCKET`으로 받습니다. 배포 워크플로는 GitHub Variables `INQUIRY_PHOTO_BUCKET`을 넘기고, 비어 있거나 형식이 틀리면 빌드 전에 멈춥니다. 값은 스택 출력 `InquiryPhotoBucketName`입니다. 로컬·CI 빌드처럼 값이 없으면 어떤 업로드 주소도 받지 않아 사진 문의만 실패로 안내됩니다.

이 변경을 처음 배포할 때는 순서를 지킵니다. 새 Lambda는 멱등 키가 없는 요청을 400으로 거부하고, 이전 Lambda는 멱등 키가 있는 요청을 400으로 거부합니다.

1. 머지 전에 GitHub Variables `DEPLOY_PAUSED`를 `true`로 둡니다. main CI가 끝나도 사이트가 자동 배포되지 않습니다(BRD-133).
2. 최신 `origin/main` 작업 트리에서 `npx cdk deploy`(맨 위 배포 절차) → 출력 `InquiryPhotoBucketName`을 GitHub Variables `INQUIRY_PHOTO_BUCKET`에 넣습니다.
3. `DEPLOY_PAUSED`를 지우고 루트에서 `npm run deploy:prod`로 사이트를 배포합니다. 2와 3 사이에 열려 있던 이전 화면의 문의는 거부되므로 바로 이어서 합니다.

문의 유형 4개·`beachId`·`activity` 칸·사진 4MiB(결정 기록 12장 결정 21~23)를 처음 배포할 때도 같은 순서를 지킵니다. 새 Lambda는 이전 화면의 `other` 유형과 4MiB를 넘는 사진 양식 요청을 400으로 거부하고, 이전 Lambda는 새 유형과 `beachId`·`activity` 칸을 400으로 거부합니다.

요청·응답 타입은 `@baradun/contracts`의 `InquiryUploadRequest`, `InquiryUploadResponse`, `CreateInquiryRequest`, `CreateInquiryResponse`, `InquiryErrorResponse`입니다. 문의 유형은 화면 칩과 1:1로 `data_error`(정보가 실제와 달라요)·`data_question`(판단 기준이 궁금해요)·`beach_request`(해변을 추가해 주세요)·`data_suggestion`(새 데이터를 제안해요)입니다(결정 기록 12장 결정 21). 장소 상세에서 들어온 문의는 본문에 섞지 않고 `beachId`(예: `b0001`)와 `activity`(`swimming`·`surfing`·`scuba`) 칸으로 보내며, `activity`는 `beachId` 없이 오지 않습니다(결정 22). 둘 다 문의 항목에 들어갑니다(알림에는 들어가지 않음). 사진에 EXIF GPS IFD가 있거나 파일이 깨졌으면 그 사진만 `rejected`로 돌아오며 문의 자체는 접수됩니다. 사진은 공개 URL 없이 비공개 버킷에 두고 30일 수명 주기로 삭제합니다.

문의 본문 항목은 접수 뒤 90일, 이메일은 별도 항목으로 88일 TTL을 둡니다. 처리가 끝난 이메일은 문의 Lambda를 함수 URL이 아닌 직접 호출로 아래 이벤트를 보내 즉시 삭제합니다. DynamoDB TTL 삭제는 비동기이므로 88일 값으로 90일 이내 삭제 여유를 둡니다.

```json
{ "action": "delete_email", "inquiryId": "문의 UUID" }
```

새 문의 알림은 배포 파라미터 `AlertEmail`로 만든 SNS 이메일 구독을 사용하므로 첫 배포 뒤 구독 확인이 필요합니다. 알림에는 문의 ID·유형·접수 시각(UTC)·이메일 제공 여부만 들어가며, 메일함에 개인정보가 남지 않도록 본문(요약 포함)·실제 이메일 주소·사진 정보는 넣지 않습니다(BRD-120).

### 문의 내용 확인(운영자 콘솔 BRD-97 도입 전)

알림 이메일에는 개인정보 보호를 위해 본문 요약이 들어가지 않으므로, 운영자 콘솔(BRD-97) 도입 전까지는 AWS 관리 콘솔에서 해당 항목만 조회해 확인합니다.

1. AWS 콘솔 → DynamoDB → 테이블 → `InquiryTable`(스택 출력 `InquiryTableName`, 예: `BaradunV2-InquiryTable...`) 선택
2. '항목 탐색' 화면에서 항목 조회(Get item) 또는 쿼리(Query) 실행
3. 파티션 키 `pk`에 `INQUIRY#<알림의 문의 ID>` 입력해 조회
   - 본문(`message`), 유형(`inquiryType`), 접수 시각(`receivedAt`), 해변(`beachId`), 활동(`activity`), 첨부 사진 키(`photoKeys`)를 확인합니다.
4. 알림에 '이메일 제공 여부'가 '있음'으로 표시된 경우(이메일 받기 설정이 켜져 회신 이메일이 함께 접수된 문의):
   - 파티션 키 `pk`에 `INQUIRY_EMAIL#<알림의 문의 ID>`를 입력해 조회하면 회신용 `email`을 확인할 수 있습니다(이메일은 88일 TTL이 걸려 있으며, 처리 완료 후 delete_email 호출로 즉시 삭제 가능).

## 데이터 게시(publish-snapshot)와 롤백

수집기 3개가 수집을 마칠 때마다 `publish-snapshot`을 비동기로 깨웁니다(아키텍처 6.2). 게시 함수는 State를 읽어 해변 상태를 계산하고 `data/{버전}/`에 파일 네 개를 올린 뒤 `data/manifest.json`을 조건부 쓰기(If-Match)로 바꿉니다. 실패하면 manifest는 이전 버전 그대로이고, 함수는 오류로 끝나 Lambda 오류 지표에 남습니다.

롤백(T06)은 manifest를 이전 버전으로 되돌립니다. 버전 경로는 최근 48개가 남아 있습니다.

1. 게시 코드 문제로 되돌리는 경우 수집 일정을 먼저 멈춥니다. 멈추지 않으면 다음 수집(15분 안)이 새 버전으로 다시 게시합니다.

   `update-schedule`은 넘기지 않은 선택 설정(시간대·재시도·유연 시간 등)을 기본값으로 되돌립니다. 예를 들어 시간대가 빠지면 UTC가 되어 collect-catalog가 KST 13:20에 돕니다. 그래서 그때그때 지금 설정을 읽어 상태만 바꿔 넘깁니다. 작업 파일은 저장소 밖 임시 폴더에 둡니다(계정 번호·ARN이 들어 있음).

   ```bash
   cd "$(mktemp -d)"
   set_state() {  # $1: ENABLED | DISABLED
     for n in $(aws scheduler list-schedules --name-prefix BaradunV2- --query "Schedules[].Name" --output text); do
       aws scheduler get-schedule --name "$n" \
         | jq --arg s "$1" 'del(.Arn,.CreationDate,.LastModificationDate) | .State=$s' > s.json \
         && aws scheduler update-schedule --cli-input-json file://s.json > /dev/null \
         || echo "실패: $n"
     done
     aws scheduler list-schedules --name-prefix BaradunV2- --query "Schedules[].[Name,State]" --output text
   }
   set_state DISABLED   # 세 일정 모두 DISABLED로 나와야 함. '실패'가 있으면 다시 실행
   ```

   일정을 꺼도 이미 시작된 수집이나 스케줄러 재시도(최대 10분 늦게 옴)가 게시를 한 번 더 깨울 수 있습니다. 롤백은 게시 잠금과 상관없이 manifest를 덮어쓰므로, 일정을 끄고 **11분 기다린 뒤** 롤백합니다. 급해서 바로 롤백했다면 4단계에서 11분 뒤 한 번 더 확인합니다.

2. 되돌릴 버전을 고릅니다: `aws s3 ls s3://<SiteBucketName>/data/`
3. 게시 함수를 롤백 이벤트로 직접 부릅니다(`PublisherFunctionName` 출력값).

   ```bash
   aws lambda invoke --function-name <PublisherFunctionName> \
     --cli-binary-format raw-in-base64-out \
     --payload '{"action":"rollback","version":"20261017T053000Z"}' /dev/stdout
   ```

   그 버전의 manifest 사본과 파일 네 개가 모두 있을 때만 되돌립니다. 하나라도 없으면 지금 manifest를 그대로 두고 오류로 끝납니다. 점검(`maintenance`)·최소 화면 버전(`minWebBuild`)은 사본의 값이 아니라 배포된 코드의 `MANIFEST_SETTINGS`로 씁니다(점검 중 롤백해도 점검이 풀리지 않음). 응답은 파일 대신 화면(`/dev/stdout`)으로 받아 작업 트리에 파일이 남지 않게 합니다.

4. 사이트에서 manifest가 바뀌었는지 확인합니다(manifest 캐시 60초): `curl -s https://<DistributionDomainName>/data/manifest.json | jq -r .snapshotVersion`. 그 뒤 게시 로그 그룹(`BaradunV2-PublishLogs…`)에 롤백 뒤 `publish_finished`가 새로 생겼다면 늦게 온 게시가 덮은 것이니 3단계를 다시 합니다.
5. 원인을 고친 뒤 일정을 다시 켭니다: `set_state ENABLED`(1단계와 같은 셸, 새 셸이면 함수를 다시 정의). 고친 코드를 `cdk deploy`했다면 배포가 일정을 이미 켰을 수 있으니 상태만 확인합니다. 다음 수집이 새 버전을 게시합니다. 지금 manifest와 내용이 같으면 `publish_unchanged`로 남고 새 버전은 만들지 않습니다.

롤백 리허설 결과(일시·되돌린 버전·복구에 걸린 시간)는 Notion 'V2 AWS 운영 점검표'의 '데이터 게시 롤백 리허설 기록'에 남깁니다. 첫 실환경 리허설(2026-10-26) 기록이 그곳에 있습니다.

## 운영 경보(BRD-62)

`OpsAlarms`가 CloudWatch 경보 10개(수집기 4개·게시 함수의 오류, 특보·관측·이안류 수집과 게시의 실행 없음, 운영 알림 발송 실패)를 만듭니다. 오류 경보는 한 번의 실패에도 울립니다. 실행 없음 경보는 최근 창(특보·게시 25분, 관측·이안류 60분) 동안 실행이 없으면 울려서, 특보 확인 유효시간 45분·파고 90분보다 각각 20분·30분 먼저 알리고 정상 실행의 지표가 10분 이상 늦게 들어와도 울리지 않습니다. ALARM 상태 변경은 EventBridge가 공통 변환 Lambda로 보내며, Lambda가 한국어 제목·설명·KST 시각·콘솔 링크를 만들어 기존 운영 SNS 주제의 `AlertEmail` 구독에 발송합니다. 복구(OK) 메일은 보내지 않습니다.

- 변환 Lambda는 실패하면 1번 더 시도합니다. 그래도 실패하거나 EventBridge가 전달하지 못하면 이벤트를 실패 대기열(SQS, `OpsNotificationFailures`, 14일 보관)에 남기고 `NotificationFailed` 경보가 울립니다. 이 경보도 같은 Lambda로 알리므로 고장이 계속되면 메일이 오지 않습니다. 운영 주제는 AWS 관리형 키(`alias/aws/sns`)로 암호화해서 CloudWatch가 직접 게시할 수 없고, 고객 관리형 키는 월 요금이 들어서 쓰지 않습니다. 실패 대기열에 메시지가 남아 있으면 CloudWatch 경보 화면에서 원래 경보를 확인하고, 원인을 고친 뒤 메시지를 지워 경보를 OK로 돌립니다.

- 경보를 처음 넣는 배포 전에 실행 정책(`BaradunCdkExecution`·`BaradunCdkExecutionWorkload`)을 최신 버전으로 올립니다(위 '정책 적용과 되돌리기 절차' 4단계 명령). 올리지 않으면 `cloudwatch:PutMetricAlarm`이 거부되어 배포가 롤백됩니다.
- 운영 주제는 문의 알림 주제와 따로라서 첫 배포 뒤 구독 확인 메일이 한 통 더 옵니다. 확인하지 않으면 경보가 울려도 메일이 가지 않습니다.

## 운영자 로그인 사용자 풀(BRD-145)

`OperatorAuth`가 Cognito 사용자 풀 두 개와 각 관리자 앱 클라이언트, 권한 그룹을 만듭니다. 기준은 결정 기록 D15-3·D16-A1~A9, 아키텍처 18.2입니다.

| 풀        | 이름                  | MFA              | 그룹                          | 계정               |
| --------- | --------------------- | ---------------- | ----------------------------- | ------------------ |
| 운영자 풀 | `BaradunV2-Operators` | 필수(인증 앱만)  | `viewer`·`editor`·`publisher` | 실제 운영자        |
| 샘플 풀   | `BaradunV2-Sample`    | 없음(비밀번호만) | `sample`                      | 읽기 전용 샘플 1개 |

- 풀을 나눈 이유: 2026-11-03 실증에서 서울 리전 토큰에 `amr`·`acr`이 없었습니다(인증 앱 로그인·비밀번호만 로그인 모두). 한 풀(MFA 선택)로는 운영 API가 현재 세션의 인증 앱 사용을 확인할 수 없어 D16-A7대로 풀을 나눴습니다(I01 채택). 운영자 풀은 MFA 필수라 그 풀이 발급한 토큰은 인증 앱을 거친 것입니다. 운영 API(BRD-146)는 발급자(`iss`)로 풀을 구분하고, 샘플 풀 토큰은 sub 허용 목록·허용 기간·허용 endpoint로 다시 검사합니다(D16-A8).
- 두 풀 공통: Essentials 플랜, 초대(AdminCreateUser)로만 계정 생성, 이메일로 로그인, 비밀번호 12자 이상·숫자 포함·최근 5개 재사용 금지, 임시 비밀번호 7일, 이메일 변경은 새 주소 확인 전까지 원래 주소 유지. 문자 인증·Lambda 트리거·SES·호스팅 UI는 없습니다. 잠금은 Cognito 기본 동작입니다.
- 클라이언트(풀마다 하나): 비밀값 없음, SRP 로그인만, access·ID 15분, refresh 8시간 + rotation(재전송 유예 0초), 사용자가 쓸 수 있는 속성은 `locale`뿐. rotation을 켜면 Cognito는 refresh마다 새 8시간을 주므로, 최초 인증 8시간 상한은 운영 API가 `auth_time`으로 강제합니다.
- 두 풀 모두 삭제 보호 + RETAIN입니다. 스택에서 빠지거나 교체돼도 계정이 남습니다.
- 계정·비밀번호는 코드·저장소·로그에 넣지 않습니다. 계정은 배포 뒤 아래 명령으로 만듭니다.

### 실행 정책

Cognito 권한은 `BaradunCdkExecutionWorkload`에 있습니다(문장 2개). 2026-11-03 첫 배포 때 계정에는 이 정책이 없어(정책 분할 BRD-121 미적용) 새로 만들고, 기존 `BaradunCdkExecution`(v7)과 함께 실행 역할에 붙였습니다(`cdk bootstrap --cloudformation-execution-policies "…/BaradunCdkExecution,…/BaradunCdkExecutionWorkload"`). 기존 정책 축소는 BRD-121 절차에서 합니다. boundary는 바뀌지 않습니다(운영 API 역할이 생기는 BRD-146에서 필요한 권한을 더함).

- `cognito-idp:CreateUserPool`은 리소스 단위 권한이 없어 서울 리전 조건으로 `Resource: "*"`입니다.
- 나머지 Cognito 작업은 사용자 풀 ARN(`userpool/*`)까지만 좁혀집니다. 풀 ID는 생성 때 정해져 이름으로 더 좁힐 수 없고, 이 계정에 다른 사용자 풀이 생기면 실행 역할이 그 풀도 고칠 수 있다는 뜻입니다.

### 배포

이 스택은 `cdk diff --method=change-set`이 `AlertEmail` 값 없음(`MissingParameters`)으로 실패합니다. `--parameters AlertEmail=…`을 넘기면 예산 리소스가 교체되며 실패하므로 넘기지 않습니다. 대신 이전 값을 그대로 쓰는 변경 세트를 만들어 내용을 확인한 뒤 실행합니다. `npm run deploy:infra`(맨 위)가 이 순서를 그대로 하고, 아래는 손으로 할 때의 명령입니다.

```bash
npx cdk deploy --no-execute --change-set-name <이름>
aws cloudformation describe-change-set --region ap-northeast-2 --stack-name BaradunV2 --change-set-name <이름> \
  --query 'Changes[].ResourceChange.[Action,LogicalResourceId,ResourceType,Replacement]' --output table
aws cloudformation execute-change-set --region ap-northeast-2 --stack-name BaradunV2 --change-set-name <이름>
aws cloudformation wait stack-update-complete --region ap-northeast-2 --stack-name BaradunV2
```

풀 분리 배포(두 번째 배포)의 기대 변경: 운영자 풀 `Modify`(MFA 선택 → 필수, 교체 없음), 운영자 풀의 `sample` 그룹 `Remove`, 샘플 풀·클라이언트·`sample` 그룹 `Add`. 운영자 풀은 첫 배포 때의 논리 ID를 그대로 써서 교체되지 않습니다.

배포 출력의 `OperatorUserPoolId`·`OperatorAdminWebClientId`·`SampleUserPoolId`·`SampleAdminWebClientId`를 기록합니다(비밀값 아님).

### 계정 만들기

계정은 초대 메일로 임시 비밀번호를 받습니다(보내는 곳 `no-reply@verificationemail.com`).

```bash
aws cognito-idp admin-create-user --region ap-northeast-2 --user-pool-id <풀 ID> --username <이메일> \
  --user-attributes Name=email,Value=<이메일> Name=email_verified,Value=true --desired-delivery-mediums EMAIL
aws cognito-idp admin-add-user-to-group --region ap-northeast-2 --user-pool-id <풀 ID> --username <이메일> --group-name <그룹>
```

- 운영자: 운영자 풀 · `publisher`(또는 `viewer`·`editor`)
- 샘플: 샘플 풀 · `sample`. 실증·시연이 끝나면 꺼 둡니다(D16-A8: 시연 기간에만 켬): `aws cognito-idp admin-disable-user --region ap-northeast-2 --user-pool-id <샘플 풀 ID> --username <샘플 이메일>`
- 풀 분리 전 운영자 풀에 만든 샘플 계정은 분리 배포 뒤 지웁니다(`sample` 그룹이 없어져 권한도 없음): `aws cognito-idp admin-delete-user --region ap-northeast-2 --user-pool-id <운영자 풀 ID> --username <샘플 이메일>`

인증 앱 분실 때 초기화(D16-A9)는 본인 확인 뒤 `AdminDeleteSoftwareToken` 기반 절차로 하고 감사 기록을 남깁니다. 운영자 풀은 MFA 필수라 초기화한 계정은 다음 로그인에서 인증 앱을 다시 등록합니다. 자세한 절차는 운영 문서에 둡니다(이 범위 아님).

### 실증

관리자 앱과 같은 SRP 로그인으로 실제 풀을 확인합니다. `scripts/operator-auth-probe.mjs`는 AWS 자격 증명 없이 앱 클라이언트로만 로그인합니다. 토큰·비밀번호는 출력하지 않고 정해 둔 클레임만 보여 줍니다. 등록용 인증 앱 키는 `first-login`에서 한 번만 화면에 나옵니다(그 터미널 출력은 공유하지 않음).

```bash
# 운영자 풀: 첫 로그인(새 비밀번호 → 인증 앱 등록) 뒤 로그인
OPERATOR_USER_POOL_ID=<OperatorUserPoolId> OPERATOR_CLIENT_ID=<OperatorAdminWebClientId> node scripts/operator-auth-probe.mjs first-login
OPERATOR_USER_POOL_ID=<OperatorUserPoolId> OPERATOR_CLIENT_ID=<OperatorAdminWebClientId> node scripts/operator-auth-probe.mjs login
# 샘플 풀: 첫 로그인도 login(인증 앱 없음)
OPERATOR_USER_POOL_ID=<SampleUserPoolId> OPERATOR_CLIENT_ID=<SampleAdminWebClientId> node scripts/operator-auth-probe.mjs login
```

결과는 BRD-145에 기록합니다. 2026-11-03 첫 실증(한 풀, MFA 선택) 결과:

| 확인할 것                                                | 결과                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 운영자 첫 로그인 → 인증 앱 등록 → 2단계 로그인           | 됨                                                                                         |
| 샘플: 2단계 없이 로그인, `cognito:groups=sample`         | 됨                                                                                         |
| access token: `token_use=access`, `client_id` 일치, 15분 | 됨                                                                                         |
| refresh 회전 · 옛 refresh 재사용 거부                    | 됨(`RefreshTokenReuseException`)                                                           |
| 운영자·샘플 토큰 amr/acr                                 | 둘 다 없음 → 풀 분리                                                                       |
| 잠금                                                     | 7번 연속 실패 모두 같은 메시지, 바로 다음 정상 로그인 성공(짧은 잠금이라 관찰 안 됨, 추정) |
| 비밀번호 규칙 · 갱신 뒤 auth_time                        | 미확인                                                                                     |

풀 분리 뒤 다시 확인할 것:

| 확인할 것          | 방법                                                   | 기대                                                                                                   |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 운영자 풀 MFA 필수 | 새 운영자 계정 `first-login`                           | 새 비밀번호 뒤 `MFA_SETUP`(토큰 없음) → 등록 뒤 토큰. '[주의] 인증 앱 등록 없이 토큰' 줄이 나오면 실패 |
| 기존 운영자 계정   | 기존 계정 `login`                                      | `SOFTWARE_TOKEN_MFA`를 거쳐 토큰                                                                       |
| 샘플 풀            | 샘플 계정 `login`                                      | 2단계 없이 토큰, `iss`가 샘플 풀, `cognito:groups=sample`                                              |
| 비밀번호 규칙      | 새 비밀번호에 11자·숫자 없는 값을 먼저 넣음            | 둘 다 `[거부] InvalidPasswordException`                                                                |
| 갱신 뒤 auth_time  | `login`의 `[갱신] auth_time 유지` 줄(갱신 전 3초 대기) | 예(iat만 바뀜)                                                                                         |

위조 토큰 거부는 운영 API의 검증 코드(BRD-146)에서 확인합니다.

이 실증 도구는 `amazon-cognito-identity-js`(Amplify v5 계열, 유지 보수 모드)를 씁니다. 실증 전용이며 관리자 앱의 로그인 라이브러리 선택은 BRD-148에서 따로 정합니다.

## 운영 API(BRD-146)

`OpsApi`가 운영자 사이트의 API 함수 하나(`/ops/*`, 코드 `services/src/admin`)와 전용 역할·로그·함수 URL을 만듭니다. 기준은 결정 기록 D16-A3·A7·A8·B1·B2·B6·B7, 아키텍처 18.3입니다.

- **입구:** 함수 URL은 IAM 인증(`AWS_IAM`)이라 서명 없는 요청은 Lambda 앞에서 막힙니다. 관리자 사이트 CloudFront + OAC에 `/ops/*` 동작으로 연결하는 일은 관리자 배포(BRD-147)에서 합니다. 그 전까지는 이 함수를 부를 수 있는 곳이 없습니다.
- **토큰:** 관리자 앱은 access token을 `x-baradun-access-token` 헤더로 보냅니다. `Authorization`은 OAC가 함수 URL로 보낼 때 SigV4 서명에 쓰므로 쓰지 않습니다.
- **검증:** 서명·`iss`·`client_id`·`token_use=access`·`exp`는 `aws-jwt-verify`가 검사합니다(운영자 풀·샘플 풀만 믿음). 그 위에 최초 인증(`auth_time`)부터 8시간 상한, 그룹 역할(운영자 그룹이 정확히 하나가 아니면 거부)을 검사합니다. 운영자 풀은 MFA 필수라 그 풀의 토큰은 인증 앱을 거친 것입니다.
- **샘플:** 샘플 풀 토큰은 Ops 테이블 `admin#config` / `sample` 항목의 sub 허용 목록·허용 기간(시작 포함·끝 제외)으로 다시 검사합니다. 항목이 없거나 기간 밖이면 거부하고, 모든 쓰기를 거부합니다.
- **허용표:** `services/src/admin/routes.ts`가 경로·method별 허용 역할의 원본입니다. 지금 경로는 `GET /ops/me`(역할·세션 끝 시각) 하나이고, 업무 경로는 각 이슈에서 더합니다. 판단 상태를 쓰는 경로는 두지 않습니다.
- **쓰기:** `versionedWrite`가 version 조건부 쓰기 + 멱등 키 + 본문 해시를 한 트랜잭션으로 씁니다. 같은 키·같은 내용은 앞 결과, 같은 키·다른 내용이나 version 불일치는 409입니다. 운영 API 키는 모두 `admin#`으로 시작해 게시 잠금·슬롯·게시 버전 키와 겹치지 않습니다.
- **응답:** 모두 `cache-control: no-store`. 오류 본문은 `{ error: { code, requestId: "req-xxxxxxxx", traceId } }`이고 문구는 관리자 앱이 정합니다.
- **권한:** 역할은 Ops 테이블 `GetItem`·`PutItem`·`UpdateItem`, 감사 키 `Query`(아래 변경 이력), 문의 처리(아래), 자기 로그만 씁니다. State 테이블 권한은 없습니다. 실행 정책·boundary는 바뀌지 않습니다(기존 `BaradunV2-*` 범위 안).

### 샘플 시연 허용 설정

시연 때만 넣고, 끝나면 지우거나 `allowedUntil`을 지난 시각으로 둡니다. sub는 샘플 풀 사용자의 sub입니다(`aws cognito-idp list-users --user-pool-id <SampleUserPoolId>`).

```bash
aws dynamodb put-item --region ap-northeast-2 --table-name <OpsTableName> --item '{
  "pk": {"S": "admin#config"}, "sk": {"S": "sample"},
  "subs": {"L": [{"S": "<샘플 sub>"}]},
  "allowedFrom": {"S": "2026-11-10T00:00:00+09:00"},
  "allowedUntil": {"S": "2026-11-11T00:00:00+09:00"}
}'
aws dynamodb delete-item --region ap-northeast-2 --table-name <OpsTableName> \
  --key '{"pk": {"S": "admin#config"}, "sk": {"S": "sample"}}'
```

시각은 시간대를 붙여 씁니다(시간대 없는 값은 설정 전체를 무효로 봅니다).

### 문의 처리(BRD-153)

운영자 화면 문의 목록·상세·처리 상태 API입니다. 기준은 결정 기록 D16-B4·D5·D6, 화면 설계서 6장 ADM-INQ, 구현 제안 I07·I08입니다.

- **경로:** `GET /ops/inquiries?status=&cursor=&limit=`(목록), `GET /ops/inquiries/{id}`(상세), `PATCH /ops/inquiries/{id}`(처리 상태·반려 이유·내부 메모, 편집·노출 변경 권한). 쓰기에는 `x-idempotency-key`(UUID v4) 헤더와 읽을 때 받은 `version`을 함께 보냅니다.
- **상태:** 접수(received)·확인 중(in_progress)·완료(resolved)·반려(rejected). 반려는 이유가 필수이고 공백만은 거부합니다. 반려가 아닌 상태로 바꾸면 반려 이유를 지웁니다.
- **목록:** `inquiryStatus-receivedAt` GSI(요약만, 본문·이메일·사진 키 없음)를 최근 접수 순으로 읽습니다. 상태를 고르지 않으면 접수 → 확인 중 → 완료 → 반려 순으로 이어 붙이고, `cursor`로 다음 쪽을 이어 갑니다. GSI는 최종적 일관성이라 저장 직후 목록이 잠시 이전 값일 수 있습니다. 그래서 처리(PATCH)에는 목록이 아니라 상세(강한 일관성)에서 받은 `version`을 씁니다. 상태를 고른 목록에는 같은 상태 목록에서 받은 `cursor`만 넣습니다.
- **보관:** 받은 날부터 90일(TTL) 그대로입니다. TTL로 지워지기 전이라도 기한이 지난 문의는 목록·상세·수정에서 뺍니다. 처리 상태·메모는 같은 항목에 붙어 함께 만료됩니다.
- **권한:** 보기 권한은 본문·메모·반려 이유를 받지 않습니다. 샘플 계정은 실제 테이블을 읽지 않고 예시 문의만 받습니다. 개인정보 가리기·문의 지우기·같은 해변 묶음(D16-D7)은 이 범위가 아닙니다.
- **용량:** GSI 읽기·쓰기 1/1을 더해 테이블·GSI 합계 12/12(상한 25)입니다.

#### 배포와 기존 문의 이전(구현 제안 I07 순서)

1. **dry-run:** 이전할 문의 수를 셉니다(쓰지 않음). 배포 전에 해도 됩니다.
2. **배포:** 변경 세트 기대 내용은 Inquiry 테이블 `Modify`(GSI 추가, 교체 없음), 문의 접수 함수 코드 `Modify`(새 문의를 접수·version 1로 저장), 운영 API 함수·역할 정책 `Modify`입니다. GSI는 만들어지는 동안 `CREATING`이고, 테이블은 그동안에도 쓸 수 있습니다.
3. **apply:** 상태가 없는 기존 문의만 접수·version 1·`legacy`(이전 문의·처리 이력 없음)로 채웁니다. 접수 시각·보관 기한은 바꾸지 않습니다. 쓰기 1/초 용량이라 쪽마다 1초씩 쉬어 갑니다. 다시 돌려도 결과가 같습니다.
4. **verify:** GSI가 `ACTIVE`가 된 뒤 원본 테이블의 보관 기한 안 문의 수와 GSI 상태별 합계를 대조합니다. `matches: true`면 끝입니다.

```bash
export AWS_PROFILE=<관리자 프로필>
npx --no-install tsx services/scripts/inquiry-status-backfill.ts --table <InquiryTableName> --dry-run
npx --no-install tsx services/scripts/inquiry-status-backfill.ts --table <InquiryTableName> --apply
aws dynamodb describe-table --region ap-northeast-2 --table-name <InquiryTableName> \
  --query 'Table.GlobalSecondaryIndexes[].IndexStatus' --output text   # ACTIVE 확인
npx --no-install tsx services/scripts/inquiry-status-backfill.ts --table <InquiryTableName> --verify
```

이전 도구는 문의 본문·이메일을 읽거나 출력하지 않고 개수만 보여 줍니다. 이전 전에 운영 API가 상태 없는 문의를 바꾸면(version 0) 같은 방식으로 접수·이전 문의 표시를 함께 채웁니다.

### 변경 이력(BRD-155)

운영 API 쓰기와 샘플 계정 사용을 남기는 감사 기록입니다. 기준은 결정 기록 D16-B5, 아키텍처 18.3, 화면 설계서 6장 ADM-AUD입니다. 코드는 `services/src/admin/audit.ts`입니다.

- **저장:** Ops 테이블 `admin#audit#{YYYY-MM}`(UTC 월) / `{시각}#{traceId}`. 시각은 UTC ISO이고 화면이 Asia/Seoul로 바꿔 보여 줍니다. 보관은 366일(TTL)입니다.
- **내용:** 시각·운영자(Cognito sub)·역할·종류(`inquiry.update`·`sample.read`·`sample.denied`)·대상·바뀐 항목 이름. 문의 처리 상태는 앞·뒤 값도 남깁니다. 문의 본문·내부 메모·반려 이유 글·이메일은 남기지 않습니다(테스트로 확인).
- **함께 쓰기:** 운영 API 쓰기(`versionedWrite`)는 감사 기록 없이 받지 않고, 멱등 기록·업무 변경·감사 기록을 한 트랜잭션으로 씁니다. 재전송·version 충돌은 바뀐 것이 없으므로 기록하지 않습니다. 감사 기록은 새 키에만 씁니다(`attribute_not_exists`).
- **샘플 계정:** 로그인 확인(`/ops/me`)·조회·거절된 요청을 모두 남깁니다(대상은 `GET /ops/inquiries/{id}`처럼 경로 모양만). 기록에 실패하면 응답하지 않습니다(500). 운영자 조회는 남기지 않습니다(쓰기만). 샘플 요청마다 Ops 쓰기 1을 쓰므로(게시 잠금·수집 슬롯과 같은 쓰기 5) 요청 빈도 제한은 입구 연결(BRD-147)에서 함께 정합니다. 그 전까지는 함수 URL을 부를 곳이 없습니다.
- **목록:** `GET /ops/audit?from=&to=&action=&actor=&cursor=&limit=`(보기 이상, 샘플은 403). `from`·`to`는 `Z`로 끝나는 UTC 시각만 받고, 기본은 최근 30일·최대 366일입니다. 최근 기록부터 월 파티션을 내려가며 읽고, 한 요청에 20쪽까지 읽은 뒤 `cursor`로 이어 갑니다. 보관 기한(ttl)이 지난 기록은 TTL로 지워지기 전이라도 뺍니다. `cursor`에는 필터가 담기므로 다른 필터와 섞으면 400입니다.
- **권한:** 운영 API 역할의 Ops `Query`는 `dynamodb:LeadingKeys`가 `admin#audit#*`이거나 공지 파티션 `admin#notice`일 때만 됩니다. 감사 키의 `UpdateItem`·`DeleteItem`은 명시적으로 거부합니다(`DeleteItem`은 원래 허용도 없음). Put 권한만으로는 추가 전용이 되지 않으므로 위 조건부 쓰기·트랜잭션이 함께 막습니다.
- **배포:** 운영 API 함수 코드와 역할 정책 `Modify`만 바뀝니다(테이블·실행 정책 변경 없음).
- **복구:** Ops 테이블 PITR은 꺼져 있고 로그는 1주 보관이라, 이 기록은 논리적 1년 보관이지 재해 복구를 보장하지 않습니다(구현 제안 I10, 미확정).
- **화면:** 관리자 앱(BRD-147)이 생긴 뒤 기간·종류·운영자 필터와 대상 이동을 붙입니다. 해변 파일 변경은 저장소 커밋이 이력이므로 여기 남기지 않습니다.

### 공지(BRD-151)

운영자가 쓰는 점검 예고·일반 공지입니다. 기준은 결정 기록 D16-B3·D1~D4, 아키텍처 18.4, 화면 설계서 6장 ADM-NTC입니다. 코드는 `services/src/admin/notices.ts`·`notice-routes.ts`입니다.

- **저장:** Ops 테이블 `admin#notice` / `{공지 ID}`. 공지마다 저장한 문구(`draft`, 화면 말 '대기')와 노출본(`live`)을 따로 둡니다. 둘이 다르면 '수정 대기'입니다. 지우면 `deletedAt`만 남기고 항목은 지우지 않습니다.
- **경로:** `GET /ops/notices`(보기 이상·샘플, 운영자 sub는 주지 않음) · `POST /ops/notices`·`PUT /ops/notices/{id}`(편집: 문구 저장) · `POST /ops/notices/{id}/expose`·`/end`(노출 변경: 노출·노출 끝내기) · `DELETE /ops/notices/{id}`(노출 중이면 409, 예약된 노출본이 있으면 노출 변경만). 쓰기는 모두 version·멱등 키·감사 기록을 함께 씁니다.
- **노출 검사:** 한·영 제목·본문이 모두 있어야 하고, 글자 수는 grapheme으로 제목 한 40/영 60·본문 한 120/영 200(D16-D2 초기값) 안이어야 합니다. 넘으면 잘라 내지 않고 거부합니다. 끝 시각은 시작 뒤이고 아직 지나지 않아야 합니다. 표현 검사(D16-D1)의 차단·경고 목록은 미결(D15-9, BRD-158)이라 아직 막지 않습니다.
- **게시:** publisher가 게시할 때 노출본 중 시작 시각이 지났고 끝나지 않은 공지만 manifest `notices`에 ID 순으로 싣습니다(예약 전 문구는 공개 게시본에 없음). 계약에 맞지 않는 공지는 그것만 빼고 `publish_notice_invalid`를 남깁니다. 운영 DB를 읽지 못하면 지금 manifest의 공지를 이어서 싣고 `publish_notices_unread`를 남깁니다(특보·관측 게시는 멈추지 않음). 공지만 바뀌어도 새 버전으로 게시합니다.
- **권한:** publisher 역할의 Ops `Query`는 `dynamodb:LeadingKeys`가 `admin#notice`일 때만 됩니다.
- **되돌리기:** `rollbackManifest`는 사본에 실린 공지를 그대로 되돌립니다. 되돌린 공지 변경을 다음 자동 게시에 다시 싣지 않는 방식(D16-C3)은 미결이라 BRD-152에서 정합니다.
- **배포:** publisher·운영 API 함수 코드와 두 역할 정책 `Modify`만 바뀝니다(테이블 변경 없음).

## 점검·강제 업데이트

점검 중 여부와 최소 화면 버전은 `manifest.json`의 `maintenance`·`minWebBuild`로 알립니다(아키텍처 9.1, BRD-43). 값은 `services/src/publisher/policy.ts`의 `MANIFEST_SETTINGS`(저장소 상수)에 있고, 바꾸려면 저장소를 고쳐 배포합니다(결정 기록 11장 10/23 ④). 게시 함수는 데이터가 그대로여도 지금 manifest와 설정이 다르면 새 버전으로 게시합니다.

- **점검 중**(`maintenance.active: true`): 화면이 점검 화면으로 전체를 덮고 마지막 값도 숨깁니다. `until`은 종료 예정 시각(UTC ISO), 모르면 `null`.
- **강제 업데이트**: 화면 빌드 번호(`apps/web/src/lib/snapshot/build.ts`의 `WEB_BUILD`)가 `minWebBuild`보다 낮으면 화면이 바로 강제 업데이트 상태가 됩니다(값 숨김, status 받지 않음). **자동으로 새로고침하지 않습니다**(2026-10-26 결정: 입력 중 화면이 사라지거나 새로고침이 반복될 수 있음). 강제 업데이트 화면(L15, BRD-38)의 버튼이 `window.location.reload()`를 부르고, 사이트 HTML은 `max-age=0`이라 그때 새 화면 파일을 받습니다.
- `MANIFEST_SETTINGS.minWebBuild`가 `WEB_BUILD`보다 크면 `npm test -w infra`(publisher.test)가 실패합니다. 순서를 어긴 PR이 CI를 통과하지 못하게 하는 장치입니다.

### 점검 켜기·끄기

1. `MANIFEST_SETTINGS.maintenance`를 `{ active: true, until: "2026-11-06T09:00:00Z" }`처럼 바꿔 PR로 머지합니다. 끌 때는 `{ active: false, until: null }`.
2. 최신 `origin/main` 작업 트리에서 `npx cdk deploy`합니다(맨 위 배포 절차). services 코드는 Lambda 번들로 들어가서 사이트 배포(`deploy.yml`)로는 반영되지 않습니다.
3. 다음 게시에 반영됩니다. 수집기가 15분 안에 게시를 깨우고, 바로 반영하려면 게시 함수를 직접 부릅니다.

   ```bash
   aws lambda invoke --function-name <PublisherFunctionName> \
     --cli-binary-format raw-in-base64-out \
     --payload '{}' /dev/stdout
   ```

4. 반영을 확인합니다(manifest 캐시 60초): `curl -s https://<DistributionDomainName>/data/manifest.json | jq '{snapshotVersion, maintenance, minWebBuild}'`. 게시 로그에 `publish_unchanged`만 남았다면 배포가 아직 반영되지 않은 것입니다(Lambda 코드 확인).

### 강제 업데이트

순서가 중요합니다. **새 화면을 먼저 배포하고, 그 뒤에 `minWebBuild`를 올립니다.** 반대로 하면 사용자가 새로고침해도 이전 화면 파일만 받아 강제 업데이트 화면에서 벗어나지 못합니다.

1. 이전 화면이 새 데이터를 잘못 읽을 수 있는 변경일 때만 합니다. `WEB_BUILD`를 1 올린 PR을 main에 머지하면 `deploy.yml`이 사이트를 배포합니다. 배포가 끝났는지 확인합니다.
2. `MANIFEST_SETTINGS.minWebBuild`를 같은 값으로 올린 PR을 머지하고 `npx cdk deploy`합니다. `minWebBuild`는 배포된 `WEB_BUILD`보다 크게 두지 않습니다(infra 테스트가 막음).
3. 점검과 같은 방법(3·4단계)으로 반영을 확인합니다.

서비스 워커(오프라인)가 생기면 새로고침이 이전 화면 파일을 내주지 않는지 그 작업에서 다시 확인합니다.
