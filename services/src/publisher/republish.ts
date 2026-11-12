import type { ManifestFile, StatusFile } from "@baradun/contracts";
import { SUPPORTED_POLICY_VERSIONS } from "@baradun/contracts/judgment-policy";
import { buildPublishSummary } from "../core/collect/publish-summary";
import { MANIFEST_SETTINGS, PUBLISH_POLICY } from "./policy";
import {
  FILES,
  KEYS,
  MANIFEST_PATH,
  WEATHER,
  manifestMayPointTo,
  newestVersion,
  parseManifest,
  removeOldVersions,
  replaceManifest,
  versionPath,
  withPublishLock,
  type PublishDeps,
  type PublishResult,
} from "./publish";
import { contractErrors, type ContractFile } from "./validate";

// 옛 게시 파일 다시 내보내기 (결정 기록 D20-4, 급할 때만 쓰는 도구. 쓰는 법은 infra/README)
// 게시 코드 오류는 git revert로 배포하는 것이 기준. 배포를 기다릴 수 없을 때 사람이 직접 부름(tools/republish)
// - 옛 버전 경로의 파일을 내용 그대로 새 버전 경로에 다시 올리고, 지금보다 큰 새 snapshotVersion의 manifest로 바꿈
//   (옛 manifest를 그대로 되살리면 열린 웹이 더 작은 버전이라 무시함, D20-1)
// - 파일 내용은 한 글자도 고치지 않음 → 관측·확인 시각이 그때 그대로라 시간이 지나면 웹이 '판단불가'로 보여줌
//   (옛 값을 지금 확인한 값처럼 보이게 하지 않음). manifest의 generatedAt도 그때 값 그대로
// - 일반 게시와 같은 게시 잠금·조건부 manifest 쓰기·계약 검사를 씀. 수집 일정을 멈추지 않으면 다음 자동 게시가 다시 덮음
// - 점검·최소 화면 버전은 데이터가 아니라 운영 설정 → 사본의 값이 아니라 지금 코드의 MANIFEST_SETTINGS를 씀
//   (점검 중에 써도 점검이 풀리지 않고, 올린 minWebBuild가 내려가지 않음. BRD-43 리뷰)
// - 공지는 사본에 실린 그대로. 되돌림 포인터는 건드리지 않음(공지를 되돌리는 것은 publishSnapshot의 되돌리기)
// 운영 화면에는 이 기능의 버튼을 두지 않음(D20-4)

export type RepublishDeps = Pick<
  PublishDeps,
  "ops" | "snapshots" | "log" | "clock" | "owner"
>;

