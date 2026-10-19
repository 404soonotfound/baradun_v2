import * as budgets from "aws-cdk-lib/aws-budgets";
import { Construct } from "constructs";
import { MONTHLY_BUDGET_USD } from "../settings";

export interface CostBudgetProps {
  // 알림 받을 이메일. 저장소에 남기지 않으려고 배포할 때 값으로 받아요.
  readonly email: string;
}

// 월 $1 예산 알림 (1장). AWS Budgets는 알림만 보내고 과금을 막지 않아요(11장).
// 예산 2개까지 무료예요.
export class CostBudget extends Construct {
  constructor(scope: Construct, id: string, props: CostBudgetProps) {
    super(scope, id);

    const subscribers = [{ subscriptionType: "EMAIL", address: props.email }];

    new budgets.CfnBudget(this, "Monthly", {
      budget: {
        budgetName: "baradun-v2-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: MONTHLY_BUDGET_USD, unit: "USD" },
        // 크레딧($100)이 비용을 덮으면 실제 사용량이 $0으로 보여요.
        // 크레딧을 빼고 계산해야 "무료 범위를 넘었는지"를 알 수 있어요.
        costTypes: { includeCredit: false },
      },
      notificationsWithSubscribers: [
        // 실제 사용 50%($0.5), 100%($1), 이번 달 예상 100%
        { notificationType: "ACTUAL", threshold: 50 },
        { notificationType: "ACTUAL", threshold: 100 },
        { notificationType: "FORECASTED", threshold: 100 },
      ].map((n) => ({
        notification: {
          ...n,
          comparisonOperator: "GREATER_THAN",
          thresholdType: "PERCENTAGE",
        },
        subscribers,
      })),
    });
  }
}
