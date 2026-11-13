import { Match } from "aws-cdk-lib/assertions";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { sharpBundlingCommand } from "../lib/inquiry/inquiry-backend";
import { siteDistribution, template } from "./stack-template";

describe("데이터 문의 접수 인프라", () => {
  it("함수 URL을 AWS_IAM과 CloudFront OAC로 잠근다", () => {
    // 문의 + 운영 API(BRD-146). 둘 다 IAM 인증(서명 없는 요청은 Lambda 앞에서 막힘)
    template.resourceCountIs("AWS::Lambda::Url", 2);
    for (const url of Object.values(
      template.findResources("AWS::Lambda::Url"),
    )) {
      expect(url.Properties.AuthType).toBe("AWS_IAM");
    }
    template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: "lambda",
        SigningBehavior: "always",
        SigningProtocol: "sigv4",
      }),
    });

    const permissions = Object.values(
      template.findResources("AWS::Lambda::Permission"),
    ).filter(
      (permission) =>
        permission.Properties.Principal === "cloudfront.amazonaws.com",
    );
    expect(
      permissions.map((permission) => permission.Properties.Action),
    ).toEqual(
      expect.arrayContaining([
        "lambda:InvokeFunctionUrl",
        "lambda:InvokeFunction",
      ]),
    );
    // 문의 함수 2개 + 운영 API 함수 2개(운영자 사이트 /ops/*, BRD-147)
    expect(permissions).toHaveLength(4);
    for (const permission of permissions) {
      expect(permission.Properties.SourceArn).toBeDefined();
      expect(permission.Properties.Principal).not.toBe("*");
    }
    expect(
      permissions.find(
        (permission) =>
          permission.Properties.Action === "lambda:InvokeFunction",
      )?.Properties.InvokedViaFunctionUrl,
    ).toBe(true);
  });

  it("문의 경로에 캐시 없음과 CloudFront Function 선행 검사를 붙인다", () => {
    const behaviors = siteDistribution().Properties.DistributionConfig
      .CacheBehaviors as Array<Record<string, unknown>>;
    const inquiry = behaviors.find(
      (behavior) => behavior.PathPattern === "api/inquiries*",
    );
    expect(inquiry).toMatchObject({
      PathPattern: "api/inquiries*",
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: [
        "GET",
        "HEAD",
        "OPTIONS",
        "PUT",
        "PATCH",
        "POST",
        "DELETE",
      ],
    });
    expect(inquiry?.FunctionAssociations).toEqual([
      expect.objectContaining({ EventType: "viewer-request" }),
    ]);

    const functions = Object.values(
      template.findResources("AWS::CloudFront::Function"),
    );
    const code = functions
      .map((resource) => String(resource.Properties.FunctionCode))
      .find((value) => value.includes("x-amz-content-sha256"));
    expect(code).toContain("content-length");
    expect(code).toContain("32768");
  });

  it("오리진 요청 정책은 관리형 AllViewerExceptHostHeader를 쓴다 (x-amz-*는 allowlist 금지)", () => {
    // 직접 만든 정책이 없어야 함: content-length·x-amz-content-sha256은 CloudFront가
    // allowlist에 못 넣게 하는 헤더라 정책 생성이 거부됨(2026-10-26 실배포 오류)
    template.resourceCountIs("AWS::CloudFront::OriginRequestPolicy", 0);
    const behaviors = siteDistribution().Properties.DistributionConfig
      .CacheBehaviors as Array<Record<string, unknown>>;
    const inquiry = behaviors.find(
      (behavior) => behavior.PathPattern === "api/inquiries*",
    );
    // 관리형 Managed-AllViewerExceptHostHeader의 고정 id
    expect(inquiry?.OriginRequestPolicyId).toBe(
      "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    );
  });

  it("사진 버킷은 비공개이고 30일 뒤 삭제한다", () => {
    const buckets = Object.values(template.findResources("AWS::S3::Bucket"));
    const photos = buckets.find(
      (bucket) => bucket.Properties.CorsConfiguration !== undefined,
    );
    expect(photos?.Properties).toMatchObject({
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      LifecycleConfiguration: {
        Rules: [{ ExpirationInDays: 30, Status: "Enabled" }],
      },
    });
  });

  it("메일 주제 하나와 이메일 구독 하나를 만든다", () => {
    // 스택에는 운영 경보 주제(BRD-62)도 있으므로 문의 주제만 골라 셈
    const topics = Object.entries(
      template.findResources("AWS::SNS::Topic"),
    ).filter(([id]) => id.startsWith("InquiryTopic")); // 논리 ID가 InquiryTopic…인 것만
    expect(topics).toHaveLength(1);
    const [topicId] = topics[0]!; // [논리 ID, 리소스] 중 논리 ID만 꺼냄

    // 그 주제에 붙은 구독만 셈
    const subs = Object.values(
      template.findResources("AWS::SNS::Subscription"),
    ).filter((s) => s.Properties.TopicArn?.Ref === topicId);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.Properties).toMatchObject({
      Protocol: "email",
      Endpoint: { Ref: "AlertEmail" },
    });
  });

  it("새 계정 한도 때문에 예약 동시 실행을 설정하지 않는다", () => {
    const functions = Object.values(
      template.findResources("AWS::Lambda::Function"),
    );
    const inquiry = functions.find((resource) =>
      String(resource.Properties.Description).includes("data inquiry"),
    );
    expect(inquiry).toBeDefined();
    expect(inquiry?.Properties.ReservedConcurrentExecutions).toBeUndefined();
  });

  it("웹 빌드가 업로드 주소를 맞춰 볼 사진 버킷 이름을 출력한다(BRD-103)", () => {
    const output = Object.values(
      template.findOutputs("InquiryPhotoBucketName"),
    );
    expect(output).toHaveLength(1);
    const buckets = Object.keys(
      template.findResources("AWS::S3::Bucket"),
    ).filter((id) => id.startsWith("InquiryPhotos"));
    expect(buckets).toHaveLength(1);
    expect(output[0]?.Value).toEqual({ Ref: buckets[0] });
  });

  it("문의 함수 번들 후처리 명령이 sharp와 WASM 폴백 런타임을 자산 디렉터리에 복사한다(BRD-116)", () => {
    const repoRoot = path.join(__dirname, "..", "..");
    const outputDir = mkdtempSync(
      path.join(os.tmpdir(), "baradun-inquiry-sharp-"),
    );
    try {
      const cmd = sharpBundlingCommand(repoRoot, outputDir);
      execFileSync("bash", ["-c", cmd], { stdio: "pipe" });
      for (const pkg of [
        "sharp",
        "detect-libc",
        "@emnapi/runtime",
        "tslib",
        "@img/colour",
        "@img/sharp-wasm32",
      ]) {
        expect(
          existsSync(path.join(outputDir, "node_modules", pkg, "package.json")),
          pkg,
        ).toBe(true);
      }
      // 저장소 밖 독립 디렉터리(outputDir)만으로 모든 전이 의존성 해석과 WASM 폴백 로딩이 동작하는지 검증함
      expect(() =>
        execFileSync(
          "node",
          [
            "-e",
            [
              "const fs = require('node:fs');",
              "const path = require('node:path');",
              "const { createRequire } = require('node:module');",
              "const root = fs.realpathSync(process.cwd());",
              "const req = createRequire(path.join(root, 'index.js'));",
              "const pkgs = ['sharp', 'detect-libc', '@emnapi/runtime', 'tslib', '@img/colour', '@img/sharp-wasm32'];",
              "for (const pkg of pkgs) {",
              "  const pkgDir = path.join(root, 'node_modules', pkg);",
              "  const meta = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));",
              "  for (const dep of Object.keys(meta.dependencies || {})) {",
              "    const resolved = fs.realpathSync(req.resolve(dep, { paths: [pkgDir] }));",
              "    if (!resolved.startsWith(root)) throw new Error('Escaped bundle root: ' + dep + ' -> ' + resolved);",
              "  }",
              "}",
              "req('@img/sharp-wasm32/sharp.node');",
              "const sharp = req('sharp');",
              "sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } } })",
              "  .png()",
              "  .toBuffer()",
              "  .then((b) => { if (b.length < 1) process.exit(1); });",
            ].join(" "),
          ],
          { cwd: outputDir, stdio: "pipe" },
        ),
      ).not.toThrow();
      const emptyDir = mkdtempSync(
        path.join(os.tmpdir(), "baradun-inquiry-empty-"),
      );
      try {
        expect(() =>
          execFileSync(
            "bash",
            ["-c", sharpBundlingCommand(emptyDir, outputDir)],
            { stdio: "pipe" },
          ),
        ).toThrow(/Missing sharp runtime package: sharp/);
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

// 이메일·사진 받기 설정(결정 기록 13장 D13-2, BRD-130). 두 값은 서로 다른 패키지(services·apps/web)에 있고 서로 가져오지 않음(17.2 경계)
// → 인프라 테스트가 두 파일을 글자로 읽어 비교함. 화면은 칸을 숨겼는데 서버가 받거나, 그 반대가 되지 않게 함
describe("문의 이메일·사진 받기 설정 (BRD-130)", () => {
  const REPO_ROOT = path.join(__dirname, "..", "..");
  const read = (file: string): string => {
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
    const match = /export const INQUIRY_CONTACT_ENABLED = (true|false);/.exec(
      text,
    );
    expect(
      match,
      `${file}에서 INQUIRY_CONTACT_ENABLED를 찾지 못함`,
    ).not.toBeNull();
    return match![1]!;
  };

  it("화면과 서버의 값이 같다", () => {
    expect(read("apps/web/src/lib/inquiry/form.ts")).toBe(
      read("services/src/inquiry/policy.ts"),
    );
  });
});

describe("문의 이메일 일일 정리 일정 (BRD-119)", () => {
  it("하루 1회 KST 03:30에 cleanup_expired_emails 동작으로 문의 함수를 호출한다", () => {
    const schedules = Object.entries(
      template.findResources("AWS::Scheduler::Schedule"),
    ).filter(([id]) => id.startsWith("InquiryEmailCleanupSchedule"));
    expect(schedules).toHaveLength(1);
    const props = schedules[0]![1].Properties as {
      ScheduleExpression: string;
      ScheduleExpressionTimezone: string;
      Target: {
        Input: string;
        Arn: { "Fn::GetAtt": [string, string] };
        DeadLetterConfig?: { Arn: { "Fn::GetAtt": [string, string] } };
      };
    };
    expect(props.ScheduleExpression).toBe("cron(30 3 * * ? *)");
    expect(props.ScheduleExpressionTimezone).toBe("Asia/Seoul");
    expect(JSON.parse(props.Target.Input)).toEqual({
      action: "cleanup_expired_emails",
    });
    expect(props.Target.Arn["Fn::GetAtt"][0]).toMatch(/^InquiryFunction/);
    expect(props.Target.DeadLetterConfig?.Arn["Fn::GetAtt"][0]).toMatch(
      /^InquiryEmailCleanupFailures/,
    );
  });
});
