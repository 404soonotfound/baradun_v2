// 거부 예시 생성: 정상 예시에서 한 군데만 틀리게 (결과: examples/invalid/)
// 실행: node scripts/make-invalid-examples.mjs (packages/contracts에서)
// 정상 예시를 고치면 다시 실행
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// examples/valid/{name}.json 읽기
const read = (name) => JSON.parse(readFileSync(`examples/valid/${name}.json`, 'utf8'));
// [파일 이름, 내용] 목록
const cases = [];
// base 예시를 복사해 change로 한 군데 바꿈
const add = (file, base, change) => {
  const doc = read(base);
  change(doc);
  cases.push([file, doc]);
};

// 계약 버전
add('manifest.unsupported-schema-version', 'manifest', (d) => { d.schemaVersion = 2; });
// 필수 필드 누락
add('status.missing-valid-until', 'status', (d) => { delete d.beaches.b0001.validUntil; });
// 모르는 사유 code (통제 code는 후속용 예약, 6.3)
add('status.unknown-reason-code', 'status', (d) => { d.beaches.b0003.reasons[0].code = 'control_closed'; });
// 분류와 사유가 안 맞음: 특보 없음인데 사유가 있음
add('status.clear-with-reason', 'status', (d) => { d.beaches.b0001.reasons = d.beaches.b0003.reasons; });
// '특보 없음'인데 확인 시각이 없음 (확인된 때만 '없음')
add('status.none-without-confirmed-time', 'status', (d) => { d.beaches.b0001.warning.lastConfirmedAt = null; });
// 최신(fresh)인데 값이 없음 (결측을 정상으로 표시 금지)
add('status.fresh-without-value', 'status', (d) => { d.beaches.b0001.observation.metrics.waveHeight.value = null; });
// 안전요원 필드 (B2에서 삭제)
add('status.lifeguard-field', 'status', (d) => { d.beaches.b0001.lifeguard = { onDuty: true }; });
// 대표 관측소 20km 초과
add('beaches.station-over-20km', 'beaches', (d) => { d.beaches[0].stations.waveHeight.distanceKm = 24.1; });
// 스노클링 (출시 제외, B7)
add('beaches.snorkeling', 'beaches', (d) => { d.beaches[0].activities = ['swimming', 'snorkeling']; });
// slug 규칙 위반
add('beaches.bad-slug', 'beaches', (d) => { d.beaches[0].slug = 'Gyeongpo_Beach'; });
// 해수욕장인데 육상 구역 없음 (생략은 스쿠버 포인트만, 결정 기록 11장 10/21)
add('beaches.beach-without-land', 'beaches', (d) => { delete d.beaches[0].warningZones.land; });
// 모르는 장소 종류
add('beaches.unknown-kind', 'beaches', (d) => { d.beaches[0].kind = 'harbor'; });
// 해안 구분 누락
add('beaches.missing-coast', 'beaches', (d) => { delete d.beaches[0].coast; });

// 폴더 만들고 파일 저장 (2칸 들여쓰기)
mkdirSync('examples/invalid', { recursive: true });
for (const [file, doc] of cases) {
  writeFileSync(`examples/invalid/${file}.json`, JSON.stringify(doc, null, 2) + '\n');
}
console.log(`거부 예시 ${cases.length}개 생성`);