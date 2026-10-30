"use client";

import type { Beach } from "@baradun/contracts";
import { Ellipsis, Link2, MessageSquare, Share2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { BeachPhoto } from "@/components/map/beach-photo";
import { Sheet } from "@/components/ui/sheet";
import { Toast, useToast } from "@/components/ui/toast";
import type { Locale } from "@/lib/i18n";
import { copyText, shareUrl, shareWithDevice, smsHref } from "@/lib/share";
import { useSheet } from "@/lib/use-sheet";

// 상세 머리의 공유 버튼 → 공유 시트 (BRD-34 · 노션 2장 SHARE, Figma L10)
// 시트: 링크 미리보기(해변 이름·지역·사진만, 상태 없음 10/16) + 링크 복사 · 메시지 · 더보기(기기 공유 창)
// 복사하면 시트를 닫고 토스트 "링크를 복사했어요"(시트가 열려 있으면 토스트가 대화상자 뒤에 가려짐)
// 더보기는 기기 공유 창이 있는 브라우저에서만 보임. 공유 창이 실패하면 링크 복사로 대신함, 닫으면 그대로 둠
// 클립보드가 막히면 시트를 열어 둔 채 오류 문구 + 링크 칸을 골라 직접 복사하게 함
// 모바일·PC 같은 머리에 있어 두 화면 모두에서 공유할 수 있음

const noSubscribe = () => () => {};
// 서버 렌더(정적 HTML)에는 주소·공유 창 정보가 없음 → null·false, 브라우저에서 다시 그림
const readOrigin = () => window.location.origin;
const readCanShare = () => typeof navigator.share === "function";

export function ShareButton({
  locale,
  beach,
}: {
  locale: Locale;
  beach: Pick<Beach, "slug" | "name" | "region" | "photo">;
}) {
  const t = useTranslations("share");
  const sheet = useSheet("share");
  const toast = useToast();
  const linkRef = useRef<HTMLInputElement>(null);
  const linkId = useId();
  const errorId = useId();
  const [copyFailed, setCopyFailed] = useState(false);
  const sharing = useRef(false); // 기기 공유 창이 열려 있는 동안 true
  const origin = useSyncExternalStore(noSubscribe, readOrigin, () => null);
  const canShare = useSyncExternalStore(noSubscribe, readCanShare, () => false);

  const name = beach.name[locale];
  const region = `${beach.region.sido[locale]} ${beach.region.sigungu[locale]}`;
  const url = origin ? shareUrl(origin, locale, beach.slug) : null;

  function open() {
    setCopyFailed(false);
    sheet.show();
  }

  async function copy(link: string) {
    const result = await copyText(navigator.clipboard, link);
    if (result === "copied") {
      setCopyFailed(false);
      sheet.close();
      toast.show({ text: t("copied") });
      return;
    }
    // 복사 실패: 링크 칸을 골라 둠(선택해 직접 복사)
    setCopyFailed(true);
    linkRef.current?.focus();
    linkRef.current?.select();
  }

  async function shareMore(link: string) {
    // 공유 창이 열린 동안 다시 누르면 브라우저가 오류를 내므로 무시함(버튼을 끄면 포커스를 잃어서 끄지 않음)
    if (sharing.current) return;
    sharing.current = true;
    try {
      const result = await shareWithDevice(navigator, {
        title: name,
        url: link,
      });
      if (result === "shared") sheet.close();
      else if (result === "unsupported" || result === "failed")
        await copy(link);
      // cancelled: 사용자가 닫음 → 시트 그대로
    } finally {
      sharing.current = false;
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-haspopup="dialog"
        aria-label={t("button")}
        // 모바일: 44px 아이콘(Figma 아이콘 버튼), PC(lg): 테두리 칩 '공유'(Figma 183:795)
        className="flex size-touch shrink-0 items-center justify-center rounded-full hover:bg-bg-subtle lg:h-9 lg:w-auto lg:gap-[5px] lg:border lg:border-border-strong lg:bg-bg-surface lg:px-[13px] lg:text-[13.5px] lg:font-medium lg:text-text-body"
      >
        <Share2 aria-hidden="true" size={15} />
        <span className="hidden lg:inline">{t("button")}</span>
      </button>
      <Sheet open={sheet.open} onClose={sheet.close} title={t("title")}>
        <div className="flex flex-col gap-4 pb-2">
          {/* 링크 미리보기: 이름·지역·사진만. 기본 테두리·모서리 12 카드, 아래 줄 13 굵게 + 11.5 메타 (Figma 187:338) */}
          <div className="flex flex-col gap-2 rounded-input border border-border-default p-3">
            <BeachPhoto photo={beach.photo} name={name} className="h-[150px]" />
            <div>
              <p className="text-body-s font-bold text-text-default">{name}</p>
              <p className="text-label-xs text-text-muted">{region}</p>
            </div>
          </div>

          {url ? (
            <>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor={linkId}
                  className="text-caption text-text-muted"
                >
                  {t("linkLabel")}
                </label>
                <input
                  id={linkId}
                  ref={linkRef}
                  readOnly
                  value={url}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-describedby={copyFailed ? errorId : undefined}
                  className="h-touch w-full rounded-input border border-border-strong bg-bg-subtle px-3 text-body-s text-text-default"
                />
                <p className="text-caption text-text-muted">{t("note")}</p>
                {copyFailed && (
                  <p
                    id={errorId}
                    role="alert"
                    className="text-body-s text-danger-text"
                  >
                    {t("copyFailed")}
                  </p>
                )}
              </div>

              {/* 행동 3칸(사이 10): 보조 면 상자 52·모서리 16 + 아이콘 22, 아래 12.5 이름 (Figma 187:348) */}
              <div className="grid auto-cols-fr grid-flow-col gap-2.5">
                <ShareAction
                  icon={<Link2 size={22} />}
                  label={t("copy")}
                  onClick={() => void copy(url)}
                />
                <a
                  href={smsHref(t("messageBody", { name, url }))}
                  className={ACTION_CLASS}
                >
                  <ActionIcon icon={<MessageSquare size={22} />} />
                  {t("message")}
                </a>
                {canShare && (
                  <ShareAction
                    icon={<Ellipsis size={22} />}
                    label={t("more")}
                    onClick={() => void shareMore(url)}
                  />
                )}
              </div>
            </>
          ) : (
            <p className="text-body-s text-text-body">{t("unavailable")}</p>
          )}
        </div>
      </Sheet>
      <Toast message={toast.message} onHold={toast.hold} />
    </>
  );
}

// 누르는 영역은 칸 전체(상자 + 이름). 눌림·포커스 표시는 칸 모서리를 따름
const ACTION_CLASS =
  "group flex flex-col items-center gap-1.5 rounded-tile text-label-s text-text-default";

function ActionIcon({ icon }: { icon: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-[52px] items-center justify-center rounded-tile bg-bg-subtle text-brand-default group-hover:bg-brand-weak"
    >
      {icon}
    </span>
  );
}

function ShareAction({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className={ACTION_CLASS}>
      <ActionIcon icon={icon} />
      {label}
    </button>
  );
}
