import {
  GetParameterCommand,
  ListTagsForResourceCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { parseUtcIso } from "../core/warnings/time";
import { SiteDeployError } from "./site-deploy-github";

const TOKEN_TTL_MS = 10 * 60_000;

export function createSiteDeployCredential(
  client: Pick<SSMClient, "send">,
  name: string,
  now: () => Date,
) {
  let saved: { value: string; until: number } | undefined;
  return {
    async token(signal: AbortSignal): Promise<string> {
      if (saved && saved.until > now().getTime()) return saved.value;
      const result = await client
        .send(new GetParameterCommand({ Name: name, WithDecryption: true }), {
          abortSignal: signal,
        })
        .catch((error: unknown) => {
          if (signal.aborted) throw new SiteDeployError("timeout");
          throw new SiteDeployError(
            error instanceof Error && error.name === "ParameterNotFound"
              ? "credential_missing"
              : "credentials",
          );
        });
      const value = result.Parameter?.Value;
      if (
        !value ||
        result.Parameter?.Type !== "SecureString" ||
        !/^\S+$/.test(value)
      ) {
        throw new SiteDeployError("credentials");
      }
      saved = { value, until: now().getTime() + TOKEN_TTL_MS };
      return value;
    },
    async expiry(signal: AbortSignal): Promise<string | null> {
      const result = await client
        .send(
          new ListTagsForResourceCommand({
            ResourceType: "Parameter",
            ResourceId: name,
          }),
          { abortSignal: signal },
        )
        .catch((error: unknown) => {
          if (signal.aborted) throw new SiteDeployError("timeout");
          throw new SiteDeployError(
            error instanceof Error && error.name === "InvalidResourceId"
              ? "credential_missing"
              : "credentials",
          );
        });
      const value = result.TagList?.find((tag) => tag.Key === "expires")?.Value;
      if (value === undefined) return null;
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        parseUtcIso(`${value}T00:00:00Z`) === null
      ) {
        throw new SiteDeployError("invalid");
      }
      return value;
    },
  };
}
