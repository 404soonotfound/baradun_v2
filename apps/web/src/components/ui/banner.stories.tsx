import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Clock, MapPin, RefreshCw, WifiOff } from "lucide-react";

import { Banner } from "./banner";

// 알림 배너 확인용 (BRD-81 · 개발 전용 Storybook). Figma '알림 배너 · 새'(170:2924) 다섯 가지와 같은 모양
// 실제 문구는 화면 이슈에서 문구 키로 넣음. 여기 글자는 모양 확인용 예시
const meta = {
  title: "UI/Banner",
  component: Banner,
} satisfies Meta<typeof Banner>;

export default meta;
type Story = StoryObj<typeof meta>;

const link = (
  <button type="button" className="underline">
    다시 시도
  </button>
);

export const AllTones: Story = {
  args: { tone: "amber", icon: null, title: "" },
  render: () => (
    <div style={{ display: "grid", gap: 16, padding: 16, maxWidth: 390 }}>
      <Banner
        tone="amber"
        icon={<Clock size={18} />}
        title="망상해수욕장은 지금 판단할 수 없어요"
        href="#"
      >
        11:20 이후 측정값이 들어오지 않아요
      </Banner>
      <Banner
        tone="gray"
        icon={<WifiOff size={18} />}
        title="인터넷에 연결되어 있지 않아요"
      >
        14:30에 받은 정보예요 · 특보 상태는 표시하지 않아요
      </Banner>
      <Banner
        tone="red"
        icon={<RefreshCw size={18} />}
        title="새 정보를 불러오지 못했어요"
        action={link}
      >
        14:30 정보를 보여주고 있어요
      </Banner>
      <Banner
        tone="gray"
        icon={<MapPin size={18} />}
        title="위치 권한이 꺼져 있어요"
        action={
          <button type="button" className="underline">
            위치 정보 켜기
          </button>
        }
      >
        거리 없이 이름 순으로 보여드려요
      </Banner>
      <Banner tone="red" icon={<WifiOff size={18} />} title="보내지 못했어요">
        인터넷 연결을 확인하고 다시 보내 주세요. 유형과 내용은 남겨 두었어요.
        이메일은 다시 입력해 주세요.
      </Banner>
    </div>
  ),
};
