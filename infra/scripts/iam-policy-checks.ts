export const MAX_MANAGED_POLICY_CHARS = 6144;
export const CFN_LIFECYCLE_HANDLERS = [
  "create",
  "read",
  "update",
  "delete",
] as const;

export function managedPolicyChars(raw: string): number {
  return raw.replace(/\s+/g, "").length;
}

export function toList<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

export type PolicyStatement = {
  Effect?: string;
  Action?: string | string[];
  NotAction?: unknown;
  Sid?: string;
  Resource?: string | string[];
  Condition?: Record<string, Record<string, unknown>>;
};
export type PolicyDocument = {
  Statement?: PolicyStatement | PolicyStatement[];
};

const PASS_ROLE_SERVICE_BY_TYPE: Readonly<Record<string, string>> = {
  "AWS::Lambda::Function": "lambda.amazonaws.com",
  "AWS::Scheduler::Schedule": "scheduler.amazonaws.com",
};
const ALLOWED_PASS_ROLE_SERVICES = new Set(
  Object.values(PASS_ROLE_SERVICE_BY_TYPE),
);

export function policyActionErrors(doc: PolicyDocument): string[] {
  const errors: string[] = [];
  const statements = toList(doc.Statement);
  if (!statements.length) errors.push("Statement가 비어 있음");
  for (const statement of statements) {
    if (statement.NotAction !== undefined)
      errors.push("NotAction은 허용하지 않음");
    const actions = toList(statement.Action);
    if (!actions.length) errors.push("Action이 비어 있음");
    for (const action of actions) {
      if (
        typeof action !== "string" ||
        !/^[a-z0-9-]+:[A-Za-z0-9]+$/.test(action)
      ) {
        errors.push(`잘못된 Action 또는 와일드카드: ${action}`);
      }
    }
  }
  return errors;
}

export type ServiceReference = {
  Actions: {
    Name: string;
    Resources?: { Name: string }[];
    ConditionKeys?: string[];
  }[];
  Resources?: {
    Name: string;
    ARNFormats: string[];
    ConditionKeys?: string[];
  }[];
  Operations?: {
    Name: string;
    AuthorizedActions?: { Service: string; Name: string }[];
  }[];
};

export function referenceActionErrors(
  entries: { file: string; action: unknown }[],
  refs: Record<string, ServiceReference>,
): string[] {
  const errors: string[] = [];
  for (const { file, action } of entries) {
    if (
      typeof action !== "string" ||
      !/^[a-z0-9-]+:[A-Za-z0-9]+$/.test(action)
    ) {
      errors.push(`${file}: 잘못된 Action 형식 ${action}`);
      continue;
    }
    const [service, name] = action.split(":");
    if (!refs[service]) {
      errors.push(`${file}: ${service} 공식 참조를 받지 못해 검증 불가`);
    } else if (!refs[service].Actions.some((a) => a.Name === name)) {
      errors.push(`${file}: 공식 IAM Action이 아님: ${action}`);
    }
  }
  return errors;
}

// IAM Action으로 존재하는 이름을 우선하고, 아니면 공식 API→IAM 매핑을 사용함.
// 스키마의 오래된 API 철자 차이는 대소문자를 무시해 맞추되, 추측한 별칭은 만들지 않음.
export function resolveSchemaPermission(
  permission: string,
  refs: Record<string, ServiceReference>,
): string[] | undefined {
  if (
    typeof permission !== "string" ||
    !/^[a-z0-9-]+:[A-Za-z0-9.]+$/.test(permission)
  )
    return undefined;
  const [service, name] = permission.split(":");
  const ref = refs[service];
  const action = ref?.Actions.find(
    (a) => a.Name.toLowerCase() === name.toLowerCase(),
  );
  if (action) return [`${service}:${action.Name}`];
  const operation = ref?.Operations?.find(
    (o) => o.Name.toLowerCase() === name.toLowerCase(),
  );
  const mapped = operation?.AuthorizedActions;
  return mapped?.length
    ? mapped.map((a) => `${a.Service}:${a.Name}`)
    : undefined;
}

