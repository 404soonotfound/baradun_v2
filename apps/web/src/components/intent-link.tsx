"use client";

import Link from "next/link";
import { useState, type ComponentProps } from "react";

type IntentLinkProps = Omit<ComponentProps<typeof Link>, "prefetch">;

// 해변 상세 링크: 누를 의도가 보일 때만 미리 받음 (GH-543)
// Next 기본값은 링크가 화면에 보이기만 해도 페이지·데이터를 미리 받음(링크 하나당 CloudFront 요청 약 3건).
// 해변이 많은 목록을 내리면 요청이 수백 건 생겨(탐색 목록 끝까지 369건, 2026-11-17 측정) 무료 한도를 빨리 씀.
// 마우스 올림·손가락 닿음·키보드 포커스 때 기본 미리 받기(null)로 바꿈. 누른 뒤 이동은 같음.
// 하단 탭·상단 탐색처럼 링크가 적은 곳은 이 부품을 쓰지 않고 기본 미리 받기를 유지함
export function IntentLink({
  onMouseEnter,
  onTouchStart,
  onFocus,
  ...props
}: IntentLinkProps) {
  const [intent, setIntent] = useState(false);
  return (
    <Link
      {...props}
      prefetch={intent ? null : false}
      onMouseEnter={(event) => {
        setIntent(true);
        onMouseEnter?.(event);
      }}
      onTouchStart={(event) => {
        setIntent(true);
        onTouchStart?.(event);
      }}
      onFocus={(event) => {
        setIntent(true);
        onFocus?.(event);
      }}
    />
  );
}
