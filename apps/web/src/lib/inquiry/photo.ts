import { PHOTO_MAX_BYTES, type PhotoToSend } from "./api";

// 문의 사진 준비 (BRD-37 · 결정 기록 9장·11장 10/26: 사진만 최대 3장, 기기에서 줄이고 위치 정보 삭제)
// 처리값은 결정 기록 12장 결정 23: 원본 20MiB · 긴 변 2048px · EXIF 제거 · JPEG 품질 약 0.82 · 최종 4MiB(서버도 다시 검사)
// 브라우저에서 사진을 다시 그려(canvas) JPEG로 새로 만듦 → EXIF(GPS 포함) 등 원본 메타데이터가 모두 빠짐
// 서버도 EXIF GPS가 남은 사진을 거부함(infra/README). 동영상·이미지가 아닌 파일은 받지 않음

export const PHOTO_LONG_EDGE = 2048; // 긴 변 최대(px). 화면에서 확인하기에 충분한 크기
export const PHOTO_INPUT_MAX_BYTES = 20 * 1024 * 1024; // 고르기 전 원본 상한(너무 큰 파일은 기기에서 열지 않음)
const QUALITIES = [0.82, 0.7, 0.55]; // 0.82로 만들고 4MiB를 넘으면 차례로 낮춤

export type PhotoError = "notImage" | "tooLarge" | "unreadable";

// 줄일 크기 (순수 함수). 이미 작으면 그대로
export function fitSize(
  width: number,
  height: number,
  longEdge: number = PHOTO_LONG_EDGE,
): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= longEdge) return { width, height };
  const scale = longEdge / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// 고른 파일 먼저 거르기 (순수 함수). 사진(image/*)만, 원본 20MiB까지
export function checkPickedFile(file: {
  type: string;
  size: number;
}): PhotoError | null {
  if (!file.type.startsWith("image/")) return "notImage";
  if (file.size > PHOTO_INPUT_MAX_BYTES) return "tooLarge";
  return null;
}

function toBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality),
  );
}

// 사진 → 줄이고 메타데이터를 뺀 JPEG. 열 수 없거나 줄여도 4MiB를 넘으면 오류
export async function preparePhoto(
  file: File,
): Promise<
  { ok: true; photo: PhotoToSend } | { ok: false; error: PhotoError }
> {
  const picked = checkPickedFile(file);
  if (picked) return { ok: false, error: picked };
  let bitmap: ImageBitmap;
  try {
    // 원본의 회전 정보는 그림에 반영하고(from-image) 새 파일에는 남기지 않음
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { ok: false, error: "unreadable" };
  }
  try {
    const size = fitSize(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return { ok: false, error: "unreadable" };
    // JPEG는 투명을 못 담아 투명한 곳이 검게 됨 → 그리기 전에 흰 바탕을 깖(화면 색이 아니라 사진 내용이라 토큰 아님)
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    for (const quality of QUALITIES) {
      const blob = await toBlob(canvas, quality);
      if (!blob) return { ok: false, error: "unreadable" };
      if (blob.size <= PHOTO_MAX_BYTES)
        return { ok: true, photo: { blob, contentType: "image/jpeg" } };
    }
    return { ok: false, error: "tooLarge" };
  } finally {
    bitmap.close();
  }
}
