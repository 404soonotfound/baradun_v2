import { checkList, compareWithBase } from "../../packages/contracts/scripts/beach-rules.mjs";

export const idKey = (src) => `${src.sido_nm}|${src.gugun_nm}|${src.sta_nm}`;

export function reserveSlug(owners, slug, id) {
  if (owners.has(slug) && owners.get(slug) !== id)
    throw new Error(`slug 재사용 금지·충돌: ${slug}는 ${owners.get(slug)}가 이미 씀(${id}). 로마자 충돌은 새 규칙 없이 생성 중단`);
  owners.set(slug, id);
}

// 숨긴 파일도 ID·주소 소유권 검사의 대상임. 이름 변경 대응은 사람이 확인함.
export function validateIdentity(ids, existingItems, sources, previousMatrix = []) {
  const errors = [];
  const owners = new Map();
  const sourceKeys = new Set();
  for (const src of sources) {
    const key = idKey(src);
    if (sourceKeys.has(key)) errors.push(`원자료 해변 키 중복: ${key}`);
    sourceKeys.add(key);
  }
  for (const [key, id] of Object.entries(ids.ids)) {
    if (!/^b\d{4}$/.test(id)) errors.push(`ID 대장 형식 오류: ${key} ${id}`);
    if (owners.has(id)) errors.push(`ID 대장 중복: ${id} (${owners.get(id)}, ${key})`);
    owners.set(id, key);
    if (!sourceKeys.has(key)) errors.push(`원자료에서 기존 해변이 사라졌거나 이름이 바뀜: ${id} ${key}. 자동 숨김·이름 변경 대응 없이 생성 중단, 사람이 확인하세요`);
  }
  // JSON이 없는 보류·제외 해변도 이미 정한 ID를 다른 해변에 넘길 수 없음.
  const previousIds = new Set();
  for (const row of previousMatrix) {
    if (!row.id) continue; // 아직 ID를 받지 않은 좌표 보류 행
    if (previousIds.has(row.id)) errors.push(`기존 매트릭스 ID 중복: ${row.id}`);
    previousIds.add(row.id);
    // 공개 매트릭스에는 시도 칸이 없으므로 시군·원자료 이름의 후보가 하나일 때만 시도를 확인함.
    const matches = sources.filter((src) => src.gugun_nm === row.sigungu && src.sta_nm === row.source_name);
    const sourceKey = matches.length === 1 ? idKey(matches[0]) : null;
    if (!sourceKey || owners.get(row.id) !== sourceKey)
      errors.push(`ID 대장·원자료 정체성 불일치: 매트릭스 ${row.id} ${row.sigungu}|${row.source_name} (대장 ${owners.get(row.id) ?? "없음"}, 원자료 후보 ${matches.length}개). 사람이 확인하세요`);
  }
  errors.push(...checkList(existingItems));
  for (const { file, beach, sourceKey } of existingItems) {
    if (!owners.has(beach.id)) errors.push(`ID 대장·기존 파일 불일치: ${file} ${beach.id}`);
    else if (!sourceKey || owners.get(beach.id) !== sourceKey)
      errors.push(`ID 대장·원자료 정체성 불일치: ${file} (대장 ${owners.get(beach.id)} ≠ 기존 ${sourceKey ?? "매트릭스 근거 없음"}). 사람이 확인하세요`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

export function preserveManual(record, previous) {
  const { _draft, ...beach } = record;
  if (!previous) return beach;
  assertSameName(beach.id, beach.name.ko, previous);
  return {
    ...beach,
    name: { ...beach.name, en: previous.name?.en },
    activities: previous.activities,
    photo: previous.photo,
    cctv: previous.cctv,
    hidden: previous.hidden,
  };
}

export function assertSameName(id, nameKo, previous) {
  if (previous && previous.name?.ko !== nameKo)
    throw new Error(`같은 ID 이름 변경: ${id} (${previous.name?.ko} → ${nameKo}). 이름 변경 대응은 지원하지 않음, 사람이 확인하세요`);
}

export function validateFinalIdentity(existing, beaches) {
  const errors = [
    ...checkList(beaches.map((beach) => ({ file: `${beach.id}.json`, beach }))),
    ...compareWithBase(existing, beaches),
  ];
  if (errors.length) throw new Error(errors.join("\n"));
}
