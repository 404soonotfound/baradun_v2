import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SAMPLE_CONFIG_KEY } from "./keys";

// 샘플 계정 허용 설정 (D16-A8)
// Ops 테이블 admin#config / sample 항목. 시연 때 사용자가 CLI로 넣고 끝나면 지우거나 기간을 지난 값으로 둠
//   { pk: "admin#config", sk: "sample", subs: ["<sub>"], allowedFrom: "<UTC ISO>", allowedUntil: "<UTC ISO>" }
// 항목이 없거나 형식이 틀리면 null → 샘플 요청은 모두 거부
// 계정 사용 중지·비밀번호 변경만으로는 이미 받은 토큰이 바로 막히지 않으므로 서버가 이 설정으로 다시 막음

export interface SamplePolicy {
  readonly subs: readonly string[];
  readonly allowedFrom: Date;
  readonly allowedUntil: Date;
}

// 시간대(Z 또는 ±hh:mm)가 붙은 ISO 시각만 받음(I09: 시간대 없는 시각을 쓰지 않음)
const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function parseTime(value: unknown): Date | null {
  if (typeof value !== "string" || !ISO_WITH_ZONE.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseSamplePolicy(item: unknown): SamplePolicy | null {
  if (typeof item !== "object" || item === null) return null;
  const { subs, allowedFrom, allowedUntil } = item as Record<string, unknown>;
  if (
    !Array.isArray(subs) ||
    subs.length === 0 ||
    !subs.every((s) => typeof s === "string" && s.length > 0)
  ) {
    return null;
  }
  const from = parseTime(allowedFrom);
  const until = parseTime(allowedUntil);
  if (!from || !until || from.getTime() >= until.getTime()) return null;
  return { subs, allowedFrom: from, allowedUntil: until };
}

export async function readSamplePolicy(
  client: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
): Promise<SamplePolicy | null> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: SAMPLE_CONFIG_KEY,
      // 허용 여부를 바꾼 직후의 요청부터 반영되게 함
      ConsistentRead: true,
    }),
  );
  return parseSamplePolicy(result.Item);
}
