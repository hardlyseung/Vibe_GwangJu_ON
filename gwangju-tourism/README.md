# 광주 나들이 지도 (가제) — 2026 광주관광공사 노코드·바이브코딩 공모전 프로토타입

## 지금 상태
지도 + 테마 필터 + 관광지 목록 + 통계 차트 + 규칙 기반 안내 챗봇의 **뼈대**가 잡혀 있습니다.
데이터는 전부 `data/spots.sample.json`의 **샘플(가짜) 데이터**이며, 실제 광주관광공사 CSV로 교체해야 합니다.

## 실행 방법 (로컬)
1. `js/app.js`를 열어서 필요 없음 — 대신 `index.html`의 카카오맵 스크립트 태그에서
   `YOUR_KAKAO_JS_KEY`를 발급받은 **JavaScript 키**로 교체
2. 카카오 개발자 콘솔 → 내 애플리케이션 → 플랫폼 → Web 플랫폼 등록에 로컬 테스트 주소
   (예: `http://localhost:5500`) 및 배포할 GitHub Pages 주소 추가
3. VSCode의 Live Server 확장 등으로 `index.html`을 열어서 확인
   (카카오맵 SDK는 `file://`로 직접 열면 동작하지 않을 수 있어 반드시 로컬 서버로 실행)

## 남은 TODO
- [ ] `data/spots.sample.json` → 실제 CSV 기반 데이터로 교체 (파일명 `data/spots.json` 권장, `js/app.js`의 `DATA_URL` 상수 수정)
  - CSV에 위도/경도가 없으면 카카오맵/구글맵에서 검색해 수동으로 좌표 채워넣기
- [ ] `js/app.js`의 `renderStatChart()` 안 예시 숫자를 PDF에서 뽑은 실제 통계로 교체
- [ ] 카카오맵 JavaScript 키 발급 및 `index.html`에 적용
- [ ] GitHub Pages로 배포 (Settings → Pages → 이 폴더 또는 별도 배포 브랜치 지정)
- [ ] 제출용 스크린샷/발표자료 준비, 데이터 출처 명시

## 파일 구조
```
gwangju-tourism/
├── index.html        # 페이지 레이아웃
├── css/style.css     # 스타일
├── js/app.js         # 지도/필터/차트/챗봇 로직
└── data/spots.sample.json  # 샘플 데이터 (교체 대상)
```
