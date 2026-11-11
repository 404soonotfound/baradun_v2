# 한국 지도 파일 (결정 기록 D19-1 · #392)

운영 지도는 OpenFreeMap 서버의 판을 쓰지 않고, 우리가 한 번 만들어 검증한 한국 지도 파일을 사이트 S3·CloudFront에서 받아요. OpenFreeMap은 옛 판을 2주 남짓 만에 지우고, 지운 판을 요청하면 오류 없이 최신 판을 주기 때문이에요(#390).

## 무엇을 만드나

| 경로(사이트 버킷)                  | 내용                                           | 원본                                                          |
| ---------------------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| `map/<판>/korea.pmtiles`           | 한국 지도 타일(확대 0~14, OpenMapTiles 스키마) | Geofabrik 한국 OSM 데이터 → Planetiler(버전·체크섬 고정)      |
| `map/<판>/fonts/<글꼴>/<범위>.pbf` | 지도 글꼴 Noto Sans Regular·Bold·Italic        | `maplibre/demotiles`(커밋 고정, OpenFreeMap과 같은 원본)      |
| `map/<판>/sprites/ofm*.{json,png}` | 지도 아이콘                                    | `hyperknot/openfreemap-styles`의 `ofm_f384`(커밋·체크섬 고정) |

- 판 이름은 만든 시각(UTC, `YYYYMMDD-HHMM`)이에요. 실행마다 새 판이라 올린 파일을 덮어쓰지 않고, 판마다 폴더가 따로라 1년 캐시를 걸어요.
- 스키마가 OpenFreeMap과 같아서 스타일 JSON(`apps/web/src/lib/map/style-*.json`)을 그대로 써요.
- 2026-11-11 실측: 지도 파일 378MB, 만드는 시간 약 2분, 글꼴 약 100MB.

## 새 판 만들기

정해진 주기는 없어요. 지도를 새로 만들고 싶을 때만 해요.

1. GitHub Actions → `map-tiles` → main에서 **Run workflow**. `build` 작업이 만들고 형식·필수 자산을 확인한 뒤(`verify.mjs --dir`), `upload` 작업이 production environment에서 OIDC 임시 키로 `map/<판>/`에 올려요. 같은 판 폴더가 이미 있으면 멈춰요. 다 올리면 마지막에 `map/<판>/READY.txt`를 둬요. 올리다 실패해 `READY.txt`가 없는 판은 쓰지 않고 워크플로를 다시 실행해요(새 판). 끊긴 조각 업로드는 사이트 버킷 수명 주기 규칙이 1일 뒤 지워요. 마지막 `verify` 작업이 실제 CloudFront 경로를 확인해요(아래 '지도 판 확인').
2. 실행 요약의 판 이름을 `apps/web/src/lib/map/style.ts`의 `MAP_VERSION`에 넣는 PR을 올려요. PR CI의 `map-files` 작업이 그 판을 운영 CloudFront에서 확인해요.
3. PR에서 표본 해변 지도를 라이트·다크로 캡처해 확인한 뒤 머지해요(아키텍처 16.4.3 표본 기준).

옛 판 폴더는 웹이 더 쓰지 않는 것을 확인한 뒤에만 지워요.

## 지도 판 확인 (`verify.mjs`)

의존성 없이 node만 써요. 공개 주소를 읽기만 하고 AWS 권한은 쓰지 않아요. 하나라도 틀리면 종료 코드 1이에요.

```sh
# 만든 파일: PMTiles 헤더(벡터 타일·확대 0~14·한국 끝 지점 포함), sprite 4개, 스타일이 부르는 글꼴 256범위
node tools/map-tiles/verify.mjs --dir /tmp/map/<판>
# 실제 경로: READY.txt 판 일치 → PMTiles 범위 요청(206·Content-Range·압축 없음·헤더) → sprite·글꼴 응답
node tools/map-tiles/verify.mjs --site https://<사이트> [--version <판>]   # 판을 빼면 style.ts의 MAP_VERSION
```

| 언제                                                                 | 무엇                       | 어디서                                        |
| -------------------------------------------------------------------- | -------------------------- | --------------------------------------------- |
| 지도를 만들 때                                                       | `--dir`                    | `map-tiles` `build` 작업                      |
| 올린 뒤                                                              | `--site --version <새 판>` | `map-tiles` `verify` 작업                     |
| 지도 판·스타일·지도 파일 도구를 바꾼 PR                              | `--site`(웹이 쓰는 판)     | CI `map-files`(ci-ok에 묶임)                  |
| `npm run deploy:infra` 배포 뒤(사이트 CloudFront·버킷·CSP 변경 포함) | `--site`(웹이 쓰는 판)     | `deploy:infra` 9단계, 결과를 `--issue` 댓글에 |

- 올리기(쓰기)는 `map-tiles` `upload` 작업만 해요. PR의 `map-files`는 공개 주소 읽기만 해요.
- 지도와 무관한 웹 PR·main push·매일 정기 실행에서는 지도 서버를 부르지 않아요. 매일 정기 실행은 취약점(audit)·비밀값(gitleaks) 검사만 해요.
- 개발 서버(`npm run dev`)와 Storybook(`npm run storybook`)은 `/map/` 요청만 운영 CloudFront로 넘겨 같은 출처로 받아요(`apps/web/scripts/dev-map.mjs`: `next dev` 전용 rewrite, Storybook Vite proxy). 범위 요청의 `206`·`Content-Range`·`ETag`가 그대로 오고, 운영 CloudFront에 CORS는 열지 않아요. 정적 빌드(`next build`)에는 들어가지 않아요.
  - 다른 사이트의 지도 판을 쓰려면 `BARADUN_DEV_MAP_ORIGIN=https://<사이트>`를 줘요(기본은 운영 CloudFront 기본 주소).
  - 개발 서버·Storybook도 `style.ts`의 `MAP_VERSION` 판을 받으므로, 새 판은 올리고 `READY.txt`가 열린 뒤에 PR에 넣어요.

## 로컬에서 만들어 보기

Java 21과 Linux x86_64가 필요해요(검사 도구 `pmtiles`가 Linux용으로 고정돼 있음).

```sh
bash tools/map-tiles/build.sh /tmp/map
```

## 사이트 배포와의 관계

사이트 배포(`deploy.yml`)의 `s3 sync --delete`는 `map/`을 지우지 않아요(`infra/test/workflows.test.ts`가 확인).
