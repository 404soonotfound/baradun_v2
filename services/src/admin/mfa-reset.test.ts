import {
  AdminDeleteSoftwareTokenCommand,
  AdminGetUserCommand,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthDependencies } from "./auth";
import { handleOps, type OpsDependencies } from "./handler";
import { AUDIT_PREFIX } from "./keys";
import {
  cognitoMfaResetter,
  parseMfaResetBody,
  type MfaResetter,
  type OperatorAccount,
} from "./mfa-reset";
import { ACCESS_TOKEN_HEADER } from "./policy";
import { FakeTable, type Item } from "./test-dynamo";
import { TEST_CONFIG } from "./test-tokens";

// 다른 운영자의 2단계 인증 초기화 POST /ops/account/mfa-reset (#335, D16-A9)
// 토큰 검증·Cognito·DB는 가짜. 본인·없는 계정·이미 없음은 실패와 다른 응답으로 가름

const NOW = new Date("2026-11-13T03:00:00Z");
const NOW_SEC = NOW.getTime() / 1000;
const ISS = (pool: string) =>
  `https://cognito-idp.ap-northeast-2.amazonaws.com/${pool}`;
const PATH = "/ops/account/mfa-reset";
const TARGET = "lost@example.test";

function claims(group: string) {
  return group === "sample"
    ? {
        sub: "sample-sub",
        iss: ISS(TEST_CONFIG.sample.userPoolId),
        auth_time: NOW_SEC - 60,
        "cognito:groups": ["sample"],
      }
    : {
        sub: `${group}-sub`,
        iss: ISS(TEST_CONFIG.operator.userPoolId),
        auth_time: NOW_SEC - 60,
        "cognito:groups": [group],
      };
}

let seq = 0;
function nextIds() {
  seq++;
  const n = String(seq).padStart(6, "0");
  return { traceId: `trace-${n}`, requestId: `req-${n}` };
}

function fakeResetter(account: OperatorAccount | null) {
  const deleted: string[] = [];
  const resetter: MfaResetter = {
    find: vi.fn(async () => account),
    deleteSoftwareToken: vi.fn(async (username: string) => {
      deleted.push(username);
    }),
  };
  return { resetter, deleted };
}

const OTHER: OperatorAccount = {
  username: "user-lost",
  sub: "lost-sub",
  mfa: true,
};

function deps(
  group: string,
  table: FakeTable,
  resetter: MfaResetter | null,
): OpsDependencies {
  const auth: AuthDependencies = {
    config: TEST_CONFIG,
    verifier: { verify: async () => claims(group) },
    samplePolicy: async () => ({
      subs: ["sample-sub"],
      allowedFrom: new Date(NOW.getTime() - 3_600_000),
      allowedUntil: new Date(NOW.getTime() + 3_600_000),
    }),
    now: () => NOW,
  };
  return {
    auth,
    data: {
      client: table as never,
      opsTable: "Ops",
      inquiryTable: "Inquiry",
      now: () => NOW,
      mfaReset: resetter,
    },
    ids: nextIds,
  };
}

