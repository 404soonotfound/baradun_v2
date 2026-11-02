#!/usr/bin/env node
// 자격증명 없이 공개 SAR·서울 CFN 스키마와 정책·fixture·합성 템플릿을 대조함.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CFN_LIFECYCLE_HANDLERS,
  MAX_MANAGED_POLICY_CHARS,
  fetchReference,
  managedPolicyChars,
  policyActionErrors,
  referenceActionErrors,
  schemaCoverageErrors,
  toList,
} from "./iam-policy-checks.ts";

const infraDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapDir = join(infraDir, "bootstrap");
const snapshotPath = join(infraDir, "test/fixtures/iam-actions.json");
const schemaUrl =
  "https://schema.cloudformation.ap-northeast-2.amazonaws.com/CloudformationSchema.zip";
const referenceBase = "https://servicereference.us-east-1.amazonaws.com/v1";
const writeSnapshot = process.argv.includes("--write-snapshot");
const updateReference = process.argv.includes("--update-reference");
const checkLatest = process.argv.includes("--check-latest");
const referencePath = join(
  infraDir,
  "test/fixtures/aws-permission-reference.json",
);

// 스키마는 필요한 종류만 한 번에 풀며, ZIP 엔트리 이름은 고정된 CFN 종류에서 만듦.
async function downloadReference(types, initialActions) {
  const archive = await fetchReference(
    schemaUrl,
    (r) => r.arrayBuffer(),
    fetch,
    45000,
  );
  if (archive.error) throw new Error(archive.error);
  const tempDir = mkdtempSync(join(tmpdir(), "baradun-cfn-schemas-"));
  const schemas = {};
  const sources = {};
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  sources[schemaUrl] = hash(Buffer.from(archive.value));
  try {
    const zipPath = join(tempDir, "schemas.zip");
    writeFileSync(zipPath, Buffer.from(archive.value));
    const names = types.map((type) => {
      if (!/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/.test(type))
        throw new Error(`리소스 종류 형식 오류: ${type}`);
      return `${type.toLowerCase().replaceAll("::", "-")}.json`;
    });
    execFileSync("unzip", ["-q", zipPath, ...names, "-d", tempDir], {
      timeout: 15000,
    });
    for (let i = 0; i < types.length; i++) {
      const { typeName, handlers, tagging } = JSON.parse(
        readFileSync(join(tempDir, names[i]), "utf8"),
      );
      schemas[types[i]] = { typeName, handlers, tagging };
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  const schemaPermissions = Object.values(schemas).flatMap((s) =>
    CFN_LIFECYCLE_HANDLERS.flatMap((h) => s.handlers?.[h]?.permissions ?? []),
  );
  const services = [
    ...new Set(
      [...initialActions, ...schemaPermissions]
        .filter((a) => typeof a === "string" && /^[a-z0-9-]+:/.test(a))
        .map((a) => a.split(":")[0]),
    ),
  ].sort();
  const results = await Promise.all(
    services.map(async (service) => {
      const url = `${referenceBase}/${service}/${service}.json`;
      return {
        service,
        url,
        ...(await fetchReference(url, async (r) => {
          const raw = await r.text();
          const spec = JSON.parse(raw);
          if (!Array.isArray(spec.Actions) || !spec.Actions.length)
            throw new Error("Actions 배열이 없는 공식 참조 응답");
          const { Actions, Operations, Resources } = spec;
          return {
            hash: hash(raw),
            reference: {
              Actions: Actions.map(({ Name, Resources, ConditionKeys }) => ({
                Name,
                Resources,
                ConditionKeys,
              })),
              Operations: Operations?.filter((o) =>
                schemaPermissions.some(
                  (p) =>
                    typeof p === "string" &&
                    p.toLowerCase() === `${service}:${o.Name}`.toLowerCase(),
                ),
              ).map(({ Name, AuthorizedActions }) => ({
                Name,
                AuthorizedActions,
              })),
              Resources,
            },
          };
        })),
      };
    }),
  );
  const failed = results.filter((r) => r.error);
  if (failed.length) throw new Error(failed.map((r) => r.error).join("\n"));
  const references = {};
  for (const { service, url, value } of results) {
    references[service] = value.reference;
    sources[url] = value.hash;
  }
  return { schemas, references, sources };
}

async function main() {
  const errors = [];
  const policies = readdirSync(bootstrapDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const raw = readFileSync(join(bootstrapDir, file), "utf8");
      const size = managedPolicyChars(raw);
      console.log(
        `[크기] ${file}: 공백 제외 ${size}자 / ${MAX_MANAGED_POLICY_CHARS}자`,
      );
      if (size > MAX_MANAGED_POLICY_CHARS)
        errors.push(`${file}: 관리형 정책 크기 초과`);
      const doc = JSON.parse(raw);
      errors.push(
        ...policyActionErrors(doc).map((error) => `${file}: ${error}`),
      );
      return { file, statements: toList(doc.Statement) };
    });
  if (!policies.length) throw new Error("bootstrap 정책 파일이 없음");
  const template = JSON.parse(
    readFileSync(join(infraDir, "cdk.out/BaradunV2.template.json"), "utf8"),
  );
  const types = [
    ...new Set(Object.values(template.Resources).map((r) => r.Type)),
  ]
    .filter((t) => t !== "AWS::CDK::Metadata")
    .sort();
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  if (!Array.isArray(snapshot.actions))
    throw new Error("IAM Action 스냅샷 형식 오류");
  const exclusions = JSON.parse(
    readFileSync(
      join(infraDir, "scripts/cfn-permission-exclusions.json"),
      "utf8",
    ),
  );
  const policyRefs = policies.flatMap(({ file, statements }) =>
    statements.flatMap((s) =>
      toList(s.Action).map((action) => ({ file, action })),
    ),
  );
  const refsToCheck = [
    ...policyRefs,
    ...snapshot.actions.map((action) => ({ file: "iam-actions.json", action })),
  ];
  const pinned = updateReference
    ? undefined
    : JSON.parse(readFileSync(referencePath, "utf8"));
  const current =
    updateReference || checkLatest
      ? await downloadReference(
          types,
          refsToCheck.map((r) => r.action),
        )
      : pinned;
  const { schemas, references } = current;
  if (
    checkLatest &&
    JSON.stringify({ schemas, references }) !==
      JSON.stringify({ schemas: pinned.schemas, references: pinned.references })
  ) {
    errors.push(
      "AWS 공식 자료가 고정본과 달라짐. --update-reference 결과와 제외 근거를 검토한 별도 PR 필요",
    );
  }
  errors.push(...referenceActionErrors(refsToCheck, references));
  const execution = policies.filter((p) => p.file.startsWith("cfn-execution"));
  const actionsFor = (effect) =>
    new Set(
      execution.flatMap((p) =>
        p.statements
          .filter((s) => s.Effect === effect)
          .flatMap((s) => toList(s.Action)),
      ),
    );
  errors.push(
    ...schemaCoverageErrors(
      schemas,
      template.Resources,
      references,
      execution
        .flatMap((p) => p.statements)
        .filter((s) => s.Effect === "Allow"),
      actionsFor("Deny"),
      exclusions,
    ),
  );
  if (errors.length) {
    console.error(
      "[실패]\n" + [...new Set(errors)].map((e) => `- ${e}`).join("\n"),
    );
    process.exitCode = 1;
    return;
  }
  if (writeSnapshot) {
    const actions = [...new Set(policyRefs.map((r) => r.action))].sort();
    writeFileSync(
      snapshotPath,
      JSON.stringify(
        {
          verifiedOn: new Date().toISOString().slice(0, 10),
          sourceUrlTemplate: `${referenceBase}/{service}/{service}.json`,
          scope:
            "bootstrap 정책 Action 부분집합; CI에서 고정 AWS 공식 참조로 재검증, 최신 자료는 별도 감사",
          actions,
        },
        null,
        2,
      ) + "\n",
    );
    console.log("[갱신] test/fixtures/iam-actions.json");
  }
  if (updateReference) {
    writeFileSync(
      referencePath,
      JSON.stringify(
        { verifiedOn: new Date().toISOString().slice(0, 10), ...current },
        null,
        2,
      ) + "\n",
    );
    console.log(
      "[갱신] test/fixtures/aws-permission-reference.json (원본 URL·SHA-256 포함)",
    );
  }
  console.log(
    `[통과] 정책 ${policies.length}개·스냅샷·서울 CFN ${types.length}종 CRUD ${updateReference || checkLatest ? "최신" : "고정"} 공식 자료 대조 완료`,
  );
  console.log(
    "[범위] list 핸들러는 스택 CRUD에 쓰지 않아 제외. Budgets는 공개 handlers가 없어 SAR 기반 Vitest 표로 별도 검사. 제외 권한은 cfn-permission-exclusions.json 참조.",
  );
}

try {
  await main();
} catch (error) {
  console.error(
    `[실패] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
