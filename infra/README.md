# infra

AWS CDK(TypeScript) 스택입니다. 구성(S3 사이트·데이터 버킷, CloudFront, DynamoDB, Scheduler, GitHub OIDC, Budgets)의 기준은 Notion 'V2 아키텍처 기준 문서' 11장입니다.

```bash
npm run build -w @baradun/infra   # 타입 검사(tsc)
npm run test -w @baradun/infra    # Vitest (스택 템플릿·권한·가드레일)
npx cdk synth                     # CloudFormation 템플릿 생성 (infra/에서)
npx cdk diff                      # 배포된 스택과 비교
```

배포(`npx cdk deploy`)는 요청이 있을 때만 합니다. 첫 배포 전 부트스트랩 실행 정책은 `bootstrap/cfn-execution-policy.json`에 있습니다.