function event(body: unknown, method = "POST"): APIGatewayProxyEventV2 {
  return {
    rawPath: PATH,
    headers: {
      [ACCESS_TOKEN_HEADER]: "token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method } },
  } as unknown as APIGatewayProxyEventV2;
}

const parse = (result: { body?: string | undefined }) =>
  JSON.parse(result.body!);

function audits(table: FakeTable): Item[] {
  return [...table.items.values()].filter((i) =>
    String(i.pk).startsWith(AUDIT_PREFIX),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("parseMfaResetBody", () => {
  it("이메일 하나만 받는다", () => {
    expect(parseMfaResetBody({ email: TARGET })).toEqual({
      ok: true,
      email: TARGET,
    });
  });
  it.each<[string, unknown, string]>([
    ["배열", [], "body"],
    ["다른 칸", { email: TARGET, sub: "x" }, "body"],
    ["빈 값", { email: "" }, "email"],
    ["골뱅이 없음", { email: "lost.example.test" }, "email"],
    ["앞뒤 공백", { email: ` ${TARGET}` }, "email"],
    ["너무 김", { email: `${"a".repeat(250)}@x.test` }, "email"],
  ])("%s → 400(%s)", (_, body, field) => {
    expect(parseMfaResetBody(body)).toEqual({ ok: false, field });
  });
});

describe("POST /ops/account/mfa-reset", () => {
  it.each(["viewer", "editor", "publisher"])(
    "%s 운영자는 다른 운영자의 인증 앱을 지우고 변경 이력에 sub만 남긴다(이메일 없음)",
    async (group) => {
      const table = new FakeTable();
      const { resetter, deleted } = fakeResetter(OTHER);
      const result = await handleOps(
        event({ email: TARGET }),
        deps(group, table, resetter),
      );
      expect(result.statusCode).toBe(200);
      expect(parse(result)).toEqual({ result: "reset" });
      expect(resetter.find).toHaveBeenCalledWith(TARGET);
      expect(deleted).toEqual(["user-lost"]);
      const [audit, ...rest] = audits(table);
      expect(rest).toEqual([]);
      expect(audit).toMatchObject({
        action: "permission.mfa_reset",
        actorSub: `${group}-sub`,
        role: group,
        targetKind: "account",
        targetId: "lost-sub",
        changes: ["mfa"],
        at: NOW.toISOString(),
      });
      expect(JSON.stringify(audit)).not.toContain(TARGET);
    },
  );

  it("데모 계정은 허용표에서 막히고 Cognito를 부르지 않는다", async () => {
    const table = new FakeTable();
    const { resetter } = fakeResetter(OTHER);
    const result = await handleOps(
      event({ email: TARGET }),
      deps("sample", table, resetter),
    );
    expect(result.statusCode).toBe(403);
    expect(resetter.find).not.toHaveBeenCalled();
    expect(resetter.deleteSoftwareToken).not.toHaveBeenCalled();
    expect(audits(table).map((a) => a.action)).toEqual(["sample.denied"]);
  });

  it("GET은 405", async () => {
    const { resetter } = fakeResetter(OTHER);
    const result = await handleOps(
      event({ email: TARGET }, "GET"),
      deps("publisher", new FakeTable(), resetter),
    );
    expect(result.statusCode).toBe(405);
  });

  it("본인 이메일이면 409 self로 거부하고 지우지 않는다", async () => {
    const table = new FakeTable();
    const { resetter, deleted } = fakeResetter({
      ...OTHER,
      sub: "editor-sub",
    });
    const result = await handleOps(
      event({ email: TARGET }),
      deps("editor", table, resetter),
    );
    expect(result.statusCode).toBe(409);
    expect(parse(result).error).toMatchObject({
      code: "conflict",
      reason: "self",
    });
    expect(deleted).toEqual([]);
    expect(audits(table)).toEqual([]);
  });

  it("운영자 풀에 없는 이메일이면 404 account로 알리고 지우지 않는다", async () => {
    const table = new FakeTable();
    const { resetter, deleted } = fakeResetter(null);
    const result = await handleOps(
      event({ email: TARGET }),
      deps("editor", table, resetter),
    );
    expect(result.statusCode).toBe(404);
    expect(parse(result).error).toMatchObject({
      code: "not_found",
      reason: "account",
    });
    expect(deleted).toEqual([]);
    expect(audits(table)).toEqual([]);
  });

  it("인증 앱이 이미 없으면 바꾸지 않고 already_none(변경 이력 없음)", async () => {
    const table = new FakeTable();
    const { resetter, deleted } = fakeResetter({ ...OTHER, mfa: false });
    const result = await handleOps(
      event({ email: TARGET }),
      deps("editor", table, resetter),
    );
    expect(result.statusCode).toBe(200);
    expect(parse(result)).toEqual({ result: "already_none" });
    expect(deleted).toEqual([]);
    expect(audits(table)).toEqual([]);
  });

  it("이메일 모양이 틀리면 400 email", async () => {
    const { resetter } = fakeResetter(OTHER);
    const result = await handleOps(
      event({ email: "not-an-email" }),
      deps("editor", new FakeTable(), resetter),
    );
    expect(result.statusCode).toBe(400);
    expect(parse(result).error).toMatchObject({ field: "email" });
    expect(resetter.find).not.toHaveBeenCalled();
  });

  it("Cognito 조회·지우기 실패는 500이고 변경 이력을 남기지 않는다", async () => {
    for (const fail of ["find", "delete"] as const) {
      const table = new FakeTable();
      const { resetter } = fakeResetter(OTHER);
      if (fail === "find") {
        vi.mocked(resetter.find).mockRejectedValueOnce(new Error("boom"));
      } else {
        vi.mocked(resetter.deleteSoftwareToken).mockRejectedValueOnce(
          new Error("boom"),
        );
      }
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const result = await handleOps(
        event({ email: TARGET }),
        deps("editor", table, resetter),
      );
      expect(result.statusCode).toBe(500);
      expect(audits(table)).toEqual([]);
    }
  });

  it("지운 뒤 기록에 실패하면 500과 함께 대상 sub·요청 ID를 오류 로그로 남긴다", async () => {
    const table = new FakeTable();
    vi.spyOn(table, "send").mockRejectedValue(new Error("ddb down"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { resetter, deleted } = fakeResetter(OTHER);
    const result = await handleOps(
      event({ email: TARGET }),
      deps("editor", table, resetter),
    );
    expect(result.statusCode).toBe(500);
    expect(deleted).toEqual(["user-lost"]);
    const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "error",
        event: "ops_mfa_reset_unaudited",
        targetSub: "lost-sub",
        actorSub: "editor-sub",
      }),
    );
    expect(JSON.stringify(lines)).not.toContain(TARGET);
  });

  it("초기화 설정이 없으면 500(조용히 성공처럼 보이지 않음)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await handleOps(
      event({ email: TARGET }),
      deps("editor", new FakeTable(), null),
    );
    expect(result.statusCode).toBe(500);
  });
});

