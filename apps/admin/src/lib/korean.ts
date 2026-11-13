// 한국어 조사·어미(문구 키 자리에 넣는 이름·항목 뒤). 마지막 글자 받침으로 고름, 한글이 아니면 받침 없음으로 봄

function hasFinalConsonant(word: string): boolean {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (Number.isNaN(code) || code < 0 || code > 11171) return false;
  return code % 28 !== 0;
}

// 주제 조사: 받침 있으면 '은', 없으면 '는'
export function topicParticle(word: string): "은" | "는" {
  return hasFinalConsonant(word) ? "은" : "는";
}
