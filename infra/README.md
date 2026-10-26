# infra

AWS CDK(TypeScript) 스택입니다. 구성(S3 사이트·데이터 버킷, CloudFront, DynamoDB, Scheduler, GitHub OIDC, Budgets)의 기준은 Notion 'V2 아키텍처 기준 문서' 11장입니다.

```bash
npm run build -w @baradun/infra   # 타입 검사(tsc)
npm run test -w @baradun/infra    # Vitest (스택 템플릿·권한·가드레일)
npx cdk synth                     # CloudFormation 템플릿 생성 (infra/에서)
npx cdk diff                      # 배포된 스택과 비교
```

배포(`npx cdk deploy`)는 요청이 있을 때만 합니다. 첫 배포 전 부트스트랩 실행 정책은 `bootstrap/cfn-execution-policy.json`에 있습니다.

코드 자산 읽기는 `cdk-hnb659fds-assets-${aws:PrincipalAccount}-ap-northeast-2` 버킷으로 제한합니다. `${aws:PrincipalAccount}`는 IAM이 요청 시 실행 역할의 계정 번호로 해석하는 정책 변수이며, 파일을 그대로 IAM 정책으로 사용합니다. 다른 계정·리전의 자산 버킷은 허용하지 않습니다.

로그 그룹 목록 읽기(`logs:DescribeLogGroups`)는 CloudFormation이 로그 그룹 속성(GetAtt)을 읽을 때 필요해 따로 허락합니다. 공식 권한 표에 리소스 유형이 없어 `Resource`는 `*`입니다. 서울 리전으로 좁히는 `aws:RequestedRegion` 조건은 실제 배포로 확인한 뒤 넣습니다.

## 역할 권한 상한

스택이 만드는 모든 역할에는 권한 상한(permissions boundary) `BaradunV2-RoleBoundary`가 붙습니다. 정책 문서는 `bootstrap/role-boundary-policy.json`입니다. 실행 정책은 이 boundary가 붙은 역할만 만들고, 인라인 정책을 바꾸게 허락합니다. 관리형 정책 부착, boundary 떼기, boundary 정책 고치기는 허락하지 않습니다. 그래서 배포 권한이 탈취되어도 역할의 권한은 boundary 안으로 제한됩니다.

boundary 정책의 `Resource` ARN에는 계정 번호(`717304679248`)를 그대로 씁니다. AWS는 Resource ARN의 계정 자리에 정책 변수(`${aws:PrincipalAccount}`)를 허용하지 않기 때문입니다. boundary의 Condition 값(`lambda:SourceFunctionArn`)도 같은 계정 번호로 맞춥니다. 실행 정책의 Condition 값과 S3 버킷 이름에서는 정책 변수를 그대로 씁니다. 스택은 로그인한 계정에 배포되므로, 다른 계정에 만들 때는 boundary 정책 파일과 `test/guardrails.test.ts`의 계정 번호를 함께 바꿉니다. 바꾸지 않으면 역할 권한이 모두 막혀 수집기가 실행할 때 실패합니다.

boundary 정책은 스택 밖에서 관리합니다. 정책 파일을 바꿨다면 순서대로 반영합니다.

1. boundary 정책을 먼저 만들거나 고칩니다. 실행 정책이 boundary 정책 수정을 거부하므로 관리자 권한으로 합니다.

   ```bash
   # 처음 만들 때
   aws iam create-policy --policy-name BaradunV2-RoleBoundary \
     --policy-document file://bootstrap/role-boundary-policy.json
   # 이미 있을 때 (버전은 최대 5개라 넘으면 오래된 버전을 지웁니다)
   aws iam create-policy-version --set-as-default \
     --policy-arn arn:aws:iam::<계정>:policy/BaradunV2-RoleBoundary \
     --policy-document file://bootstrap/role-boundary-policy.json
   ```

2. 실행 정책 `BaradunCdkExecution`의 새 버전을 기본으로 올립니다. 버전은 최대 5개라 넘으면 오래된 버전을 지웁니다.

   ```bash
   aws iam create-policy-version --set-as-default \
     --policy-arn arn:aws:iam::<계정>:policy/BaradunCdkExecution \
     --policy-document file://bootstrap/cfn-execution-policy.json
   ```

