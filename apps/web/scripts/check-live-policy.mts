// 웹 배포 전 판단 정책 버전 확인 (결정 기록 D20-6·D20-7, #256)
// 웹은 지금 판단 정책 하나만 읽음 → 정책을 바꾼 PR은 publisher(deploy:infra)를 먼저 배포해야 함
// 운영 manifest의 policyVersion을 이 빌드가 읽지 못하면 배포를 멈춤(그대로 올리면 모든 화면이 판단불가)
// 사용: node scripts/check-live-policy.mts <사이트 주소>  (deploy.yml site 작업, 사이트 파일 올리기 전)
import { fileURLToPath } from "node:url";

import { SUPPORTED_POLICY_VERSIONS } from "@baradun/contracts/judgment-policy";

const TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

export type LiveCheck =
  { ok: true; note: string } | { ok: false; error: string };

// 운영 manifest 본문 → 판정. null: 게시본이 없음(404). 주소가 틀렸을 수도 있어 확인 못 한 것으로 봄
export function checkLivePolicy(
  manifest: unknown,
  supported: readonly string[] = SUPPORTED_POLICY_VERSIONS,
): LiveCheck {
  if (manifest === null) {
    return {
      ok: false,
      error:
        "운영 게시본(data/manifest.json)이 없어요. 사이트 주소(SITE_URL)를 확인하거나 publisher를 먼저 배포해 주세요(npm run deploy:infra).",
    };
  }
  const live =
    typeof manifest === "object" && manifest !== null
      ? (manifest as { policyVersion?: unknown }).policyVersion
      : undefined;
  if (typeof live !== "string") {
    return {
      ok: false,
      error:
        "운영 manifest에서 policyVersion을 읽지 못했어요. 게시본을 확인한 뒤 다시 실행해 주세요.",
    };
  }
  if (!supported.includes(live)) {
    return {
      ok: false,
      error:
        `운영 게시본의 판단 정책(${live})을 이 화면 빌드가 읽지 못해요(읽는 정책: ${supported.join(", ")}). ` +
        "publisher를 먼저 배포한 뒤(npm run deploy:infra) 이 배포를 다시 실행해 주세요(결정 기록 D20-7).",
    };
  }
  return { ok: true, note: `운영 게시본 판단 정책 ${live}: 이 빌드가 읽어요.` };
}

// 게시본 받기. 404면 아직 없음(null), 그 밖의 실패는 다시 시도 뒤 던짐(확인 못 하고 올리지 않음)
async function fetchManifest(site: string): Promise<unknown> {
  const url = `${site.replace(/\/$/, "")}/data/manifest.json`;
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as unknown;
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`${url}을 읽지 못했어요: ${String(last)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const site = process.argv[2];
  if (!site) {
    console.error("사용법: node scripts/check-live-policy.mts <사이트 주소>");
    process.exit(1);
  }
  try {
    const result = checkLivePolicy(await fetchManifest(site));
    if (result.ok) {
      console.log(result.note);
    } else {
      console.error(`::error::${result.error}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(
      `::error::${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
