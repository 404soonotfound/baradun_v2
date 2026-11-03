// 기존 문의 처리 상태 이전 실행기 (BRD-153). 사용자가 관리자 자격 증명으로 직접 실행함
//   npx --no-install tsx services/scripts/inquiry-status-backfill.ts --table <InquiryTableName> --dry-run
//   npx --no-install tsx services/scripts/inquiry-status-backfill.ts --table <InquiryTableName> --apply
//   npx --no-install tsx services/scripts/inquiry-status-backfill.ts --table <InquiryTableName> --verify
// 문의 본문·이메일은 읽지도 출력하지도 않음(개수만 출력)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  backfillInquiryStatus,
  verifyInquiryIndex,
} from "../src/admin/inquiry-backfill";

const REGION = "ap-northeast-2";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const table = arg("--table");
  const modes = ["--dry-run", "--apply", "--verify"].filter((m) =>
    process.argv.includes(m),
  );
  if (!table || !table.startsWith("BaradunV2-") || modes.length !== 1) {
    throw new Error(
      "사용법: --table <BaradunV2-…Inquiry 테이블> 과 --dry-run·--apply·--verify 중 하나",
    );
  }
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: REGION }),
  );
  const now = new Date();
  if (modes[0] === "--verify") {
    console.log(
      JSON.stringify(await verifyInquiryIndex(client, table, now), null, 2),
    );
    return;
  }
  const report = await backfillInquiryStatus(client, table, {
    apply: modes[0] === "--apply",
    now,
  });
  console.log(JSON.stringify({ mode: modes[0], ...report }, null, 2));
}

main().catch((error: unknown) => {
  console.error(
    `[실패] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
