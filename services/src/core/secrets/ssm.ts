import {
  GetParameterCommand,
  ListTagsForResourceCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import {
  ApiKeyMissingError,
  apiKeyParameterName,
  type ApiKeyName,
  type ApiKeys,
  type ApiKeyTags,
} from "./api-keys";

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

// 키 파라미터의 태그만 읽음(ListTagsForResource). 값을 돌려주는 GetParameter는 쓰지 않음
// 운영 API의 데이터 출처 화면이 씀. 권한도 태그 읽기만 받음(infra/lib/admin/ops-api.ts)
export class SsmApiKeyTags implements ApiKeyTags {
  constructor(private readonly client: ParameterSender) {}

  async tags(name: ApiKeyName, signal?: AbortSignal) {
    try {
      const result = await this.client.send(
        new ListTagsForResourceCommand({
          ResourceType: "Parameter",
          ResourceId: apiKeyParameterName(name),
        }),
        signal ? { abortSignal: signal } : {},
      );
      return result.TagList ?? [];
    } catch (error) {
      if ((error as { name?: string }).name === "InvalidResourceId") {
        throw new ApiKeyMissingError(name);
      }
      throw error;
    }
  }
}
