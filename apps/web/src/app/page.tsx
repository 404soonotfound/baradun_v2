import { ArrowRight, MapPin, ShieldCheck, Waves } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";

const decisionStates = [
  {
    label: "입수 가능성 높음",
    tone: "available" as const,
    description: "공식 통제가 없고 현재 관측 조건이 비교적 안정적입니다.",
  },
  {
    label: "주의 필요",
    tone: "caution" as const,
    description: "일부 관측 조건을 반드시 확인하고 현장 안내를 따르세요.",
  },
  {
    label: "이용불가",
    tone: "unavailable" as const,
    description: "공식 통제 또는 운영 중단 정보가 확인되었습니다.",
  },
  {
    label: "판단불가",
    tone: "unknown" as const,
    description: "판단에 필요한 최신 데이터가 충분하지 않습니다.",
  },
];

export default function Home() {
  return (
    <main>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero__ambient" aria-hidden="true" />
        <div className="shell hero__content">
          <div className="brand-lockup">
            <span className="brand-lockup__mark" aria-hidden="true">
              <Waves size={22} strokeWidth={2.2} />
            </span>
            <span>바라던 바다</span>
          </div>

          <div className="hero__copy">
            <p className="eyebrow">현재 관측 기준 · 최종 판단은 현장 안내 우선</p>
            <h1 id="hero-title">오늘, 어디서 수영할 수 있을까요?</h1>
            <p className="hero__description">
              지역을 입력하면 공식 통제 정보와 해양 관측 데이터를 함께 살펴보고
              바다수영 판단에 필요한 근거를 정리해 드립니다.
            </p>
          </div>

          <form className="region-search" action="/" role="search">
            <MapPin aria-hidden="true" size={20} />
            <label className="sr-only" htmlFor="region">
              지역 또는 해변 이름
            </label>
            <input
              id="region"
              name="region"
              placeholder="예: 제주, 강릉, 송정해수욕장"
              type="search"
            />
            <Button type="submit">
              바다 찾기
              <ArrowRight aria-hidden="true" size={18} />
            </Button>
          </form>

          <p className="hero__helper">
            <ShieldCheck aria-hidden="true" size={17} />
            안전을 보장하지 않습니다. 현재 현장 통제와 안전요원의 안내를 먼저
            확인하세요.
          </p>
        </div>
      </section>

      <section className="shell decision-section" aria-labelledby="decision-title">
        <div className="section-heading">
          <p className="eyebrow">판단 상태 체계</p>
          <h2 id="decision-title">한눈에 이해하고, 근거까지 확인합니다</h2>
          <p>
            브랜드 색상과 안전 상태 색상을 분리해 중요한 판단 신호가 장식에
            묻히지 않도록 설계했습니다.
          </p>
        </div>

        <div className="decision-grid">
          {decisionStates.map((state) => (
            <article className="decision-card" key={state.label}>
              <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
              <p>{state.description}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
