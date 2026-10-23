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
