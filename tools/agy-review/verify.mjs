// BRD-174 agy 대체 리뷰 판정(순수 함수): stream-json 기록·구조화 응답 → 완료 여부와 사유
// 실패 쪽으로 닫음: 모르는 종료 사유·빈 응답·기록 누락은 모두 '리뷰 미완료'
// 기록 형식은 agy 1.4.12 stream-json(init·step_update·result 이벤트)에서 확인한 것
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");

export const PERMISSION_MODE = "request-review";
// 읽기 외 도구가 성공하면 거부 설정이 뚫린 것으로 봄
const WRITE_OR_EXEC =
  /write|edit|replace|delete|move|run_command|execute|browser|mcp|ask_/i;

// ajv는 packages/contracts 설치본만 사용(새로 설치하지 않음)
export function createValidator(schemaPath = join(HERE, "schema.json")) {
  const req = createRequire(join(ROOT, "packages/contracts/package.json"));
  const Ajv2020 = req("ajv/dist/2020.js").default ?? req("ajv/dist/2020.js");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
  return (value) =>
    validate(value)
      ? []
      : validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}`);
}

// 한 줄에 이벤트 하나. 읽지 못한 줄은 버리지 않고 오류로 남김
export function parseEvents(text) {
  const events = [];
  const errors = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line));
    } catch {
      errors.push(`stream-json ${i + 1}번째 줄을 읽지 못함`);
    }
  });
  return { events, errors };
}

// 도구 단계는 ACTIVE→DONE/ERROR로 여러 번 오므로 step_index별 마지막 상태만 씀
export function toolSteps(events) {
  const byIndex = new Map();
  for (const e of events) {
    const s = e.event === "step_update" ? e.step_update : null;
    if (!s || s.step_type !== "tool") continue;
    byIndex.set(s.step_index, s);
  }
  return [...byIndex.values()].map((s) => ({
    tool: s.tool_name,
    state: s.state,
    path: s.tool_info?.parameters?.Path ?? null,
    command: s.tool_info?.parameters?.CommandLine ?? null,
    error: s.tool_info?.error?.message ?? null,
  }));
}

function checkInit(events, expected, reasons) {
  const init = events.find((e) => e.event === "init")?.init;
  if (!init) return reasons.push("시작 정보(init) 없음");
  if (init.model !== expected.model)
    reasons.push(`모델 불일치: ${init.model} (기대 ${expected.model})`);
  if (init.permission_mode !== PERMISSION_MODE)
    reasons.push(
      `권한 모드 불일치: ${init.permission_mode} (기대 ${PERMISSION_MODE})`,
    );
  if (init.cwd !== expected.cwd)
    reasons.push(`작업 폴더 불일치: ${init.cwd} (기대 ${expected.cwd})`);
}

function checkResult(exitCode, events, reasons) {
  if (exitCode !== 0) reasons.push(`agy 종료 코드 ${exitCode}`);
  const result = events.findLast((e) => e.event === "result")?.result;
  if (!result) {
    reasons.push("결과 이벤트(result) 없음");
    return null;
  }
  if (result.status !== "SUCCESS")
    reasons.push(`agy 상태 ${result.status}: ${result.error ?? "사유 없음"}`);
  // 시간 초과도 SUCCESS·종료 코드 0으로 오고 finished_reason만 다름(print_timeout)
  if (result.finished_reason != null)
    reasons.push(`종료 사유 ${result.finished_reason}`);
  if (result.error) reasons.push(`agy 오류: ${result.error}`);
  return result;
}

// 거부 시험: 쓰기·명령이 모두 deny 규칙으로 거부되고 사본이 그대로여야 통과
export function verifyProbe({ exitCode, text, expected, snapshotUnchanged }) {
  const reasons = [];
  const { events, errors } = parseEvents(text);
  reasons.push(...errors);
  checkInit(events, expected, reasons);
  const result = events.findLast((e) => e.event === "result")?.result;
  if (exitCode !== 0) reasons.push(`agy 종료 코드 ${exitCode}`);
  if (!result) reasons.push("결과 이벤트(result) 없음");
  else if (result.status !== "SUCCESS")
    reasons.push(`agy 상태 ${result.status}: ${result.error ?? "사유 없음"}`);
  const steps = toolSteps(events);
  const denied = (kind) =>
    steps.some(
      (s) =>
        s.state === "ERROR" &&
        s.error?.includes(`Permission denied for ${kind}(`) &&
        /deny rule/.test(s.error),
    );
  if (!denied("write_file"))
    reasons.push("파일 쓰기가 deny 규칙으로 거부된 기록 없음");
  if (!denied("command"))
    reasons.push("명령 실행이 deny 규칙으로 거부된 기록 없음");
  for (const s of steps.filter(
    (s) => s.state === "DONE" && WRITE_OR_EXEC.test(s.tool),
  ))
    reasons.push(`쓰기·실행 도구가 성공함: ${s.tool}`);
  if (!snapshotUnchanged) reasons.push("거부 시험 뒤 사본 내용이 바뀜");
  return { ok: reasons.length === 0, reasons };
}

export function sensitiveOf(files, prefixes) {
  return files.filter((f) => prefixes.some((p) => f === p || f.startsWith(p)));
}

/**
 * 리뷰 판정
 * expected: { model, cwd, baseSha, headSha, scope, requiredFiles, diffFiles, sensitivePrefixes, evidenceCount }
 * - requiredFiles: 이번 범위에서 반드시 검토해야 하는 파일(전체면 base..head, 증분이면 이전 head..head)
 * - diffFiles: 프롬프트로 넘긴 전체 diff의 파일. 그 밖의 파일은 사본에서 읽은 기록이 있어야 검토로 인정
 */
export function verifyReview({ exitCode, text, expected, validate }) {
  const reasons = [];
  const { events, errors } = parseEvents(text);
  reasons.push(...errors);
  checkInit(events, expected, reasons);
  const result = checkResult(exitCode, events, reasons);
  const steps = toolSteps(events);
  const reads = steps
    .filter((s) => s.state === "DONE" && s.path)
    .map((s) => s.path);

  const prefix = expected.cwd.endsWith("/") ? expected.cwd : `${expected.cwd}/`;
  // 사본 안에서 없는 경로를 짐작해 읽은 것은 거부가 아니라 탐색이라 참고로만 남김(2026-11-04 실제 리뷰에서 확인)
  const notes = [];
  const missingInSnapshot = (s) =>
    !WRITE_OR_EXEC.test(s.tool) &&
    s.path?.startsWith(prefix) &&
    /does not exist/i.test(s.error ?? "") &&
    !/permission|denied/i.test(s.error ?? "");
  for (const s of steps.filter((s) => s.state === "ERROR")) {
    if (missingInSnapshot(s))
      notes.push(`없는 파일을 읽으려 함: ${s.path.slice(prefix.length)}`);
    else
      reasons.push(`리뷰 중 도구 거부·오류: ${s.tool} ${s.error ?? ""}`.trim());
  }
  for (const s of steps.filter(
    (s) => s.state === "DONE" && WRITE_OR_EXEC.test(s.tool),
  ))
    reasons.push(`쓰기·실행 도구가 성공함: ${s.tool}`);
  for (const p of reads.filter((p) => !p.startsWith(prefix)))
    reasons.push(`사본 밖 파일을 읽음: ${p}`);

  let review = null;
  const response = result?.response ?? "";
  if (result && !response.trim()) reasons.push("응답이 비어 있음");
  else if (result) {
    try {
      review = JSON.parse(response);
    } catch {
      reasons.push("응답이 JSON이 아님");
    }
  }
  if (review) {
    const schemaErrors = validate(review);
    if (schemaErrors.length) {
      reasons.push(...schemaErrors.map((e) => `스키마 위반: ${e}`));
      review = null;
    }
  }
  if (review) {
    if (review.base_sha !== expected.baseSha)
      reasons.push(`base SHA 불일치: ${review.base_sha}`);
    if (review.head_sha !== expected.headSha)
      reasons.push(`head SHA 불일치: ${review.head_sha}`);
    if (review.scope !== expected.scope)
      reasons.push(`범위 불일치: ${review.scope} (기대 ${expected.scope})`);
    const reviewed = new Set(review.reviewed_files);
    const notReviewed = new Set(review.not_reviewed_files);
    for (const f of expected.requiredFiles.filter((f) => !reviewed.has(f)))
      reasons.push(`검토 누락: ${f}`);
    for (const f of review.reviewed_files.filter((f) => notReviewed.has(f)))
      reasons.push(`검토·미검토에 함께 있음: ${f}`);
    const diffFiles = new Set(expected.diffFiles);
    const readSet = new Set(reads);
    for (const f of review.reviewed_files.filter(
      (f) => !diffFiles.has(f) && !readSet.has(join(expected.cwd, f)),
    ))
      reasons.push(`읽은 기록 없는 주변 파일: ${f}`);
    for (const f of sensitiveOf(
      review.not_reviewed_files,
      expected.sensitivePrefixes,
    ))
      reasons.push(`민감 파일 미검토: ${f}`);
  }

  // 노션 근거: 민감 경로가 바뀌었는데 근거가 없으면 기준 문서 대조 미완료(코드 리뷰 판정과 따로 표시)
  const sensitiveChanged = sensitiveOf(
    expected.diffFiles,
    expected.sensitivePrefixes,
  );
  const notion =
    sensitiveChanged.length === 0
      ? {
          status: expected.evidenceCount ? "제공" : "해당 없음",
          sensitiveChanged,
        }
      : {
          status: expected.evidenceCount ? "제공" : "미완료",
          sensitiveChanged,
        };

  const limits = [];
  if (/flash/i.test(expected.model))
    limits.push(
      `Flash 모델(${expected.model})로 검토함: 깊은 추론이 필요한 결함을 놓칠 수 있음`,
    );

  return {
    complete: reasons.length === 0,
    reasons,
    notes,
    review,
    notion,
    limits,
    toolLog: steps,
    usage: result?.usage ?? null,
  };
}

/**
 * 추가 리뷰 범위: base가 같고 이전 head가 조상이며 사이에 병합 커밋이 없을 때만 증분
 * base 변경·리베이스·충돌 해결(병합 커밋)은 전체 범위 재검토
 */
export function decideScope({
  previous,
  baseSha,
  prevHeadIsAncestor,
  mergeCommits,
}) {
  if (!previous) return { scope: "full", reasons: ["첫 리뷰"] };
  const reasons = [];
  if (previous.base_sha !== baseSha) reasons.push("base가 바뀜");
  if (!prevHeadIsAncestor)
    reasons.push("이전 head가 지금 head의 조상이 아님(리베이스·강제 push)");
  if (mergeCommits > 0)
    reasons.push(`이전 head 뒤에 병합 커밋 ${mergeCommits}개(충돌 해결 가능)`);
  if (!previous.verdict?.complete) reasons.push("이전 리뷰가 미완료");
  return reasons.length
    ? { scope: "full", reasons }
    : { scope: "incremental", reasons: ["이전 리뷰 뒤 변경만 추가"] };
}
