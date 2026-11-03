import { LoginFlow } from "@/components/login-flow";

// 운영자 로그인 (ADM-LOGIN, 캔버스 V26·V27·V28)
export default function LoginPage() {
  return <LoginFlow pool="operator" />;
}