3. `npx cdk deploy`를 실행합니다. 기존 역할에는 boundary가 먼저 붙고, 그다음 정책이 바뀝니다.

   boundary를 처음 붙이는 배포가 중간에 실패하면 CloudFormation 롤백이 boundary를 떼려다 실행 정책의 거부(`NoBoundaryRemoval`)에 막혀 `UPDATE_ROLLBACK_FAILED`가 됩니다. 이때는 관리자 권한으로 `aws cloudformation continue-update-rollback --stack-name BaradunV2 --resources-to-skip <막힌 역할 논리 ID>`를 실행해 해당 역할을 건너뛰고(boundary는 붙은 채로 둠) 원인을 고친 뒤 다시 배포합니다.

역할 정책에 새 동작을 추가하면 boundary에도 넣어야 합니다. 빠지면 실행할 때 거부됩니다. `test/guardrails.test.ts`는 빠진 동작 이름만 잡습니다. 리소스 범위(이름이 `BaradunV2-`·`baradunv2-`로 시작하는지, 리전)는 템플릿에서 실제 이름을 알 수 없어 테스트가 확인하지 않으므로, 새 리소스를 쓰면 boundary의 `Resource`를 직접 확인합니다.

API 키 읽기(`ssm:GetParameter`)는 boundary에서 스택의 Lambda 함수가 보낸 요청(`lambda:SourceFunctionArn`)으로만 허락합니다. 실행 권한을 탈취해 외부 계정이 맡을 수 있는 역할을 만들어도 키를 읽지 못하게 하려는 것입니다. IAM 정책 시뮬레이터는 이 조건 키를 평가하지 못하므로, 수집기를 처음 배포할 때 키 읽기가 되는지 로그로 확인합니다. 막히면 수집기는 `api_key` 실패로 기록합니다.

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

## 데이터 게시(publish-snapshot)와 롤백

수집기 3개가 수집을 마칠 때마다 `publish-snapshot`을 비동기로 깨웁니다(아키텍처 6.2). 게시 함수는 State를 읽어 해변 상태를 계산하고 `data/{버전}/`에 파일 네 개를 올린 뒤 `data/manifest.json`을 조건부 쓰기(If-Match)로 바꿉니다. 실패하면 manifest는 이전 버전 그대로이고, 함수는 오류로 끝나 Lambda 오류 지표에 남습니다.

롤백(T06)은 manifest를 이전 버전으로 되돌립니다. 버전 경로는 최근 48개가 남아 있습니다.

1. 게시 코드 문제로 되돌리는 경우 수집 일정을 먼저 멈춥니다. 멈추지 않으면 다음 수집(15분 안)이 새 버전으로 다시 게시합니다.

   ```bash
   aws scheduler update-schedule ... --state DISABLED   # 세 일정 모두
   ```

2. 되돌릴 버전을 고릅니다: `aws s3 ls s3://<SiteBucketName>/data/`
3. 게시 함수를 롤백 이벤트로 직접 부릅니다(`PublisherFunctionName` 출력값).

   ```bash
   aws lambda invoke --function-name <PublisherFunctionName> \
     --cli-binary-format raw-in-base64-out \
     --payload '{"action":"rollback","version":"20261017T053000Z"}' out.json
   ```

   그 버전의 manifest 사본과 파일 네 개가 모두 있을 때만 되돌립니다. 하나라도 없으면 지금 manifest를 그대로 두고 오류로 끝납니다.

4. 사이트에서 manifest가 바뀌었는지 확인합니다(manifest 캐시 60초): `curl -s https://<DistributionDomainName>/data/manifest.json`
5. 원인을 고친 뒤 일정을 다시 켭니다(`--state ENABLED`). 다음 수집이 새 버전을 게시합니다.

롤백 리허설 결과(일시·되돌린 버전·복구에 걸린 시간)는 출시 점검표에 기록합니다.
