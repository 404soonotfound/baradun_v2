import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import {
  INQUIRY_STATUS_INDEX,
  TABLE_CAPACITY,
  TTL_ATTRIBUTE,
} from "../settings";

// 7장 저장소 테이블 3개 (BRD-55)
// - State: 출처별 최신 사실, 지표별 마지막 정상값, 특보 정상 확인 스냅샷, 최근 시도 상태
// - Ops: 슬롯 완료 기록(멱등), 실행·게시 잠금, 게시 버전
// - Inquiry: 데이터 문의 (쓰는 코드는 BRD-63)
//
// 공통 설정
// - `Table`(CloudFormation AWS::DynamoDB::Table)을 씀. `TableV2`는 AWS::DynamoDB::GlobalTable을 만듦 → 가드레일 위반
// - 이름은 지정하지 않음 → CDK가 "BaradunV2-StateTable…" 같은 이름을 붙임. Lambda는 환경 변수로 받음
// - billingMode PROVISIONED + 고정 용량. autoScale*을 부르지 않음 → Auto Scaling 없음
// - encryption DEFAULT = AWS 소유 키(무료). 템플릿에는 SSEEnabled: false로 나옴
// - 지정 시점 복구(PITR)는 끔(백업 요금). 명시해서 기본값이 바뀌어도 그대로 유지
// - removalPolicy는 CDK 기본값(RETAIN) → 스택을 지우거나 테이블이 교체돼도 데이터는 남음
export class StorageTables extends Construct {
  readonly state: dynamodb.Table;
  readonly ops: dynamodb.Table;
  readonly inquiry: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const common = {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      encryption: dynamodb.TableEncryption.DEFAULT,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
    } as const;

    // TTL 없음: 사실·마지막 정상값은 지우지 않음
    this.state = new dynamodb.Table(this, "StateTable", {
      ...common,
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      readCapacity: TABLE_CAPACITY.state.read,
      writeCapacity: TABLE_CAPACITY.state.write,
    });

    // timeToLiveAttribute: 이 속성(초 단위 epoch 숫자)이 지난 항목을 DynamoDB가 나중에 지움
    // 삭제는 보통 며칠 안에 일어나고 정확한 시각을 보장하지 않음 → 판단에 쓰지 않음
    this.ops = new dynamodb.Table(this, "OpsTable", {
      ...common,
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      readCapacity: TABLE_CAPACITY.ops.read,
      writeCapacity: TABLE_CAPACITY.ops.write,
      timeToLiveAttribute: TTL_ATTRIBUTE,
    });

    // 키 pk만. 문의 글은 90일 뒤 TTL로 정리 (값은 BRD-63에서 씀)
    this.inquiry = new dynamodb.Table(this, "InquiryTable", {
      ...common,
      readCapacity: TABLE_CAPACITY.inquiry.read,
      writeCapacity: TABLE_CAPACITY.inquiry.write,
      timeToLiveAttribute: TTL_ATTRIBUTE,
    });
    // 운영자 화면 문의 목록: 상태 + 접수 시각 GSI(D16-B4, BRD-153)
    // 문의 항목에만 inquiryStatus가 있어 다른 항목(멱등·속도 제한·이메일)은 들어가지 않음
    // 요약 칸만 projection. 본문(message)·이메일·사진 키는 넣지 않음
    this.inquiry.addGlobalSecondaryIndex({
      indexName: INQUIRY_STATUS_INDEX.name,
      partitionKey: {
        name: "inquiryStatus",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: "receivedAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [...INQUIRY_STATUS_INDEX.projected],
      readCapacity: INQUIRY_STATUS_INDEX.read,
      writeCapacity: INQUIRY_STATUS_INDEX.write,
    });
  }
}
