import type { Metadata, MetadataRoute } from "next";

// 앱 아이콘 (BRD-106 결정 28). 원본은 assets/icons/*.svg, 파일은 scripts/build-icons.mts가 public/에 만듦
// 매니페스트(app/manifest.ts)와 두 루트 레이아웃·전역 404의 <head>가 같이 씀. 경로·크기는 scripts/icons.test.ts가 실제 파일과 맞춰 봄

// 설치 아이콘: any(둥근 판) 192·512 + maskable(가장자리까지 채움) 512. 용도를 섞지 않고 따로 적음
export const MANIFEST_ICONS: NonNullable<MetadataRoute.Manifest["icons"]> = [
  {
    src: "/icons/icon-192.png",
    sizes: "192x192",
    type: "image/png",
    purpose: "any",
  },
  {
    src: "/icons/icon-512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "any",
  },
  {
    src: "/icons/icon-maskable-512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "maskable",
  },
];

// 브라우저 탭(favicon.ico, 16·32·48)·iOS 홈 화면(Apple touch 180, 불투명)
export const HEAD_ICONS: NonNullable<Metadata["icons"]> = {
  icon: [{ url: "/favicon.ico", sizes: "16x16 32x32 48x48" }],
  apple: [
    { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
  ],
};