export async function republishVersion(
  deps: RepublishDeps,
  from: string,
): Promise<PublishResult> {
  const { ops, snapshots, log } = deps;
  return withPublishLock(
    deps,
    "republish",
    from,
    async ({ startedMs, version, now }) => {
      const fail = (reason: string, fields: Record<string, unknown> = {}) => {
        log("error", "publish_failed", {
          version,
          reason,
          source: "republish",
          target: from,
          ...fields,
        });
        return { status: "failed", version, reason } as const;
      };

      let uploaded = false;
      try {
        const current = parseManifest(await snapshots.getFile(MANIFEST_PATH));
        const published = newestVersion(
          await ops.getPublishedVersion(),
          current?.snapshotVersion ?? null,
        );
        if (published !== null && version <= published) {
          return fail("version_not_newer", { published });
        }

        const old = parseManifest(
          await snapshots.getFile(versionPath(from, "manifest.json")),
        );
        if (old === null || old.snapshotVersion !== from) {
          return fail("manifest_missing");
        }
        // 웹은 지금 판단 정책만 읽음(D20-6) → 다른 정책으로 게시된 파일을 다시 내보내면 모두 판단불가가 됨
        if (!SUPPORTED_POLICY_VERSIONS.includes(old.policyVersion)) {
          return fail("policy_unsupported");
        }

        // 사본이 가리키는 파일이 그 버전 경로의 것인지 확인하고 읽음. 하나라도 없거나 다른 곳을 가리키면 멈춤
        const files: { name: string; contract: ContractFile; path: string }[] =
          [
            ...KEYS.map((key) => ({ ...FILES[key], path: old.files[key] })),
            ...(old.files.weather
              ? [{ ...WEATHER, path: old.files.weather }]
              : []),
          ];
        if (
          files.some((file) => file.path !== `/${versionPath(from, file.name)}`)
        ) {
          return fail("files_missing");
        }
        const bodies = await Promise.all(
          files.map((file) => snapshots.getFile(versionPath(from, file.name))),
        );
        if (bodies.some((body) => body === null)) return fail("files_missing");

        const manifest: ManifestFile = {
          ...old,
          snapshotVersion: version,
          maintenance: { ...MANIFEST_SETTINGS.maintenance },
          minWebBuild: MANIFEST_SETTINGS.minWebBuild,
          files: {
            beaches: `/${versionPath(version, FILES.beaches.name)}`,
            status: `/${versionPath(version, FILES.status.name)}`,
            history: `/${versionPath(version, FILES.history.name)}`,
            nationwideWarnings: `/${versionPath(version, FILES.nationwideWarnings.name)}`,
            ...(old.files.weather
              ? { weather: `/${versionPath(version, WEATHER.name)}` }
              : {}),
          },
        };
        // 일반 게시와 같은 계약 검사. 읽지 못하는 파일(JSON 아님)도 계약 오류로 봄
        const parsed = bodies.map((body) => {
          try {
            return JSON.parse(body!) as unknown;
          } catch {
            return undefined;
          }
        });
        const errors = [
          ...files.flatMap((file, i) =>
            contractErrors(file.contract, parsed[i]),
          ),
          ...contractErrors("ManifestFile", manifest),
        ];
        if (errors.length > 0) {
          return fail("contract", { errors: errors.slice(0, 20) });
        }

        uploaded = true;
        const versioned = PUBLISH_POLICY.cacheControl.versioned;
        const manifestBody = JSON.stringify(manifest);
        const settled = await Promise.allSettled([
          ...files.map((file, i) =>
            snapshots.putFile(
              versionPath(version, file.name),
              bodies[i]!,
              versioned,
            ),
          ),
          snapshots.putFile(
            versionPath(version, "manifest.json"),
            manifestBody,
            versioned,
          ),
        ]);
        const rejected = settled.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (rejected !== undefined) throw rejected.reason;

        const replaced = await replaceManifest(deps, version, manifestBody);
        if (!replaced.ok) {
          return replaced.reason === "version_not_newer"
            ? fail(replaced.reason, { published: replaced.published })
            : fail(replaced.reason);
        }
        uploaded = false;

        if (!(await ops.setPublishedVersion(version).catch(() => false))) {
          log("error", "publish_version_not_recorded", { version });
        }
        // 게시 요약: 분류는 옛 파일에 적힌 그대로 옮김(다시 판단하지 않음)
        // 공지 상태는 남기지 않음(그때 운영 DB 상태를 모름) → 이 버전은 되돌리기 대상이 아님
        try {
          const status = (parsed[KEYS.indexOf("status")] as StatusFile).beaches;
          await ops.putPublishSummary(
            buildPublishSummary({
              version,
              previous: published,
              publishedAt: now,
              beachCount: Object.keys(status).length,
              status,
              source: "republish",
              target: from,
            }),
            startedMs,
          );
        } catch (error) {
          log("warn", "publish_summary_not_recorded", {
            version,
            error: error instanceof Error ? error.name : typeof error,
          });
        }
        const removed = await removeOldVersions(snapshots, version, log);
        log("warn", "republish_finished", {
          version,
          target: from,
          removed: removed.length,
        });
        return { status: "published", version, removed };
      } catch (error) {
        return fail(
          `exception:${error instanceof Error ? error.name : typeof error}`,
        );
      } finally {
        if (uploaded && !(await manifestMayPointTo(snapshots, version))) {
          await snapshots.deleteVersion(version).catch(() => undefined);
        }
      }
    },
  );
}
