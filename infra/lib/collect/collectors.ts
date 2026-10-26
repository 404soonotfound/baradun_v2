// 가져오기. aws-cdk-lib 안의 기능 묶음을 이름 붙여 가져옴
// 예: lambda.Runtime → Lambda 실행 환경 목록, iam.PolicyStatement → 권한 한 줄
import { Duration, Stack, TimeZone } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import { Construct } from "constructs";
import * as path from "node:path";
import {
  apiKeyParameterName,
  CATALOG_SCHEDULE_KST,
  COLLECTOR_MEMORY_MB,
  COLLECTOR_SCHEDULE_MINUTES,
  COLLECTOR_TIMEOUT_SECONDS,
  LOG_RETENTION,
  RETRY_LIMITS,
  type ApiKeyName,
} from "../settings";

// 이 파일이 만드는 것 (아키텍처 5장, BRD-56·BRD-58)
// 공공 API에서 바다 정보를 받아 DynamoDB에 저장하는 프로그램(수집기) 3개를 AWS에 올리고,
// 정해진 시각마다 저절로 실행되게 함
// - 바다 관측 수집기(Ocean): 파고·수온·바람·파주기·파향. 30분마다
// - 특보 수집기(Warnings): 풍랑·강풍 등 특보와 지진해일. 15분마다
// - 카탈로그 수집기(Catalog): 대표 사진의 공공누리 유형 재확인. 하루 1회(한국 시각 04:20)
// 수집기는 DynamoDB에만 씀. 사이트 데이터 파일(S3 data/)은 publisher만 씀(BRD-52)
// 수집을 마치면 publisher(publish-snapshot)를 비동기로 깨움(아키텍처 6.2, BRD-61)

// 이 묶음을 만들 때 밖에서 넘겨받는 값
export interface CollectorsProps {
  // 수집한 값을 저장하는 표(State 테이블)
  readonly stateTable: dynamodb.ITable;
  // "이 시간대 수집은 끝났음/누가 하는 중" 기록을 남기는 표(Ops 테이블)
  // 같은 시간대를 두 번 수집하지 않으려고 씀
  readonly opsTable: dynamodb.ITable;
  // 수집을 마치면 비동기로 깨울 publish-snapshot 함수(아키텍처 6.2, BRD-61)
  readonly publisher: lambda.IFunction;
}

// 저장소 맨 위 폴더 경로
// __dirname = 지금 이 파일이 있는 폴더(infra/lib/collect). ".." 세 번 = 세 칸 위
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
// Lambda에 올릴 코드의 시작 파일. 두 수집기가 같은 파일을 쓰고, 그 안의 다른 함수를 부름
const HANDLER_FILE = path.join(
  REPO_ROOT,
  "services/src/collectors/handlers.ts",
);

// 세 수집기에서 서로 다른 값만 모은 표. 나머지 설정은 아래 for 문에서 똑같이 씀
// cron: 실행 시각. minute만 있으면 매시 그 분, hour가 있으면 하루 한 번 그 시각(모두 한국 시각)
const COLLECTORS = [
  {
    id: "Ocean", // AWS 안에서 쓸 이름의 앞부분
    handler: "oceanHandler", // handlers.ts 안에서 부를 함수 이름
    cron: { minute: COLLECTOR_SCHEDULE_MINUTES.ocean }, // 매시 10분·40분
    apiKey: "kma-apihub", // 쓸 API 키 이름(기상청 API허브: sea_obs·kma_buoy)
    description: `baradun v2 collect-ocean (N3 :${COLLECTOR_SCHEDULE_MINUTES.ocean})`,
  },
  {
    id: "Warnings",
    handler: "warningsHandler",
    cron: { minute: COLLECTOR_SCHEDULE_MINUTES.warnings },
    apiKey: "data-go-kr", // 공공데이터포털: getPwnCd·getTsunamiMsg
    description: `baradun v2 collect-warnings (N3 :${COLLECTOR_SCHEDULE_MINUTES.warnings})`,
  },
  {
    id: "Catalog",
    handler: "catalogHandler",
    cron: CATALOG_SCHEDULE_KST, // 하루 1회 한국 시각 04:20
    apiKey: "data-go-kr", // 공공데이터포털: TourAPI KorService2
    description: `baradun v2 collect-catalog (D6 하루 1회 KST ${CATALOG_SCHEDULE_KST.hour}:${CATALOG_SCHEDULE_KST.minute})`,
  },
  // as const: 값을 고정(바꿀 수 없음)
  // satisfies { … }[]: 각 줄에 이 칸들이 다 있는지, apiKey가 정해진 키 이름인지 타입 검사
] as const satisfies readonly {
  id: string;
  handler: string;
  cron: { minute: string; hour?: string };
  apiKey: ApiKeyName;
  description: string;
}[];

