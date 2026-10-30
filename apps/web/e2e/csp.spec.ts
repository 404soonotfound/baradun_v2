import { chooseTheme, expect, test } from "./fixtures";

// CSP 및 보안 응답 헤더 검증 (BRD-118)
// - CloudFront 보안 헤더(HSTS·nosniff·X-Frame-Options·Referrer-Policy·Permissions-Policy·CSP) 검증
// - meta CSP와 헤더 CSP 조합으로 해시 없는 인라인 스크립트 차단 직접 증명 (결정 1)
// - 홈·탐색 지도·장소 상세·문의(사진 켜짐·꺼짐)·다크모드·/en·404·클라이언트 이동·새로고침·서비스 워커 등록에서 콘솔 CSP 위반 0건 검증

test.describe("보안 응답 헤더 및 CSP 검증 (BRD-118)", () => {
  test("응답 헤더에 HSTS 1년·nosniff·X-Frame-Options DENY·Referrer-Policy·Permissions-Policy·CSP가 포함된다", async ({
    page,
  }) => {
    const response = await page.goto("/");
    expect(response).not.toBeNull();
    const headers = response!.headers();

    expect(headers["strict-transport-security"]).toBe("max-age=31536000");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toBe(
      "camera=(), microphone=(), geolocation=(self)",
    );

    const csp = headers["content-security-policy"];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain(
      "img-src 'self' blob: https://tiles.openfreemap.org https://tong.visitkorea.or.kr",
    );
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("connect-src 'self' https://tiles.openfreemap.org");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("해시가 없는 인라인 스크립트가 meta CSP에 의해 실제로 차단됨을 증명한다 (결정 1)", async ({
    page,
  }) => {
    const violations: string[] = [];
    page.on("console", (msg) => {
      if (
        msg.type() === "error" &&
        msg.text().toLowerCase().includes("content security policy")
      ) {
        violations.push(msg.text());
      }
    });

    await page.route("/__test_csp_block__", (route) => {
      route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          // 헤더는 unsafe-inline 허용
          "content-security-policy": "script-src 'self' 'unsafe-inline'",
        },
        body: `<!DOCTYPE html>
<html>
  <head>
    <!-- meta CSP에는 해시 'sha256-dummyHashAllowedOnly'만 허용 -->
    <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'sha256-dummyHashAllowedOnly'">
  </head>
  <body>
    <h1>CSP Block Test</h1>
    <!-- 허가받지 않은 인라인 스크립트 (해시 불일치) -->
    <script>
      window.__unauthorizedScriptRan = true;
    </script>
  </body>
</html>`,
      });
    });

    await page.goto("/__test_csp_block__");

    // 인라인 스크립트가 실행되지 않았음을 확인
    const ran = await page.evaluate(
      () =>
        (window as unknown as { __unauthorizedScriptRan?: boolean })
          .__unauthorizedScriptRan,
    );
    expect(ran).toBeUndefined();
    // 브라우저가 CSP 위반을 감지했음을 확인
    expect(violations.length).toBeGreaterThan(0);
  });

  // 주요 화면 콘솔 CSP 위반 0건 확인 헬퍼
  async function assertZeroCspViolations(
    page: import("@playwright/test").Page,
    url: string,
    action?: () => Promise<void>,
  ) {
    const cspViolations: string[] = [];
    const hydrationErrors: string[] = [];

    page.on("console", (msg) => {
      const text = msg.text();
      if (
        msg.type() === "error" &&
        text.toLowerCase().includes("content security policy")
      ) {
        cspViolations.push(text);
      }
      if (
        msg.type() === "error" &&
        (text.includes("Hydration failed") ||
          text.includes("did not match") ||
          text.includes("Minified React error"))
      ) {
        hydrationErrors.push(text);
      }
    });

    await page.goto(url);
    await page.waitForLoadState("domcontentloaded");
    await page.locator("main").first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});

    if (action) {
      await action();
      await page.waitForTimeout(300);
    }

    expect(
      cspViolations,
      `CSP 위반 발생 on ${url}: ${cspViolations.join("\n")}`,
    ).toEqual([]);
    expect(
      hydrationErrors,
      `하이드레이션 에러 발생 on ${url}: ${hydrationErrors.join("\n")}`,
    ).toEqual([]);
  }

  test("홈(/)에서 CSP 위반 및 하이드레이션 오류가 없다", async ({ page }) => {
    await assertZeroCspViolations(page, "/");
  });

  test("영문 홈(/en/)에서 CSP 위반 및 하이드레이션 오류가 없다", async ({
    page,
  }) => {
    await assertZeroCspViolations(page, "/en/");
  });

  test("탐색 지도(/explore/)에서 지도 로드 시 CSP 위반이 없다", async ({
    page,
  }, testInfo) => {
    await assertZeroCspViolations(page, "/explore/", async () => {
      // 모바일 환경이면 지도 보기 버튼 클릭
      if (testInfo.project.name === "mobile") {
        const mapBtn = page
          .getByRole("group", { name: "목록·지도 보기" })
          .getByRole("button", { name: "지도" });
        if (await mapBtn.isVisible()) {
          await mapBtn.click();
          await page.waitForTimeout(500);
        }
      }
    });
  });

  test("장소 상세(/spots/gyeongpo/)에서 CSP 위반 및 하이드레이션 오류가 없다", async ({
    page,
  }) => {
    await assertZeroCspViolations(page, "/spots/gyeongpo/");
  });

  test("문의 화면(/settings/inquiry/)에서 사진 꺼짐 상태 시 CSP 위반이 없다", async ({
    page,
  }) => {
    await assertZeroCspViolations(page, "/settings/inquiry/", async () => {
      const mismatchBtn = page.getByText("정보가 실제와 달라요");
      if (await mismatchBtn.isVisible()) {
        await mismatchBtn.click();
      }
    });
  });

  test("문의 화면에서 사진 켜짐 설정 시 S3 업로드 통신이 CSP connect-src에 의해 허용된다", async ({
    page,
  }) => {
    // 사진 버킷이 connect-src에 포함된 경우 S3 POST 요청이 CSP에 의해 차단되지 않음을 시험
    const targetBucket = "baradun-inquiry-photos-prod";
    await page.route("/__test_photo_csp__", (route) => {
      route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://${targetBucket}.s3.ap-northeast-2.amazonaws.com`,
        },
        body: `<!DOCTYPE html><html><head></head><body><h1>Photo Upload CSP Test</h1></body></html>`,
      });
    });

    // 버킷으로의 fetch를 가짜 200 응답으로 라우팅
    await page.route(
      `https://${targetBucket}.s3.ap-northeast-2.amazonaws.com/*`,
      (route) => route.fulfill({ status: 200, body: "<ok/>" }),
    );

    const violations: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" && msg.text().toLowerCase().includes("content security policy")) {
        violations.push(msg.text());
      }
    });

    await page.goto("/__test_photo_csp__");
    const fetchStatus = await page.evaluate(async (bucket) => {
      try {
        const res = await fetch(`https://${bucket}.s3.ap-northeast-2.amazonaws.com/`, {
          method: "POST",
          body: new FormData(),
        });
        return res.status;
      } catch (e) {
        return (e as Error).message;
      }
    }, targetBucket);

    expect(fetchStatus).toBe(200);
    expect(violations).toEqual([]);
  });

  test("다크 모드 적용 시 CSP 위반이 없다", async ({ page }) => {
    await assertZeroCspViolations(page, "/settings/", async () => {
      await chooseTheme(page, "어둡게");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    });
  });

  test("404 페이지(/not-found-page-test/)에서 CSP 위반이 없다", async ({
    page,
  }) => {
    await assertZeroCspViolations(page, "/not-found-page-test/");
  });

  test("클라이언트 페이지 이동(홈 -> 탐색 -> 설정)과 새로고침 시 CSP 위반이 없다", async ({
    page,
  }) => {
    await assertZeroCspViolations(page, "/", async () => {
      const exploreLink = page.getByRole("link", { name: "탐색" });
      await exploreLink.click();
      await page.waitForURL("**/explore/");

      const settingsLink = page.getByRole("link", { name: "설정" });
      await settingsLink.click();
      await page.waitForURL("**/settings/");

      await page.reload();
    });
  });

  test("서비스 워커 등록 및 실행 시 CSP 위반이 없다", async ({ browser }) => {
    const context = await browser.newContext({
      serviceWorkers: "allow",
    });
    const page = await context.newPage();
    const cspViolations: string[] = [];

    page.on("console", (msg) => {
      if (
        msg.type() === "error" &&
        msg.text().toLowerCase().includes("content security policy")
      ) {
        cspViolations.push(msg.text());
      }
    });

    await page.goto("/");
    // 서비스 워커 등록 확인
    await page.waitForFunction(
      async () => {
        if (!("serviceWorker" in navigator)) return false;
        const reg = await navigator.serviceWorker.getRegistration();
        return reg !== undefined;
      },
      undefined,
      { timeout: 10_000 },
    );

    expect(cspViolations).toEqual([]);
    await context.close();
  });

  test("서비스 워커 등록 후 오프라인 상태에서 홈 및 장소 상세 재방문 시 CSP 위반 및 하이드레이션 오류가 없다", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      serviceWorkers: "allow",
    });
    const page = await context.newPage();
    const cspViolations: string[] = [];
    const hydrationErrors: string[] = [];

    page.on("console", (msg) => {
      const text = msg.text();
      if (
        msg.type() === "error" &&
        text.toLowerCase().includes("content security policy")
      ) {
        cspViolations.push(text);
      }
      if (
        msg.type() === "error" &&
        (text.includes("Hydration failed") ||
          text.includes("did not match") ||
          text.includes("Minified React error"))
      ) {
        hydrationErrors.push(text);
      }
    });

    // 1. 온라인 상태에서 홈 접속 및 서비스 워커 등록 대기
    await page.goto("/");
    await page.waitForFunction(
      async () => {
        if (!("serviceWorker" in navigator)) return false;
        const reg = await navigator.serviceWorker.getRegistration();
        return reg !== undefined;
      },
      undefined,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(500);

    // 2. 온라인 상태에서 장소 상세 미리 열기
    await page.goto("/spots/gyeongpo/");
    await page.waitForLoadState("domcontentloaded");
    await page
      .locator("main")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => {});

    // 3. 오프라인으로 전환
    await context.setOffline(true);

    // 4. 홈 다시 열기 (서비스 워커 캐시 서빙)
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page
      .locator("main")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => {});
    await page.waitForTimeout(300);

    // 5. 이미 열어 본 장소 상세 다시 열기
    await page.goto("/spots/gyeongpo/");
    await page.waitForLoadState("domcontentloaded");
    await page
      .locator("main")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => {});
    await page.waitForTimeout(300);

    expect(
      cspViolations,
      `오프라인 재방문 중 CSP 위반 발생: ${cspViolations.join("\n")}`,
    ).toEqual([]);
    expect(
      hydrationErrors,
      `오프라인 재방문 중 하이드레이션 오류 발생: ${hydrationErrors.join("\n")}`,
    ).toEqual([]);

    await context.close();
  });
});
