import { messages } from "@/lib/messages";

// 운영자 사이트 첫 화면 자리(BRD-147). 로그인·운영 홈은 BRD-148·149에서 붙임
export default function Home() {
  const t = messages.home;
  return (
    <main>
      <h1>{t.heading}</h1>
      <p>{t.preparing}</p>
      <p>{t.noData}</p>
    </main>
  );
}
