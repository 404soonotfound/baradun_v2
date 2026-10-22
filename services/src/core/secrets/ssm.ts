import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { apiKeyParameterName, type ApiKeyName, type ApiKeys } from "./api-keys";

// SSM Parameter Store SecureString 읽기 (아키텍처 11장: Standard, 기본 키)
// Lambda 실행 환경이 살아 있는 동안 한 번 읽은 값을 다시 씀(호출 수·지연 줄임)

// send만 쓰므로 그 모양만 받음 → 테스트가 가짜 클라이언트를 넘김
type ParameterSender = Pick<SSMClient, "send">;

export class SsmApiKeys implements ApiKeys {
  private readonly cache = new Map<ApiKeyName, Promise<string>>();

  constructor(private readonly client: ParameterSender) {}

  get(name: ApiKeyName): Promise<string> {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const loading = this.load(name);
    this.cache.set(name, loading);
    // 실패한 읽기는 남기지 않음 → 다음 호출에서 다시 읽음
    loading.catch(() => this.cache.delete(name));
    return loading;
  }

  private async load(name: ApiKeyName): Promise<string> {
    const result = await this.client.send(
      new GetParameterCommand({
        Name: apiKeyParameterName(name),
        WithDecryption: true,
      }),
    );
    const value = result.Parameter?.Value;
    if (value === undefined || value.trim() === "") {
      // 키 이름만 적음. 값은 오류 메시지에 넣지 않음
      throw new Error(`API 키 없음: ${name}`);
    }
    return value.trim();
  }
}
