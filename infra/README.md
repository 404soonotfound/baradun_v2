# infra

AWS CDK(TypeScript) 스택입니다. 구성(S3 사이트·데이터 버킷, CloudFront, DynamoDB, Scheduler, GitHub OIDC, Budgets)의 기준은 Notion 'V2 아키텍처 기준 문서' 11장입니다.

```bash
npm run build -w @baradun/infra   # 타입 검사(tsc)
npm run test -w @baradun/infra    # Vitest (스택 템플릿·권한·가드레일)
npx cdk synth                     # CloudFormation 템플릿 생성 (infra/에서)
npx cdk diff                      # 배포된 스택과 비교
```

배포(`npx cdk deploy`)는 요청이 있을 때만 하고, 최신 `origin/main`을 꺼낸 작업 트리에서 합니다. 작업 중인 브랜치에서 배포하면 머지되지 않은 코드가 실환경에 올라갑니다.

```bash
git fetch origin && git worktree add ../baradun_v2-deploy origin/main --detach
cd ../baradun_v2-deploy && npm ci && cd infra && npx cdk diff && npx cdk deploy
```

첫 배포 전 부트스트랩 실행 정책은 `bootstrap/cfn-execution-policy.json`에 있습니다.

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

1. main 머지 뒤 사이트 배포(`deploy.yml`)는 production 승인 대기에 둡니다.
2. 최신 `origin/main` 작업 트리에서 `npx cdk deploy`(맨 위 배포 절차) → 출력 `InquiryPhotoBucketName`을 GitHub Variables `INQUIRY_PHOTO_BUCKET`에 넣습니다.
3. 사이트 배포를 승인합니다. 2와 3 사이에 열려 있던 이전 화면의 문의는 거부되므로 바로 이어서 합니다.

문의 유형 4개·`beachId`·`activity` 칸·사진 4MiB(결정 기록 12장 결정 21~23)를 처음 배포할 때도 같은 순서를 지킵니다. 새 Lambda는 이전 화면의 `other` 유형과 4MiB를 넘는 사진 양식 요청을 400으로 거부하고, 이전 Lambda는 새 유형과 `beachId`·`activity` 칸을 400으로 거부합니다.

요청·응답 타입은 `@baradun/contracts`의 `InquiryUploadRequest`, `InquiryUploadResponse`, `CreateInquiryRequest`, `CreateInquiryResponse`, `InquiryErrorResponse`입니다. 문의 유형은 화면 칩과 1:1로 `data_error`(정보가 실제와 달라요)·`data_question`(판단 기준이 궁금해요)·`beach_request`(해변을 추가해 주세요)·`data_suggestion`(새 데이터를 제안해요)입니다(결정 기록 12장 결정 21). 장소 상세에서 들어온 문의는 본문에 섞지 않고 `beachId`(예: `b0001`)와 `activity`(`swimming`·`surfing`·`scuba`) 칸으로 보내며, `activity`는 `beachId` 없이 오지 않습니다(결정 22). 둘 다 문의 항목과 메일 알림에 따로 들어갑니다. 사진에 EXIF GPS IFD가 있거나 파일이 깨졌으면 그 사진만 `rejected`로 돌아오며 문의 자체는 접수됩니다. 사진은 공개 URL 없이 비공개 버킷에 두고 30일 수명 주기로 삭제합니다.

문의 본문 항목은 접수 뒤 90일, 이메일은 별도 항목으로 88일 TTL을 둡니다. 처리가 끝난 이메일은 문의 Lambda를 함수 URL이 아닌 직접 호출로 아래 이벤트를 보내 즉시 삭제합니다. DynamoDB TTL 삭제는 비동기이므로 88일 값으로 90일 이내 삭제 여유를 둡니다.

```json
{ "action": "delete_email", "inquiryId": "문의 UUID" }
```

새 문의 알림은 배포 파라미터 `AlertEmail`로 만든 SNS 이메일 구독을 사용하므로 첫 배포 뒤 구독 확인이 필요합니다. 알림에는 문의 ID·유형·120자 이내 요약·이메일 제공 여부만 들어가며 실제 이메일 주소와 전체 본문은 넣지 않습니다.

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

`OpsAlarms`가 CloudWatch 경보 9개(수집기 4개·게시 함수의 오류, 특보·관측·이안류 수집과 게시의 실행 없음)를 만들고 운영 SNS 주제로 `AlertEmail`에 메일을 보냅니다.

- 경보를 처음 넣는 배포 전에 실행 정책 `BaradunCdkExecution`을 새 버전으로 올립니다(위 '역할 권한 상한' 2단계 명령). 올리지 않으면 `cloudwatch:PutMetricAlarm`이 거부되어 배포가 롤백됩니다.
- 운영 주제는 문의 알림 주제와 따로라서 첫 배포 뒤 구독 확인 메일이 한 통 더 옵니다. 확인하지 않으면 경보가 울려도 메일이 가지 않습니다.

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
