import { MapPinOff } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { Banner } from "@/components/ui/banner";
import { localizedPath, type Locale } from "@/lib/i18n";
import {
  locationBlocked,
  requestLocation,
  type LocationState,
} from "@/lib/location";

// '위치 없이 보고 있어요' 배너 (노션 2장 HOME '위치 거부 · 지역 고른 뒤', Figma S_M01_04 171:818)
// 회색 · 닫기 가능. '위치 정보 켜기':
//   아직 묻지 않은 기기(idle) → 그때 권한 창(사용자가 누른 것이라 반복 요청 아님)
//   받을 수 없음(시간 초과·기기 오류) → 거부가 아니라서 다시 시도
//   거부·설정에서 끔 → 다시 묻지 않고 설정 화면으로(위치 사용 스위치·브라우저 권한 안내, BRD-36)

// Vue: props: { locale, status } + this.$emit("close")
export function LocationOffBanner({
  locale,
  status,
  onClose,
  title,
  body,
}: {
  locale: Locale;
  status: LocationState["status"];
  onClose: () => void;
  // 지역을 고르지 않는 화면(탐색)은 제목·설명을 직접 줌. 없으면 홈 문구
  title?: string;
  body?: string;
}) {
  const t = useTranslations("home.region");
  const turnOn = !locationBlocked(status) ? (
    <button
      type="button"
      onClick={requestLocation}
      className="font-bold text-brand-default"
    >
      {t("turnOn")}
    </button>
  ) : (
    <Link
      href={localizedPath(locale, "/settings/")}
      className="font-bold text-brand-default"
    >
      {t("turnOn")}
    </Link>
  );
  return (
    <Banner
      tone="gray"
      icon={<MapPinOff size={16} />}
      title={title ?? t("offTitle")}
      action={turnOn}
      dismiss={{ label: t("close"), onClick: onClose }}
    >
      {body ?? t("offBody")}
    </Banner>
  );
}
