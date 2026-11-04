import { AUDIT_CATEGORIES, categoryOf, type AuditView } from "../audit";
import type { OpsResult } from "./ops-fetch";

// 로컬 테스트 로그인용 예시 변경 이력 (BRD-155). local-dev.ts가 불러와 개발 서버에서만 씀(배포 빌드에서 빠짐)
// 거르기(종류·운영자)만 흉내 냄. 쪽 넘기기는 한 쪽으로 끝

const SUBS = [
  "11111111-aaaa-4bbb-8ccc-000000000001",
  "22222222-aaaa-4bbb-8ccc-000000000002",
];

function examples(now: number): AuditView[] {
  const at = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  const base = (n: number, sub: string, role: string) => ({
    at: at(n),
    actorSub: sub,
    actorKind: "operator" as const,
    role,
    requestId: `req-local${String(n).padStart(3, "0")}`,
  });
  return [
    {
      ...base(1, SUBS[0]!, "publisher"),
      action: "notice.update",
      target: { kind: "notice", id: "n-local-live" },
      targetLabel: "(로컬 예시) 새벽 점검 예고",
      changes: ["title"],
      notice: {
        before: {
          kind: "maintenance_notice",
          title: { ko: "(로컬 예시) 새벽 점검 예고", en: "" },
          body: { ko: "새벽 2시~4시에 늦게 바뀔 수 있어요.", en: "" },
          startsAt: at(3),
          endsAt: at(-20),
        },
        after: {
          kind: "maintenance_notice",
          title: {
            ko: "(로컬 예시) 새벽 점검 예고",
            en: "(Local) Planned maintenance",
          },
          body: {
            ko: "새벽 2시~4시에 늦게 바뀔 수 있어요.",
            en: "Updates may be late from 2 to 4 a.m.",
          },
          startsAt: at(3),
          endsAt: at(-20),
        },
      },
    },
    {
      ...base(2, SUBS[1]!, "editor"),
      action: "inquiry.update",
      target: { kind: "inquiry", id: "00000000-0000-4000-8000-000000000001" },
      changes: ["status", "memo"],
      statusFrom: "received",
      statusTo: "in_progress",
    },
    {
      ...base(5, SUBS[1]!, "editor"),
      action: "inquiry.update",
      target: { kind: "inquiry", id: "00000000-0000-4000-8000-000000000005" },
      changes: ["message"],
    },
    {
      ...base(30, SUBS[0]!, "publisher"),
      action: "notice.create",
      target: { kind: "notice", id: "n-local-draft" },
      targetLabel: "(로컬 예시) 영어 문구를 아직 안 씀",
      changes: ["kind", "title", "body", "startsAt", "endsAt"],
    },
    {
      ...base(50, SUBS[0]!, "publisher"),
      action: "notice.delete",
      target: { kind: "notice", id: "n-local-old" },
      targetLabel: "(로컬 예시) 지난 안내",
      changes: ["deletedAt"],
    },
  ];
}

export function localAudit<T>(query: URLSearchParams): OpsResult<T> {
  const now = Date.now();
  const category = query.get("category");
  const actor = query.get("actor");
  const q = query.get("q");
  const from =
    query.get("from") ?? new Date(now - 30 * 86_400_000).toISOString();
  const to = query.get("to") ?? new Date(now).toISOString();
  const base = examples(now).filter(
    (e) =>
      (!actor || e.actorSub === actor) &&
      (!q || (e.targetLabel ?? "").includes(q) || e.target.id.includes(q)) &&
      e.at >= from &&
      e.at <= to,
  );
  const counts = Object.fromEntries([
    ["all", base.length],
    ...AUDIT_CATEGORIES.map((c) => [
      c,
      base.filter((e) => categoryOf(e.action) === c).length,
    ]),
  ]);
  return {
    ok: true,
    status: 200,
    body: {
      filter: { from, to },
      items: base.filter((e) => !category || categoryOf(e.action) === category),
      nextCursor: null,
      ...(query.get("cursor") ? {} : { counts }),
    } as T,
  };
}
