// 해변 목록 규칙 (BRD-45, 아키텍처 9장): 순수 함수만 → 테스트에서 그대로 사용

// slug에 넣지 않는 말 (해수욕장·해변·해안의 로마자)
const BANNED_WORDS = ["haesuyokjang", "haebyeon", "haean"];

/**
 * 한 시점의 해변 목록 검사
 * @param {{ file: string, beach: { id: string, slug: string } }[]} items
 * @returns {string[]} 오류 문장 목록 (비어 있으면 통과)
 */
export function checkList(items) {
  const errors = [];
  const ids = new Map(); // id → 파일
  const slugs = new Map(); // slug → id

  for (const { file, beach } of items) {
    // 파일 이름 = id (예: b0001.json)
    if (file !== `${beach.id}.json`)
      errors.push(`${file}: 파일 이름은 ${beach.id}.json이어야 해요`);

    // id 중복
    if (ids.has(beach.id))
      errors.push(
        `${file}: 이미 있는 id예요 (${beach.id}, ${ids.get(beach.id)})`,
      );
    ids.set(beach.id, file);

    // slug 중복
    if (slugs.has(beach.slug))
      errors.push(
        `${file}: slug ${beach.slug}는 이미 ${slugs.get(beach.slug)}에서 써요`,
      );
    slugs.set(beach.slug, beach.id);

    // 해수욕장·해변·해안 단어 금지 (하이픈으로 나눈 조각 단위)
    const bad = beach.slug.split("-").filter((w) => BANNED_WORDS.includes(w));
    if (bad.length)
      errors.push(
        `${file}: slug에서 ${bad.join(", ")} 조각을 빼요 (해수욕장·해변·해안 제외 규칙)`,
      );
  }
  return errors;
}

/**
 * main(이전)과 지금 비교: 한 번 정한 slug는 바꾸거나 지우거나 다시 쓰지 않음
 * @param {{ id: string, slug: string }[]} base  main 쪽 해변
 * @param {{ id: string, slug: string }[]} head  지금 브랜치 해변
 * @returns {string[]}
 */
export function compareWithBase(base, head) {
  const errors = [];
  const headById = new Map(head.map((b) => [b.id, b]));
  const baseIdBySlug = new Map(base.map((b) => [b.slug, b.id]));

  for (const old of base) {
    const now = headById.get(old.id);
    // 삭제 금지: 숨기려면 hidden: true
    if (!now)
      errors.push(
        `${old.id}: 해변을 지울 수 없어요. 숨기려면 hidden을 true로 바꿔요`,
      );
    // slug 변경 금지
    else if (now.slug !== old.slug)
      errors.push(
        `${old.id}: slug는 바꿀 수 없어요 (${old.slug} → ${now.slug})`,
      );
  }
  for (const now of head) {
    // 재사용 금지: 예전에 다른 해변이 쓰던 slug
    const owner = baseIdBySlug.get(now.slug);
    if (owner && owner !== now.id)
      errors.push(
        `${now.id}: slug ${now.slug}는 ${owner}가 쓰던 주소라 다시 쓸 수 없어요`,
      );
  }
  return errors;
}
