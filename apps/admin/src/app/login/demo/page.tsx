import { LoginFlow } from "@/components/login-flow";

// 데모 계정 로그인 (결정 기록 D17-2). 초대한 사람에게만 알려 주는 주소. 다른 화면에서 이 주소로 가는 링크를 두지 않음
export default function DemoLoginPage() {
  return <LoginFlow pool="demo" />;
}
