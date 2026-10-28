import { describe, expect, it, vi } from "vitest";

import { copyText, shareUrl, shareWithDevice, smsHref } from "./share";

// 공유 링크·기기 공유 창·링크 복사 (BRD-34)
describe("shareUrl", () => {
  it("한국어는 접두어 없이 해변 경로만", () => {
    expect(shareUrl("https://baradun.kr", "ko", "gyeongpo")).toBe(
      "https://baradun.kr/spots/gyeongpo/",
    );
  });

  it("영어는 /en 경로", () => {
    expect(shareUrl("https://baradun.kr", "en", "gyeongpo")).toBe(
      "https://baradun.kr/en/spots/gyeongpo/",
    );
  });

  it("지금 주소의 쿼리·해시·경로는 버리고 origin만 씀(위치·검색어가 링크로 새지 않게)", () => {
    expect(
      shareUrl(
        "https://baradun.kr/search/?q=경포&lat=37.1#x",
        "ko",
        "gyeongpo",
      ),
    ).toBe("https://baradun.kr/spots/gyeongpo/");
  });

  it("slug의 특수 문자는 경로 밖으로 나가지 않게 인코딩", () => {
    expect(shareUrl("https://baradun.kr", "ko", "a?b#c")).toBe(
      "https://baradun.kr/spots/a%3Fb%23c/",
    );
  });

  it("잘못된 origin이나 http(s)가 아닌 주소는 null", () => {
    expect(shareUrl("", "ko", "gyeongpo")).toBeNull();
    expect(shareUrl("not a url", "ko", "gyeongpo")).toBeNull();
    expect(shareUrl("file:///Users/x/out/index.html", "ko", "g")).toBeNull();
  });
});

describe("shareWithDevice", () => {
  const data = { title: "경포해수욕장", url: "https://baradun.kr/spots/g/" };

  it("공유 창이 없으면 unsupported", async () => {
    expect(await shareWithDevice(undefined, data)).toBe("unsupported");
    expect(await shareWithDevice({}, data)).toBe("unsupported");
  });

  it("canShare가 거부하면 unsupported(공유 창을 열지 않음)", async () => {
    const share = vi.fn();
    expect(await shareWithDevice({ share, canShare: () => false }, data)).toBe(
      "unsupported",
    );
    expect(share).not.toHaveBeenCalled();
  });

  it("공유하면 shared, 받은 값 그대로 넘김", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    expect(await shareWithDevice({ share }, data)).toBe("shared");
    expect(share).toHaveBeenCalledWith(data);
  });

  it("사용자가 닫으면(AbortError) cancelled", async () => {
    const abort = new DOMException("닫음", "AbortError");
    const share = vi.fn().mockRejectedValue(abort);
    expect(await shareWithDevice({ share }, data)).toBe("cancelled");
  });

  it("그 밖의 오류·Error가 아닌 값·canShare 예외는 failed", async () => {
    const notAllowed = new DOMException("막힘", "NotAllowedError");
    expect(
      await shareWithDevice(
        { share: vi.fn().mockRejectedValue(notAllowed) },
        data,
      ),
    ).toBe("failed");
    expect(
      await shareWithDevice({ share: vi.fn().mockRejectedValue("x") }, data),
    ).toBe("failed");
    expect(
      await shareWithDevice(
        {
          share: vi.fn(),
          canShare: () => {
            throw new TypeError("bad");
          },
        },
        data,
      ),
    ).toBe("failed");
  });
});

describe("copyText", () => {
  it("복사하면 copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyText({ writeText }, "주소")).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("주소");
  });

  it("클립보드가 없거나 쓰기 함수가 없으면 failed", async () => {
    expect(await copyText(undefined, "주소")).toBe("failed");
    expect(await copyText({}, "주소")).toBe("failed");
  });

  it("쓰기를 거부하면 failed", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    expect(await copyText({ writeText }, "주소")).toBe("failed");
  });
});

describe("smsHref", () => {
  it("본문을 인코딩해 sms 주소로", () => {
    expect(smsHref("경포 https://a.kr/spots/g/?x=1&y=2")).toBe(
      "sms:?&body=%EA%B2%BD%ED%8F%AC%20https%3A%2F%2Fa.kr%2Fspots%2Fg%2F%3Fx%3D1%26y%3D2",
    );
  });
});