export async function fetchReference<T>(
  url: string,
  parse: (response: Response) => Promise<T>,
  fetcher: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<{ value?: T; error?: string }> {
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { value: await parse(response) };
  } catch (error) {
    return {
      error: `${url}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type SchemaExclusion = {
  permissions: string[];
  reason?: string;
  absentProperties?: string[];
  denied?: boolean;
  notInReference?: boolean;
};
export type SchemaExclusions = Record<string, SchemaExclusion[]>;
export type CfnResource = {
  Type: string;
  Properties?: Record<string, unknown>;
};
export type CfnSchema = {
  typeName: string;
  handlers?: Record<string, { permissions?: string[] }>;
  tagging?: {
    taggable?: boolean;
    tagOnCreate?: boolean;
    tagUpdatable?: boolean;
    cloudFormationSystemTags?: boolean;
  };
};

export function arnMatches(pattern: string, arn: string): boolean {
  return new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  ).test(arn);
}

// IAM 시뮬레이터가 아님. SAR 리소스 종류와 명시적으로 검토한 조건만 인정함.
// 새 조건·리소스 종류는 조용히 허용하지 않고 근거 보완 전 실패시킴.
export function statementScopeErrors(
  statement: PolicyStatement,
  action: string,
  type: string,
  schema: CfnSchema,
  resources: Record<string, CfnResource>,
  refs: Record<string, ServiceReference>,
): string[] {
  const errors: string[] = [];
  const [service, name] = action.split(":");
  const ref = refs[service];
  const definition = ref?.Actions.find((a) => a.Name === name);
  const resourceDefinitions = (definition?.Resources ?? []).flatMap(
    (r) => ref?.Resources?.filter((entry) => entry.Name === r.Name) ?? [],
  );
  const arns = toList(statement.Resource);
  if (
    !arns.length ||
    !arns.some(
      (arn) =>
        arn === "*" ||
        resourceDefinitions.some((r) =>
          r.ARNFormats.some((format) =>
            arnMatches(format.replace(/\$\{[^}]+\}/g, "*"), arn),
          ),
        ),
    )
  ) {
    errors.push("SAR 리소스 종류에 맞는 Resource가 없음");
  }
  for (const [operator, conditions] of Object.entries(
    statement.Condition ?? {},
  )) {
    for (const [key, value] of Object.entries(conditions)) {
      if (operator !== "StringEquals") {
        errors.push(`미검토 조건 연산자 ${operator}/${key}`);
        continue;
      }
      const values = toList(value);
      if (key === "aws:RequestedRegion") {
        if (
          // 리소스 수준 권한이 없는 생성·조회 작업만 서울 리전 조건으로 Resource *를 씀
          ![
            "AWS::Logs::LogGroup",
            "AWS::CloudWatch::Alarm",
            "AWS::Cognito::UserPool",
          ].includes(type) ||
          values.length !== 1 ||
          value !== "ap-northeast-2"
        )
          errors.push(`리전 조건의 리소스별 근거 없음: ${key}`);
      } else if (key === "iam:PassedToService") {
        const target = PASS_ROLE_SERVICE_BY_TYPE[type];
        const onlyAllowedServices = values.every(
          (service) =>
            typeof service === "string" &&
            ALLOWED_PASS_ROLE_SERVICES.has(service),
        );
        const hasTargetService = values.some((service) => service === target);
        if (!onlyAllowedServices)
          errors.push(
            `허용 목록 밖 PassRole 서비스: ${values
              .filter(
                (v) =>
                  typeof v !== "string" || !ALLOWED_PASS_ROLE_SERVICES.has(v),
              )
              .map(String)
              .join(", ")}`,
          );
        else if (action !== "iam:PassRole" || !target || !hasTargetService)
          errors.push(`해당 리소스에 맞는 PassRole 서비스가 없음: ${type}`);
      } else if (key === "iam:PermissionsBoundary") {
        const roles = Object.values(resources).filter(
          (r) => r.Type === "AWS::IAM::Role",
        );
        if (
          !["AWS::IAM::Role", "AWS::IAM::Policy"].includes(type) ||
          value !==
            "arn:aws:iam::${aws:PrincipalAccount}:policy/BaradunV2-RoleBoundary" ||
          !roles.length ||
          roles.some(
            (r) =>
              !JSON.stringify(r.Properties?.PermissionsBoundary)?.includes(
                "BaradunV2-RoleBoundary",
              ),
          )
        )
          errors.push("역할 boundary 조건의 템플릿 근거 없음");
      } else if (
        key.startsWith("aws:ResourceTag/") ||
        key.startsWith("aws:RequestTag/")
      ) {
        const tagKey = key.slice(key.indexOf("/") + 1);
        if (
          tagKey.startsWith("aws:cloudformation:") &&
          schema.tagging?.cloudFormationSystemTags === false
        ) {
          errors.push(
            "cloudFormationSystemTags=false인 종류에 예약 태그 조건 사용",
          );
          continue;
        }
        const supported = [
          ...(definition?.ConditionKeys ?? []),
          ...resourceDefinitions.flatMap((r) => r.ConditionKeys ?? []),
        ];
        if (
          !supported.some(
            (k) => k === key || k.replace("${TagKey}", tagKey) === key,
          )
        )
          errors.push(`SAR가 지원하지 않는 태그 조건 ${key}`);
        const instances = Object.values(resources).filter(
          (r) => r.Type === type,
        );
        if (
          schema.tagging?.taggable === false ||
          (key.startsWith("aws:RequestTag/") &&
            schema.tagging?.tagOnCreate === false) ||
          !instances.length ||
          instances.some(
            (r) =>
              !Array.isArray(r.Properties?.Tags) ||
              !r.Properties.Tags.some(
                (t: { Key?: string; Value?: unknown }) =>
                  t.Key === tagKey && t.Value === value,
              ),
          )
        )
          errors.push(`템플릿·스키마에 태그 조건 근거 없음: ${key}`);
      } else {
        errors.push(`리소스별 근거가 없는 조건 ${key}`);
      }
    }
  }
  return errors;
}

function hasProperty(value: unknown, path: string[]): boolean {
  if (!path.length) return value !== undefined;
  if (Array.isArray(value))
    return value.some((item) => hasProperty(item, path));
  if (!value || typeof value !== "object") return false;
  // 조건부 설정도 미사용으로 보지 않음. Fn::If의 양쪽 분기를 검사함.
  const record = value as Record<string, unknown>;
  if ("Fn::If" in record && Array.isArray(record["Fn::If"])) {
    return record["Fn::If"]
      .slice(1)
      .some((branch) => hasProperty(branch, path));
  }
  return hasProperty(record[path[0]], path.slice(1));
}

export function excludedPropertyErrors(
  resources: Record<string, CfnResource>,
  exclusions: SchemaExclusions,
): string[] {
  const errors: string[] = [];
  for (const [id, resource] of Object.entries(resources)) {
    for (const exclusion of exclusions[resource.Type] ?? []) {
      if (typeof exclusion.reason !== "string" || !exclusion.reason.trim())
        errors.push(`${resource.Type}: 제외 근거가 없음`);
      if (
        !exclusion.absentProperties?.length &&
        !exclusion.denied &&
        !exclusion.notInReference
      )
        errors.push(`${resource.Type}: 무조건 제외는 허용하지 않음`);
      for (const path of exclusion.absentProperties ?? []) {
        if (hasProperty(resource.Properties, path.split("/"))) {
          errors.push(
            `${id}: ${path} 사용 중. 제외 권한 재검토 필요: ${exclusion.reason}`,
          );
        }
      }
    }
  }
  return [...new Set(errors)];
}

export function schemaCoverageErrors(
  schemas: Record<string, CfnSchema>,
  resources: Record<string, CfnResource>,
  refs: Record<string, ServiceReference>,
  allowed: PolicyStatement[],
  denied: Set<string>,
  exclusions: SchemaExclusions,
): string[] {
  const errors = excludedPropertyErrors(resources, exclusions);
  for (const [type, entries] of Object.entries(exclusions)) {
    for (const entry of entries.filter((e) => e.notInReference)) {
      for (const permission of entry.permissions) {
        if (!refs[permission.split(":")[0]])
          errors.push(
            `${type}: 참조가 없어 notInReference 검증 불가: ${permission}`,
          );
        else {
          const [service, name] = permission.split(":");
          if (
            refs[service].Actions.some(
              (a) => a.Name.toLowerCase() === name?.toLowerCase(),
            ) ||
            refs[service].Operations?.some(
              (o) => o.Name.toLowerCase() === name?.toLowerCase(),
            )
          )
            errors.push(
              `${type}: 공식 참조에 등장한 제외 권한 재검토 필요: ${permission}`,
            );
        }
      }
    }
  }
  for (const type of new Set(Object.values(resources).map((r) => r.Type))) {
    if (type === "AWS::CDK::Metadata") continue;
    const schema = schemas[type];
    if (!schema || schema.typeName !== type) {
      errors.push(`${type}: 공개 스키마가 없음`);
      continue;
    }
    // Budgets는 공개 스키마에 handlers가 없음. 공식 SAR에 근거한 표로 별도 검사함.
    if (!schema.handlers && type === "AWS::Budgets::Budget") continue;
    if (
      !schema.handlers ||
      !CFN_LIFECYCLE_HANDLERS.some(
        (handler) => schema.handlers?.[handler]?.permissions?.length,
      )
    ) {
      errors.push(`${type}: handlers가 없어 자동 검증 불가`);
      continue;
    }
    for (const handler of CFN_LIFECYCLE_HANDLERS) {
      for (const permission of schema.handlers[handler]?.permissions ?? []) {
        if (
          typeof permission !== "string" ||
          !/^[a-z0-9-]+:[A-Za-z0-9.]+$/.test(permission)
        ) {
          errors.push(
            `${type}.${handler}: 잘못된 스키마 권한 형식 ${permission}`,
          );
          continue;
        }
        // API가 PassRole 등 여러 작업으로 매핑되기 전에 미사용 속성 제외를 적용함.
        // S3 복제 미사용을 Lambda·Scheduler PassRole 허용으로 오인하지 않음.
        const sourceExclusion = exclusions[type]?.find(
          (e) =>
            e.permissions.includes(permission) &&
            typeof e.reason === "string" &&
            e.reason.trim() &&
            (e.absentProperties?.length || e.notInReference),
        );
        if (sourceExclusion) continue;
        for (const action of resolveSchemaPermission(permission, refs) ?? [
          permission,
        ]) {
          const candidates = allowed.filter(
            (s) => s.Effect === "Allow" && toList(s.Action).includes(action),
          );
          const scopeErrors = candidates.map((s) =>
            statementScopeErrors(s, action, type, schema, resources, refs),
          );
          if (scopeErrors.some((issues) => !issues.length)) continue;
          const exclusion = exclusions[type]?.find((entry) =>
            entry.permissions.includes(action),
          );
          if (
            typeof exclusion?.reason !== "string" ||
            !exclusion.reason.trim()
          ) {
            errors.push(
              `${type}.${handler}: 미허용·미설명 권한 ${action} (schema: ${permission})${scopeErrors.length ? `; 조건·Resource: ${scopeErrors.flat().join(", ")}` : ""}`,
            );
          } else if (exclusion.denied && !denied.has(action)) {
            errors.push(`${type}: 명시적 Deny 필요: ${action}`);
          }
        }
      }
    }
  }
  return [...new Set(errors)];
}
