import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { qrShape } from "./qr-code";

// 인증 앱 등록 QR (BRD-180): 경로가 라이브러리의 칸 정보와 같은 칸만 칠하는지 확인

// 경로의 사각형(M x y h n v1 h-n z)을 칠한 칸 목록으로 펼침
function paintedCells(path: string): Set<string> {
  const cells = new Set<string>();
  for (const [, x, y, n] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    for (let i = 0; i < Number(n); i++) cells.add(`${Number(x) + i},${y}`);
  }
  return cells;
}

describe("qrShape", () => {
  it("라이브러리가 만든 검은 칸과 같은 칸만 칠한다", () => {
    const text =
      "otpauth://totp/baradun:op%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=baradun";
    const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
    const expected = new Set<string>();
    for (let row = 0; row < modules.size; row++) {
      for (let col = 0; col < modules.size; col++) {
        if (modules.get(row, col)) expected.add(`${col},${row}`);
      }
    }

    const shape = qrShape(text);
    expect(shape.size).toBe(modules.size);
    expect(shape.path.replace(/M\d+ \d+h(\d+)v1h-\1z/g, "")).toBe("");
    expect(paintedCells(shape.path)).toEqual(expected);
  });
});
