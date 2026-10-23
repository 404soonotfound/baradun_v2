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
