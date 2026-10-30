import { MapPinOff } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import {
  LocationRetryButton,
  useLocationRetryMessage,
} from "@/components/location-retry";
import { Banner } from "@/components/ui/banner";
import { localizedPath, type Locale } from "@/lib/i18n";
import { requestLocation, type LocationState } from "@/lib/location";

// '위치 없이 보고 있어요' 배너 (노션 2장 HOME '위치 거부 · 지역 고른 뒤', Figma S_M01_04 171:818)
// 회색 · 닫기 가능. 행동:
//   아직 묻지 않은 기기(idle) → '위치 정보 켜기'로 그때 권한 창(사용자가 누른 것이라 반복 요청 아님)
//   받을 수 없음(시간 초과·기기 오류) → 거부가 아니라서 '위치 정보 켜기'로 다시 요청
//   거부 → '다시 시도'로 브라우저에 한 번 더 요청(BRD-139). 또 거부면 설명 자리에 기기별 설정 경로
//   설정에서 끔 → 묻지 않고 설정 화면으로(위치 사용 스위치, BRD-36)

// Vue: props: { locale, location } + this.$emit("close")
export function LocationOffBanner({
  locale,
  location,
  onClose,
  title,
  body,
  withIcon = true,
}: {
  locale: Locale;
  location: LocationState;
  onClose: () => void;
  // 지역을 고르지 않는 화면(탐색)은 제목·설명을 직접 줌. 없으면 홈 문구
  title?: string;
  body?: string;
  // 홈은 아이콘 없이 글자만(Figma 171:818, BRD-129). 탐색은 그대로
  withIcon?: boolean;
}) {
  const t = useTranslations("home.region");
  const retryMessage = useLocationRetryMessage(location);
  const action =
    location.status === "denied" ? (
      <LocationRetryButton state={location} />
    ) : location.status === "off" ? (
      <Link
        href={localizedPath(locale, "/settings/")}
        className="font-bold text-brand-default"
      >
        {t("turnOn")}
      </Link>
    ) : (
      <button
        type="button"
        onClick={requestLocation}
        className="font-bold text-brand-default"
      >
        {t("turnOn")}
      </button>
    );
  return (
    <Banner
      tone="gray"
      icon={withIcon ? <MapPinOff size={16} /> : undefined}
      title={title ?? t("offTitle")}
      action={action}
      dismiss={{ label: t("close"), onClick: onClose }}
    >
      {retryMessage ?? body ?? t("offBody")}
    </Banner>
  );
}
