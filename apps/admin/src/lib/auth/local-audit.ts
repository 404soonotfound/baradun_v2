import type { AuditView } from "../audit";
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
      action: "notice.expose",
      target: { kind: "notice", id: "n-local-live" },
      changes: ["endsAt"],
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
      action: "notice.update",
      target: { kind: "notice", id: "n-local-draft" },
      changes: ["title", "body"],
    },
    {
      ...base(50, SUBS[0]!, "publisher"),
      action: "notice.delete",
      target: { kind: "notice", id: "n-local-old" },
      changes: ["deletedAt"],
    },
  ];
}

export function localAudit<T>(query: URLSearchParams): OpsResult<T> {
  const now = Date.now();
  const action = query.get("action");
  const actor = query.get("actor");
  const from =
    query.get("from") ?? new Date(now - 30 * 86_400_000).toISOString();
  const to = query.get("to") ?? new Date(now).toISOString();
  const items = examples(now).filter(
    (e) =>
      (!action || e.action === action) &&
      (!actor || e.actorSub === actor) &&
      e.at >= from &&
      e.at <= to,
  );
  return {
    ok: true,
    status: 200,
    body: {
      filter: {
        from,
        to,
        ...(action ? { action } : {}),
        ...(actor ? { actor } : {}),
      },
      items,
      nextCursor: null,
    } as T,
  };
}
