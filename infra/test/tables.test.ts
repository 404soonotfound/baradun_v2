import { describe, expect, it } from "vitest";
import {
  MAX_DYNAMODB_CAPACITY_UNITS,
  TABLE_CAPACITY,
  TTL_ATTRIBUTE,
} from "../lib/settings";
import { template } from "./stack-template";

// 7장 저장소 테이블 3개 (BRD-55)

type TableResource = {
  Properties: Record<string, any>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
};

// 논리 ID 앞부분(StorageStateTable…)으로 테이블 하나를 찾음
function table(name: "State" | "Ops" | "Inquiry"): TableResource {
  const found = Object.entries(
    template.findResources("AWS::DynamoDB::Table"),
  ).filter(([id]) => id.startsWith(`Storage${name}Table`));
  expect(found).toHaveLength(1);
  return found[0]![1] as TableResource;
}

describe("DynamoDB 테이블", () => {
  it("테이블은 State·Ops·Inquiry 3개이고 GlobalTable은 없다", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", 3);
    template.resourceCountIs("AWS::DynamoDB::GlobalTable", 0);
  });

  it("State·Ops 키는 pk+sk(문자열), Inquiry 키는 pk만이다", () => {
    for (const name of ["State", "Ops"] as const) {
      const p = table(name).Properties;
      expect(p.KeySchema).toEqual([
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ]);
      expect(p.AttributeDefinitions).toEqual([
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ]);
    }
    const inquiry = table("Inquiry").Properties;
    expect(inquiry.KeySchema).toEqual([
      { AttributeName: "pk", KeyType: "HASH" },
    ]);
    expect(inquiry.AttributeDefinitions).toEqual([
      { AttributeName: "pk", AttributeType: "S" },
    ]);
  });

  it("용량은 settings 값이고 합계 11/11은 상한 안이다", () => {
    expect(table("State").Properties.ProvisionedThroughput).toEqual({
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5,
    });
    expect(table("Ops").Properties.ProvisionedThroughput).toEqual({
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5,
    });
    expect(table("Inquiry").Properties.ProvisionedThroughput).toEqual({
      ReadCapacityUnits: 1,
      WriteCapacityUnits: 1,
    });

    const all = Object.values(TABLE_CAPACITY);
    const read = all.reduce((sum, c) => sum + c.read, 0);
    const write = all.reduce((sum, c) => sum + c.write, 0);
    expect([read, write]).toEqual([11, 11]);
    expect(read).toBeLessThanOrEqual(MAX_DYNAMODB_CAPACITY_UNITS);
    expect(write).toBeLessThanOrEqual(MAX_DYNAMODB_CAPACITY_UNITS);
  });

  it("GSI·Auto Scaling이 없다", () => {
    for (const name of ["State", "Ops", "Inquiry"] as const) {
      expect(table(name).Properties.GlobalSecondaryIndexes).toBeUndefined();
    }
    template.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", 0);
  });

  it("TTL은 Ops·Inquiry에만 있고 속성 이름은 ttl이다", () => {
    expect(TTL_ATTRIBUTE).toBe("ttl");
    expect(table("State").Properties.TimeToLiveSpecification).toBeUndefined();
    for (const name of ["Ops", "Inquiry"] as const) {
      expect(table(name).Properties.TimeToLiveSpecification).toEqual({
        AttributeName: "ttl",
        Enabled: true,
      });
    }
  });

  it("지정 시점 복구(PITR)는 꺼져 있고, 암호화는 AWS 소유 키다", () => {
    for (const name of ["State", "Ops", "Inquiry"] as const) {
      const p = table(name).Properties;
      expect(p.PointInTimeRecoverySpecification).toEqual({
        PointInTimeRecoveryEnabled: false,
      });
      // SSEEnabled false = AWS 소유 키(무료). true면 AWS 관리형 KMS 키(요청당 KMS 요금)
      expect(p.SSESpecification).toEqual({ SSEEnabled: false });
    }
  });

  it("이름을 지정하지 않고, 스택을 지워도 테이블은 남긴다", () => {
    for (const name of ["State", "Ops", "Inquiry"] as const) {
      const t = table(name);
      expect(t.Properties.TableName).toBeUndefined();
      expect(t.DeletionPolicy).toBe("Retain");
      expect(t.UpdateReplacePolicy).toBe("Retain");
    }
  });

  it("테이블 이름을 출력한다", () => {
    for (const name of ["State", "Ops", "Inquiry"] as const) {
      const output = template.findOutputs(`${name}TableName`);
      expect(Object.keys(output)).toHaveLength(1);
    }
  });
});
