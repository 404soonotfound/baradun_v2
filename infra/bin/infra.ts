#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { BaradunStack } from "../lib/baradun-stack";

const app = new App();

new BaradunStack(app, "BaradunV2", {
  // 리전은 서울 고정 (E5). 계정은 배포할 때 로그인 정보에서 읽어요.
  // 계정 없이 cdk synth를 해도 동작해요 (계정 자리만 비워 둔 템플릿).
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-northeast-2" },
});