// 실행이 실패했을 때 AWS가 알아서 다시 실행하는 횟수: 0번
// 이유: 수집기는 시작할 때 "이 시간대는 내가 함" 표시를 2분 동안 걸어 둠
// AWS의 자동 재실행은 실패 1분쯤 뒤에 오는데, 그때는 아직 표시가 남아 있어서 수집기가 "다른 실행이 하는 중"으로 보고 그냥 끝남
// → 다시 실행해도 아무 일도 안 하므로 0번으로 둠. 실패해도 다음 실행(15·30분 뒤)이 최신 값을 다시 받음
const ASYNC_RETRIES = 0;

// Construct: CDK에서 리소스 여러 개를 하나로 묶는 단위. 스택에서 new Collectors(…) 한 줄로 전부 만들어짐
export class Collectors extends Construct {
  // 만든 함수를 밖(스택)에서 꺼내 쓰려고 보관. 배포 뒤 함수 이름을 출력할 때 씀
  // Map: "이름 → 값" 목록. 여기서는 "Ocean" → 함수, "Warnings" → 함수
  readonly functions = new Map<string, nodejs.NodejsFunction>();

  constructor(scope: Construct, id: string, props: CollectorsProps) {
    super(scope, id); // 부모(Construct) 쪽 준비. CDK 규칙상 맨 처음에 부름

    // 표의 수집기마다 같은 순서로 리소스를 만듦
    for (const c of COLLECTORS) {
      // ① 로그 보관함. 실행 기록(console 출력)이 쌓이는 곳
      // 직접 만들지 않으면 Lambda가 "영원히 보관"으로 만들어 요금이 계속 늘 수 있음 → 1주 보관으로 만듦
      const logGroup = new logs.LogGroup(this, `${c.id}Logs`, {
        retention: LOG_RETENTION, // settings.ts의 1주
      });

      // 기본 관리형 정책의 전체 로그 그룹(*) 쓰기 권한 대신 자기 로그 그룹만 허용함
      const role = new iam.Role(this, `${c.id}Role`, {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      });
      // 로그 그룹은 위에서 만들므로 함수에는 스트림 생성·기록 권한만 필요함
      logGroup.grant(role, "logs:CreateLogStream", "logs:PutLogEvents");

      // ② Lambda 함수. NodejsFunction은 TypeScript 파일을 하나의 JS 파일로 묶어서(esbuild) 올려 줌
      const fn = new nodejs.NodejsFunction(this, `${c.id}Function`, {
        entry: HANDLER_FILE, // 묶기를 시작할 파일
        handler: c.handler, // Lambda가 실행할 함수 이름
        runtime: lambda.Runtime.NODEJS_22_X, // Node.js 22 (저장소 .nvmrc와 같은 버전)
        architecture: lambda.Architecture.ARM_64, // ARM 칩. 같은 성능에 Intel(x86)보다 요금이 쌈
        memorySize: COLLECTOR_MEMORY_MB, // 256MB
        timeout: Duration.seconds(COLLECTOR_TIMEOUT_SECONDS), // 60초 넘으면 AWS가 강제로 멈춤
        logGroup, // ①에서 만든 로그 보관함 사용
        role,
        // 묶을 때 기준이 되는 폴더와 설치 목록 파일
        // 이 저장소는 여러 패키지를 루트 하나에서 설치함(npm workspaces) → 루트 것을 지정
        projectRoot: REPO_ROOT,
        depsLockFilePath: path.join(REPO_ROOT, "package-lock.json"),
        bundling: {
          // AWS SDK(DynamoDB·SSM 접속 라이브러리)도 함께 묶음
          // Lambda에 이미 들어 있는 SDK는 버전이 달라질 수 있음 → 테스트한 버전 그대로 올림
          externalModules: [],
          target: "node22", // Node 22가 이해하는 문법으로 바꿔 묶음
        },
        // 함수 안에서 읽을 설정값. 테이블 이름은 배포 때 AWS가 정해서 코드에 미리 적을 수 없음
        // handlers.ts가 process.env.STATE_TABLE_NAME 등으로 읽음
        environment: {
          STATE_TABLE_NAME: props.stateTable.tableName,
          OPS_TABLE_NAME: props.opsTable.tableName,
          // 수집 뒤 깨울 게시 함수 이름(services/src/collectors/trigger.ts)
          PUBLISHER_FUNCTION_NAME: props.publisher.functionName,
        },
      });

      // ③ 실패 때 재실행 설정. 일정(Scheduler)이 함수를 부르는 방식에 적용됨
      // 기본값은 "2번 더 실행, 6시간까지 대기" → 쓸모없는 재실행이 생김(위 ASYNC_RETRIES 설명)
      fn.configureAsyncInvoke({
        retryAttempts: ASYNC_RETRIES, // 0번
        maxEventAge: Duration.seconds(RETRY_LIMITS.asyncMaxEventAgeSeconds), // 10분 넘게 밀린 실행은 버림
      });

      // ④ 권한. AWS에서는 함수가 할 수 있는 일을 하나하나 허락해야 함(허락 안 한 건 전부 거부)
      // 필요한 것만 적음. table.grantReadWriteData() 같은 편한 함수는
      // 전체 조회(Scan)·삭제(DeleteItem) 같은 안 쓰는 권한까지 줘서 쓰지 않음

      // State 테이블: 이전 값 읽기(GetItem), 새 값 쓰기(PutItem)
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
          resources: [props.stateTable.tableArn], // 이 테이블에만
        }),
      );
      // Ops 테이블: "이 시간대는 내가 함" 표시 걸기(PutItem), "끝났음"으로 바꾸기(UpdateItem)
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
          resources: [props.opsTable.tableArn],
        }),
      );
      // publish-snapshot 깨우기(비동기 호출). 그 함수 하나에만
      // grantInvoke 대신 직접 적음: grantInvoke는 함수 버전·별칭 주소(:*)까지 열어 줌
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["lambda:InvokeFunction"],
          resources: [props.publisher.functionArn],
        }),
      );
      // API 키 읽기: SSM Parameter Store(AWS의 비밀값 보관함)에서 이 수집기가 쓰는 키 하나만
      // formatArn: AWS 리소스 주소(ARN)를 만들어 줌
      //   결과 예: arn:aws:ssm:ap-northeast-2:계정번호:parameter/baradun/v2/api-keys/kma-apihub
      // 키 이름 "/baradun/…"의 맨 앞 "/"는 주소의 "parameter/"와 겹쳐 "//"가 되므로 slice(1)로 뺌
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            Stack.of(this).formatArn({
              service: "ssm",
              resource: "parameter",
              resourceName: apiKeyParameterName(c.apiKey).slice(1),
            }),
          ],
        }),
      );

      // ⑤ 실행 일정. EventBridge Scheduler = AWS의 알람 시계. 정한 시각마다 함수를 실행함
      // cron(분 시 일 월 요일 연도) 형식. 분만 정하고 나머지는 "매번"
      // 예: 분 "10,40" → cron(10,40 * * * ? *) = 매일 매시 10분·40분
      new scheduler.Schedule(this, `${c.id}Schedule`, {
        schedule: scheduler.ScheduleExpression.cron({
          // 한국 시각 기준으로 등록. 분은 어느 시간대든 같지만, AWS 콘솔에서 한국 시각으로 보여 확인이 쉬움
          // 하루 1회 수집기(Catalog)는 시(hour)까지 정함 → 한국 시각이어야 맞음
          ...c.cron,
          timeZone: TimeZone.ASIA_SEOUL,
        }),
        // 실행할 대상: ②의 함수
        target: new targets.LambdaInvoke(fn, {
          // 알람 시계가 함수를 깨우는 것 자체가 실패했을 때(AWS 쪽 일시 오류) 다시 시도하는 횟수·기한
          // 수집기가 실패한 경우(③)와는 다른 설정
          retryAttempts: RETRY_LIMITS.scheduleMaxRetries, // 2번
          maxEventAge: Duration.seconds(
            RETRY_LIMITS.scheduleMaxEventAgeSeconds, // 10분
          ),
        }),
        // AWS 콘솔에 보이는 설명 글
        description: c.description,
      });

      this.functions.set(c.id, fn); // 만든 함수를 보관("Ocean" → 함수)
    }
  }
}
