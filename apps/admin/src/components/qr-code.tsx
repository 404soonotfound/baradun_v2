import QRCode from "qrcode";

// 인증 앱 등록 QR (BRD-180)
// 라이브러리가 만든 SVG 문자열을 innerHTML로 넣지 않고, 칸 정보로 React가 직접 그림(Trusted Types에서 막히지 않게)

export interface QrShape {
  readonly size: number;
  readonly path: string;
}

// 줄마다 이어진 검은 칸을 한 사각형으로 이은 경로(여백 없음)
export function qrShape(text: string): QrShape {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  let path = "";
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size;) {
      if (!modules.get(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < modules.size && modules.get(row, col)) col++;
      const run = col - start;
      path += `M${start} ${row}h${run}v1h-${run}z`;
    }
  }
  return { size: modules.size, path };
}

export function QrCode({ shape, label }: { shape: QrShape; label: string }) {
  return (
    <div
      role="img"
      aria-label={label}
      className="size-[160px] rounded-admin-control border border-border-default bg-white p-2 [&_svg]:size-full"
    >
      <svg
        viewBox={`0 0 ${shape.size} ${shape.size}`}
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        <rect width={shape.size} height={shape.size} fill="#fff" />
        <path d={shape.path} fill="#000" />
      </svg>
    </div>
  );
}