describe("cognitoMfaResetter", () => {
  const POOL = "ap-northeast-2_TestOperator";

  function client(reply: (command: unknown) => unknown) {
    const calls: unknown[] = [];
    return {
      calls,
      client: {
        send: vi.fn(async (command: unknown) => {
          calls.push(command);
          return reply(command);
        }),
      } as never,
    };
  }

  it("운영자 풀에서 이메일로 찾고 sub·인증 앱 등록 여부를 읽는다", async () => {
    const fake = client(() => ({
      Username: "user-lost",
      UserAttributes: [
        { Name: "email", Value: TARGET },
        { Name: "sub", Value: "lost-sub" },
      ],
      UserMFASettingList: ["SOFTWARE_TOKEN_MFA"],
    }));
    const resetter = cognitoMfaResetter(POOL, fake.client);
    expect(await resetter.find(TARGET)).toEqual({
      username: "user-lost",
      sub: "lost-sub",
      mfa: true,
    });
    const [command] = fake.calls as AdminGetUserCommand[];
    expect(command).toBeInstanceOf(AdminGetUserCommand);
    expect(command!.input).toEqual({ UserPoolId: POOL, Username: TARGET });
  });

  it("목록이 비어도 선호 설정이 인증 앱이면 mfa: true", async () => {
    const preferred = cognitoMfaResetter(
      POOL,
      client(() => ({
        Username: "u",
        UserAttributes: [{ Name: "sub", Value: "s" }],
        PreferredMfaSetting: "SOFTWARE_TOKEN_MFA",
      })).client,
    );
    expect(await preferred.find(TARGET)).toMatchObject({ mfa: true });
  });

  it("인증 앱이 없으면 mfa: false, 없는 계정은 null", async () => {
    const none = cognitoMfaResetter(
      POOL,
      client(() => ({
        Username: "u",
        UserAttributes: [{ Name: "sub", Value: "s" }],
      })).client,
    );
    expect(await none.find(TARGET)).toMatchObject({ mfa: false });
    const missing = cognitoMfaResetter(
      POOL,
      client(() => {
        throw new UserNotFoundException({ message: "no", $metadata: {} });
      }).client,
    );
    expect(await missing.find(TARGET)).toBeNull();
  });

  it("sub가 없는 응답이나 다른 오류는 던진다('없음'으로 바꾸지 않음)", async () => {
    const odd = cognitoMfaResetter(
      POOL,
      client(() => ({ Username: "u", UserAttributes: [] })).client,
    );
    await expect(odd.find(TARGET)).rejects.toThrow();
    const broken = cognitoMfaResetter(
      POOL,
      client(() => {
        throw new Error("throttled");
      }).client,
    );
    await expect(broken.find(TARGET)).rejects.toThrow("throttled");
  });

  it("지우기는 운영자 풀·사용자 이름으로 AdminDeleteSoftwareToken을 부른다", async () => {
    const fake = client(() => ({}));
    await cognitoMfaResetter(POOL, fake.client).deleteSoftwareToken(
      "user-lost",
    );
    const [command] = fake.calls as AdminDeleteSoftwareTokenCommand[];
    expect(command).toBeInstanceOf(AdminDeleteSoftwareTokenCommand);
    expect(command!.input).toEqual({ UserPoolId: POOL, Username: "user-lost" });
  });
});
