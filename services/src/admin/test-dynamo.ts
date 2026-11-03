// 테스트 전용 가짜 DynamoDB (운영 API 쓰기·문의 경로 테스트가 함께 씀)
// 여러 테이블을 "테이블|pk|sk" 키로 한 Map에 두고, 조건식은 " AND "로 나눈 칸을 하나씩 평가함
// 트랜잭션은 품목 순서대로 취소 사유를 돌려줌(실제 TransactionCanceledException 모양)

export type Item = Record<string, unknown>;

// 두 테이블(Ops·Inquiry)을 메모리에 두고, 조건식은 " AND "로 나눈 칸을 하나씩 평가함
export class FakeTable {
  readonly items = new Map<string, Item>();
  transactions = 0;
  puts = 0;

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
    if (name === "PutCommand") {
      const input = command.input;
      const id = this.id(input.TableName, input.Item);
      if (input.ConditionExpression === "attribute_not_exists(pk)") {
        if (this.items.has(id)) {
          const error = new Error("exists");
          error.name = "ConditionalCheckFailedException";
          throw error;
        }
      } else if (input.ConditionExpression !== undefined) {
        throw new Error(`모르는 조건: ${input.ConditionExpression}`);
      }
      this.puts++;
      this.items.set(id, input.Item);
      return {};
    }
    if (name === "QueryCommand") {
      const input = command.input;
      if (input.IndexName === undefined) return this.queryAudit(input);
      // 상태 GSI만 흉내 냄: 같은 상태를 접수 시각 내림차순, Limit 적용(이 테스트들은 한 쪽으로 충분)
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
    // 품목마다 조건을 먼저 모두 보고, 하나라도 실패하면 아무것도 쓰지 않음
    const steps = command.input.TransactItems.map((entry: any) => {
      if (entry.Put) {
        const id = this.id(entry.Put.TableName, entry.Put.Item);
        if (entry.Put.ConditionExpression !== "attribute_not_exists(pk)") {
          throw new Error(`모르는 조건: ${entry.Put.ConditionExpression}`);
        }
        return {
          ok: !this.items.has(id),
          apply: () => this.items.set(id, entry.Put.Item),
        };
      }
      const update = entry.Update;
      const id = this.id(update.TableName, update.Key);
      const target = this.items.get(id);
      const names = update.ExpressionAttributeNames;
      const values = update.ExpressionAttributeValues;
      return {
        ok: this.holds(update.ConditionExpression, target, names, values),
        apply: () => {
          const next: Item = { ...(target ?? update.Key) };
          for (const part of update.UpdateExpression.replace("SET ", "").split(
            ", ",
          )) {
            const [n, v] = part.split(" = ");
            next[names[n]] = values[v];
          }
          this.items.set(id, next);
        },
      };
    });
    const codes = steps.map((step: { ok: boolean }) =>
      step.ok ? "None" : "ConditionalCheckFailed",
    );
    if (codes.some((c: string) => c !== "None")) {
      const error = new Error("canceled") as Error & {
        CancellationReasons: { Code: string }[];
      };
      error.name = "TransactionCanceledException";
      error.CancellationReasons = codes.map((Code: string) => ({ Code }));
      throw error;
    }
    steps.forEach((step: { apply: () => void }) => step.apply());
    return {};
  }

  // 감사 기록 Query: pk 같음 + sk BETWEEN, 내림차순, 필터, Limit·ExclusiveStartKey 적용
  private queryAudit(input: any) {
    const values = input.ExpressionAttributeValues;
    const names = input.ExpressionAttributeNames ?? {};
    const sorted = [...this.items.entries()]
      .filter(
        ([id, item]) =>
          id.startsWith(`${input.TableName}|`) &&
          item.pk === values[":pk"] &&
          String(item.sk) >= values[":from"] &&
          String(item.sk) <= values[":to"],
      )
      .map(([, item]) => item)
      .sort((a, b) => String(b.sk).localeCompare(String(a.sk)));
    const start = input.ExclusiveStartKey
      ? sorted.findIndex((i) => i.sk === input.ExclusiveStartKey.sk) + 1
      : 0;
    const evaluated = sorted.slice(start, start + input.Limit);
    const matches = (item: Item) =>
      input.FilterExpression === undefined ||
      this.holds(input.FilterExpression, item, names, values);
    const last = evaluated.at(-1);
    return {
      Items: evaluated.filter(matches),
      ...(start + input.Limit < sorted.length && last
        ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } }
        : {}),
    };
  }
}
