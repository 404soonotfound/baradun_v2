import { describe, expect, it } from "vitest";
import type { Principal } from "./auth";
import { OPERATOR_ROLES } from "./policy";
import { decideRoute, isWriteMethod, ROUTES, type Method } from "./routes";

// 역할별 허용표 (BRD-146, 구현 제안 I04 · D16-A8)

const operator = (role: (typeof OPERATOR_ROLES)[number]): Principal => ({
  kind: "operator",
  sub: "s",
  role,
  authTime: 0,
});
const sample: Principal = { kind: "sample", sub: "s", authTime: 0 };

describe("허용표", () => {
  it("표에 없는 경로는 404, method가 없으면 405", () => {
    expect(decideRoute("/ops/unknown", "GET", operator("publisher"))).toEqual({
      ok: false,
      status: 404,
    });
    expect(decideRoute("/ops/me", "DELETE", operator("publisher"))).toEqual({
      ok: false,
      status: 405,
    });
  });

  it("/ops/me GET은 세 역할과 샘플 모두 허락한다", () => {
    for (const role of OPERATOR_ROLES) {
      expect(decideRoute("/ops/me", "GET", operator(role))).toEqual({
        ok: true,
      });
    }
    expect(decideRoute("/ops/me", "GET", sample)).toEqual({ ok: true });
  });

  it("샘플이 허락된 쓰기 경로가 없다(표에 잘못 넣어도 쓰기는 막음)", () => {
    for (const [path, methods] of Object.entries(ROUTES)) {
      for (const [method, rule] of Object.entries(methods)) {
        if (isWriteMethod(method as Method)) {
          expect(rule?.sample, `${method} ${path}`).toBe(false);
        }
      }
    }
  });

  it("판단 상태(status)를 쓰는 경로가 없다(G1)", () => {
    for (const path of Object.keys(ROUTES)) {
      expect(path).not.toMatch(/status|classif|judg/i);
    }
  });

  it("모든 경로는 /ops/ 아래에 있다", () => {
    for (const path of Object.keys(ROUTES)) {
      expect(path.startsWith("/ops/")).toBe(true);
    }
  });
});
