// 테스트 전용 가짜 DynamoDB (운영 API 쓰기·문의 경로 테스트가 함께 씀)
// 여러 테이블을 "테이블|pk|sk" 키로 한 Map에 두고, 조건식은 " AND "로 나눈 칸을 하나씩 평가함
// 트랜잭션은 품목 순서대로 취소 사유를 돌려줌(실제 TransactionCanceledException 모양)

export type Item = Record<string, unknown>;

// 두 테이블(Ops·Inquiry)을 메모리에 두고, 조건식은 " AND "로 나눈 칸을 하나씩 평가함
export class FakeTable {
  readonly items = new Map<string, Item>();
  transactions = 0;

  id(table: string, key: { pk: unknown; sk?: unknown }) {
    return `${table}|${key.pk}|${key.sk ?? ""}`;
  }

  private holds(
    condition: string,
    item: Item | undefined,
    names: Record<string, string>,
    values: Record<string, unknown>,
  ): boolean {
    return condition.split(" AND ").every((part) => {
      const attr = (n: string) => item?.[names[n] ?? n];
      if (part === "attribute_not_exists(pk)") return !item;
      if (part === "attribute_exists(pk)") return !!item;
      const notExists = /^attribute_not_exists\((#\w+)\)$/.exec(part);
      if (notExists) return attr(notExists[1]!) === undefined;
      const [left, op, right] = part.split(" ");
      const a = attr(left!);
      const b = values[right!];
      if (op === "=") return a === b;
      if (op === ">") return typeof a === "number" && a > (b as number);
      throw new Error(`모르는 조건: ${part}`);
    });
  }

  async send(command: { constructor: { name: string }; input: any }) {
    const name = command.constructor.name;
    if (name === "GetCommand") {
      return {
        Item: this.items.get(
          this.id(command.input.TableName, command.input.Key),
        ),
      };
    }
    if (name === "QueryCommand") {
      // 상태 GSI만 흉내 냄: 같은 상태를 접수 시각 내림차순, Limit 적용(이 테스트들은 한 쪽으로 충분)
      const input = command.input;
      const status = input.ExpressionAttributeValues[":s"];
      const items = [...this.items.entries()]
        .filter(
          ([id, item]) =>
            id.startsWith(`${input.TableName}|`) &&
            item.inquiryStatus === status,
        )
        .map(([, item]) => item)
        .sort((a, b) =>
          String(b.receivedAt).localeCompare(String(a.receivedAt)),
        );
      return { Items: items.slice(0, input.Limit) };
    }
    if (name !== "TransactWriteCommand") throw new Error(name);
    this.transactions++;
    const [put, update] = command.input.TransactItems;
    const idemId = this.id(put.Put.TableName, put.Put.Item);
    const targetId = this.id(update.Update.TableName, update.Update.Key);
    const target = this.items.get(targetId);
    const names = update.Update.ExpressionAttributeNames;
    const values = update.Update.ExpressionAttributeValues;
    const codes = [
      this.items.has(idemId) ? "ConditionalCheckFailed" : "None",
      this.holds(update.Update.ConditionExpression, target, names, values)
        ? "None"
        : "ConditionalCheckFailed",
    ];
    if (codes.some((c) => c !== "None")) {
      const error = new Error("canceled") as Error & {
        CancellationReasons: { Code: string }[];
      };
      error.name = "TransactionCanceledException";
      error.CancellationReasons = codes.map((Code) => ({ Code }));
      throw error;
    }
    this.items.set(idemId, put.Put.Item);
    const next: Item = { ...(target ?? update.Update.Key) };
    for (const part of update.Update.UpdateExpression.replace("SET ", "").split(
      ", ",
    )) {
      const [n, v] = part.split(" = ");
      next[names[n]] = values[v];
    }
    this.items.set(targetId, next);
    return {};
  }
}
