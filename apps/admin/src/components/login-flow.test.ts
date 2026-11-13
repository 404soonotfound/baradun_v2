import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../lib/auth/provider";
import { configStatusOf, LoginFlow } from "./login-flow";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

// 로그인 설정 상태(확인 중·실패·성공) 확인 (GH-460, 시안 V26E)

const SAMPLE_POOL = {
  userPoolId: "ap-northeast-2_TestPool1",
  clientId: "testclientid123456",
};

function renderLogin(props: {
  initialResolved?: boolean;
  poolConfig?: typeof SAMPLE_POOL | null;
}) {
  return renderToStaticMarkup(
    createElement(
      AuthProvider,
      null,
      createElement(LoginFlow, { pool: "operator", ...props }),
    ),
  );
}

describe("로그인 설정 상태 (V26E)", () => {
  it("configStatusOf는 확인 중·성공·실패 세 상태를 구분한다", () => {
    expect(configStatusOf(false, undefined)).toBe("checking");
    expect(configStatusOf(false, SAMPLE_POOL)).toBe("checking");
    expect(configStatusOf(true, undefined)).toBe("error");
    expect(configStatusOf(true, SAMPLE_POOL)).toBe("ready");
  });

  it("확인 중(initialResolved=false)에는 오류 상자도 입력 칸도 그리지 않고 빈 카드 틀만 보여 준다", () => {
    const html = renderLogin({ initialResolved: false, poolConfig: null });
    expect(html).toContain("운영자 로그인");
    expect(html).toContain("초대받은 운영자만 들어올 수 있어요.");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("로그인 설정을 불러오지 못했어요.");
    expect(html).not.toContain("다시 불러오기");
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain('type="password"');
  });

  it("확인이 끝나고 설정이 없으면(error) V26E 오류 상자와 '다시 불러오기' 버튼을 보여 준다", () => {
    const html = renderLogin({ initialResolved: true, poolConfig: null });
    expect(html).toContain("운영자 로그인");
    expect(html).toContain("초대받은 운영자만 들어올 수 있어요.");
    expect(html).toContain('role="alert"');
    expect(html).toContain("로그인 설정을 불러오지 못했어요.");
    expect(html).toContain(
      "이 화면에서는 로그인할 수 없어요. 운영 책임자에게 배포 설정을 확인해 달라고 해 주세요.",
    );
    expect(html).toContain("다시 불러오기");
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain('type="password"');
  });

  it("확인이 끝나고 설정이 있으면(ready) 이메일·비밀번호 입력 폼을 보여 준다", () => {
    const html = renderLogin({
      initialResolved: true,
      poolConfig: SAMPLE_POOL,
    });
    expect(html).toContain("운영자 로그인");
    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain("로그인 설정을 불러오지 못했어요.");
    expect(html).not.toContain("다시 불러오기");
  });
});
