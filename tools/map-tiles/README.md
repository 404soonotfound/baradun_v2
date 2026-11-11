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

1. GitHub Actions → `map-tiles` → main에서 **Run workflow**. `build` 작업이 만들고, `upload` 작업이 production environment에서 OIDC 임시 키로 `map/<판>/`에 올려요. 같은 판 폴더가 이미 있으면 멈춰요. 다 올리면 마지막에 `map/<판>/READY.txt`를 둬요. 올리다 실패해 `READY.txt`가 없는 판은 쓰지 않고 워크플로를 다시 실행해요(새 판). 끊긴 조각 업로드는 사이트 버킷 수명 주기 규칙이 1일 뒤 지워요.
2. 실행 요약의 판 이름을 `apps/web/src/lib/map/style.ts`에 넣는 PR을 올려요. `https://<사이트>/map/<판>/READY.txt`가 열리는 판만 써요.
3. PR에서 표본 해변 지도를 라이트·다크로 캡처해 확인한 뒤 머지해요(아키텍처 16.4.3 표본 기준).

옛 판 폴더는 웹이 더 쓰지 않는 것을 확인한 뒤에만 지워요.

## 로컬에서 만들어 보기

Java 21과 Linux x86_64가 필요해요(검사 도구 `pmtiles`가 Linux용으로 고정돼 있음).

```sh
bash tools/map-tiles/build.sh /tmp/map
```

## 사이트 배포와의 관계

사이트 배포(`deploy.yml`)의 `s3 sync --delete`는 `map/`을 지우지 않아요(`infra/test/workflows.test.ts`가 확인).
