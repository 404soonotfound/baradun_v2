import { PreparingScreen } from "@/components/preparing-screen";
import { messages } from "@/lib/messages";

// 화면 자리 (BRD-171). 화면 설계서 6장 화면 목록의 경로
export default function Page() {
  return <PreparingScreen title={messages.nav.notices} />;
}
