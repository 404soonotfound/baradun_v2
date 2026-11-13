import { ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTOR_EMAIL_CACHE_TTL_MS,
  cognitoOperatorEmailLookup,
  createCachedOperatorEmailLookup,
  enrichAuditActors,
  type OperatorEmailLookup,
} from "./actor-emails";
import type { AuditView } from "./audit";

function item(
  sub: string,
  kind: "operator" | "sample" = "operator",
  requestId = "req-1",
): AuditView {
  return {
    at: "2026-11-13T00:00:00.000Z",
    actorSub: sub,
    actorKind: kind,
    role: kind === "operator" ? "editor" : "sample",
    action: kind === "operator" ? "notice.create" : "sample.read",
    target: { kind: "notice", id: "n-1" },
    changes: ["body"],
    requestId,
  };
}

describe("cognitoOperatorEmailLookup", () => {
  it("sub로 ListUsers를 호출해 이메일을 읽는다", async () => {
    const send = vi.fn().mockResolvedValue({
      Users: [
        {
          Username: "alice",
          Attributes: [
            { Name: "sub", Value: "sub-alice" },
            { Name: "email", Value: "alice@example.com" },
          ],
        },
      ],
    });
    const lookup = cognitoOperatorEmailLookup("ap-northeast-2_test", {
      send,
    } as never);

    const email = await lookup.findEmailBySub("sub-alice");
    expect(email).toBe("alice@example.com");
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]![0];
    expect(cmd).toBeInstanceOf(ListUsersCommand);
    expect(cmd.input).toEqual({
      UserPoolId: "ap-northeast-2_test",
      Filter: 'sub = "sub-alice"',
      Limit: 1,
    });
  });

  it("없는 사용자·이메일 속성 없음이면 null을 돌려준다", async () => {
    const send = vi.fn().mockResolvedValue({ Users: [] });
    const lookup = cognitoOperatorEmailLookup("ap-northeast-2_test", {
      send,
    } as never);

    expect(await lookup.findEmailBySub("sub-missing")).toBeNull();
  });

  it("허용되지 않은 문자가 든 sub는 Cognito를 부르지 않고 null을 돌려준다", async () => {
    const send = vi.fn();
    const lookup = cognitoOperatorEmailLookup("ap-northeast-2_test", {
      send,
    } as never);

    expect(await lookup.findEmailBySub('sub" OR email="x')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("createCachedOperatorEmailLookup", () => {
  it("10분 동안은 캐시에서 돌려주고, 만료 뒤에는 다시 조회한다", async () => {
    let time = new Date("2026-11-13T00:00:00.000Z");
    const inner: OperatorEmailLookup = {
      findEmailBySub: vi
        .fn()
        .mockResolvedValueOnce("a@example.com")
        .mockResolvedValueOnce("a2@example.com"),
    };
    const cached = createCachedOperatorEmailLookup(inner, () => time);

    expect(await cached.findEmailBySub("sub-1")).toBe("a@example.com");
    time = new Date(time.getTime() + ACTOR_EMAIL_CACHE_TTL_MS - 1);
    expect(await cached.findEmailBySub("sub-1")).toBe("a@example.com");
    expect(inner.findEmailBySub).toHaveBeenCalledTimes(1);

    time = new Date(time.getTime() + 1);
    expect(await cached.findEmailBySub("sub-1")).toBe("a2@example.com");
    expect(inner.findEmailBySub).toHaveBeenCalledTimes(2);
  });

  it("조회 예외는 캐시하지 않아 다음 요청에서 다시 조회한다", async () => {
    const time = new Date("2026-11-13T00:00:00.000Z");
    const inner: OperatorEmailLookup = {
      findEmailBySub: vi
        .fn()
        .mockRejectedValueOnce(new Error("ThrottlingException"))
        .mockResolvedValueOnce("recovered@example.com"),
    };
    const cached = createCachedOperatorEmailLookup(inner, () => time);

    await expect(cached.findEmailBySub("sub-1")).rejects.toThrow();
    expect(await cached.findEmailBySub("sub-1")).toBe("recovered@example.com");
    expect(inner.findEmailBySub).toHaveBeenCalledTimes(2);
  });
});

describe("enrichAuditActors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("찾은 운영자만 actorEmail을 채우고, 같은 sub가 여러 번 나와도 한 번만 조회한다", async () => {
    const lookup: OperatorEmailLookup = {
      findEmailBySub: vi.fn(async (sub) =>
        sub === "sub-a" ? "alice@example.com" : null,
      ),
    };
    const rows = [
      item("sub-a", "operator", "req-1"),
      item("sub-a", "operator", "req-2"),
      item("sub-missing", "operator", "req-3"),
    ];

    const out = await enrichAuditActors(rows, lookup, { traceId: "t-1" });
    expect(lookup.findEmailBySub).toHaveBeenCalledTimes(2);
    expect(out[0]?.actorEmail).toBe("alice@example.com");
    expect(out[1]?.actorEmail).toBe("alice@example.com");
    expect(out[2]).not.toHaveProperty("actorEmail");
  });

  it("데모(샘플) 계정 sub는 조회하지 않고 actorEmail 없이 돌려준다", async () => {
    const lookup: OperatorEmailLookup = {
      findEmailBySub: vi.fn(),
    };
    const rows = [item("demo-sub-1", "sample", "req-1")];

    const out = await enrichAuditActors(rows, lookup, { traceId: "t-1" });
    expect(lookup.findEmailBySub).not.toHaveBeenCalled();
    expect(out[0]).not.toHaveProperty("actorEmail");
  });

  it("조회 실패 시 actorEmail 없이 돌려주고 로그에 이메일이나 sub를 남기지 않는다", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const lookup: OperatorEmailLookup = {
      findEmailBySub: vi.fn(async (sub) => {
        if (sub === "sub-fail") throw new Error("ServiceUnavailable");
        return "bob@example.com";
      }),
    };
    const rows = [
      item("sub-fail", "operator", "req-1"),
      item("sub-ok", "operator", "req-2"),
    ];

    const out = await enrichAuditActors(rows, lookup, { traceId: "t-1" });
    expect(out[0]).not.toHaveProperty("actorEmail");
    expect(out[1]?.actorEmail).toBe("bob@example.com");
    expect(log).toHaveBeenCalledTimes(1);
    const logged = String(log.mock.calls[0]?.[0]);
    expect(logged).toContain("ops_audit_actor_email_failed");
    expect(logged).not.toContain("bob@example.com");
    expect(logged).not.toContain("sub-fail");
  });

  it("조회 시간 제한을 넘기면 중단 신호를 보내고 먼저 찾은 이메일만 채워 반환한다", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let aborted = false;
    const lookup: OperatorEmailLookup = {
      findEmailBySub: vi.fn((sub, signal) => {
        if (sub === "sub-fast") return Promise.resolve("fast@example.com");
        signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<string | null>(() => {});
      }),
    };
    const rows = [
      item("sub-slow", "operator", "req-1"),
      item("sub-fast", "operator", "req-2"),
    ];

    const out = await enrichAuditActors(rows, lookup, { traceId: "t-2" }, 20);
    expect(aborted).toBe(true);
    expect(out[0]).not.toHaveProperty("actorEmail");
    expect(out[1]?.actorEmail).toBe("fast@example.com");
    expect(log).toHaveBeenCalledTimes(1);
  });
});
