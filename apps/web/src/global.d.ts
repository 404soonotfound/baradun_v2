import type { Locale } from "@/lib/i18n";
import type messages from "../messages/ko.json";

// 문구 키 타입: ko.json에 없는 키를 쓰면 타입 검사에서 막힘 (BRD-22)
// en.json의 키가 같은지는 scripts/check-messages.mjs가 확인함.
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof messages;
  }
}
