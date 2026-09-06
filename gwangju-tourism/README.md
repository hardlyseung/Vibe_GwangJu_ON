# 광주 ON AIR (가제) — 2026 광주관광공사 노코드·바이브코딩 공모전 프로토타입

## 지금 상태
지도 + 테마 필터 + 관광지 목록 + 통계 차트 + 규칙 기반 FAQ + **AI 문화관광해설(Direct-Context, No-RAG)** 뼈대가 잡혀 있습니다.

- `data/places.json`: **광주광역시관광공사_문화관광해설사 현황(수정일 2026-06-09)** 실제 18곳 데이터 반영 완료
  (이름/주소/전화번호/관리기관은 실데이터, `history_details`/`visit_tips`/`operating_hours`/`admission`/`parking`은 아직 `TODO`)
- 좌표(lat/lng)는 원본 CSV에 없어서 `null` — `scripts/geocode.js`로 채워야 함 (아래 참고)
- 카카오맵 JavaScript 키 적용 완료

프론트는 순수 HTML/CSS/JS(빌드 없음)를 유지하고, AI 호출만 서버리스 함수 하나(`api/chat.js`)로 처리합니다.
→ **배포는 GitHub Pages가 아니라 Vercel**을 사용해야 합니다 (GitHub Pages는 서버리스 함수를 못 돌림).

## 1. 좌표 채우기 (가장 먼저 할 일)
1. 카카오 개발자 콘솔 → 내 애플리케이션 → 앱 키 → **REST API 키**를 발급 (JavaScript 키와 다름, 같은 앱에서 같이 발급됨)
2. 아래 명령 실행 (Node 18+ 필요):
   ```
   cd gwangju-tourism
   KAKAO_REST_KEY=발급받은_REST_API_키 node scripts/geocode.js
   ```
3. `data/places.json`의 모든 `lat`/`lng`가 채워졌는지 확인 (실패 항목은 로그에 표시됨 → 주소 재확인)

## 2. 로컬 실행
1. 카카오 개발자 콘솔 → 플랫폼 → Web 플랫폼에 로컬 주소(`http://localhost:5500` 등)와 Vercel 배포 주소 등록
   (지금 등록된 도메인이 없으면 지도가 안 뜨고 콘솔에 도메인 오류가 찍힘)
2. `npm i -g vercel` 후 이 폴더(`gwangju-tourism/`)에서 `vercel dev` 실행
   → 정적 파일 + `/api/chat` 함수가 함께 로컬에서 동작 (Live Server만 쓰면 AI 기능은 테스트 안 됨, 지도/FAQ는 가능)

## 3. Vercel 배포
1. GitHub 레포를 Vercel에 연결, **Root Directory를 `gwangju-tourism`으로 지정**
2. Vercel 프로젝트 → Settings → Environment Variables에 `GEMINI_API_KEY` 등록
   - **반드시 [ai.google.com/aistudio](https://ai.google.com/aistudio)의 진짜 무료 티어 키를 사용하세요.**
   - GCP 체험판(트라이얼) 크레딧에 연결된 키는 쓰지 마세요 — 크레딧은 보통 90일/소진 시 만료되는데,
     공모전 조건상 서비스는 **2027.3.31까지 계속 접속 가능해야 합니다.** 크레딧 만료로 서비스가 끊기면 운영 조건 위반입니다.
3. 배포 후 카카오 개발자 콘솔에 Vercel 도메인을 Web 플랫폼으로 추가

## 남은 TODO (우선순위 순)
- [ ] 좌표 채우기 (`scripts/geocode.js` 실행) ← 이거 없으면 마커가 하나도 안 뜸
- [ ] `data/places.json`의 `TODO` 표시된 `history_details`/`visit_tips`/`operating_hours`/`admission`/`parking`을
      **광주관광공사 관광 가이드북 PDF**(공사 자체 콘텐츠) 기반으로 채우기
      → 데이터 활용성 심사(30점)에서 "공사 데이터" 비중을 높이는 핵심 작업
- [ ] `GEMINI_API_KEY` 발급 및 Vercel 환경변수 등록, AI 답변 실제 테스트 (일반/가족/역사 3톤 + 근거 없는 질문 거절 확인)
- [ ] `js/app.js`의 `renderStatChart()` 예시 숫자를 PDF 통계로 교체
- [ ] Vercel 배포, 모바일 실기기 테스트
- [ ] 제출용 스크린샷/발표자료, 데이터 출처 명시

## 알아둘 것
- 원본 CSV의 '소재지' 컬럼은 7~11번(충장사~광주역사민속박물관) 행에서 '남구'로 잘못 표기돼 있었음
  → 도로명주소 기준(북구)으로 정정해서 반영함 (`data/places.json`의 `district_note` 참고)
- 5·18 관련 두 곳(국립5.18민주묘지, 5.18자유공원)은 민감한 역사 서술이라 `history_details`를 비워둠.
  반드시 공식 자료(국가보훈부·5.18기념재단 등)만 근거로, 검증된 내용만 채울 것.

## 파일 구조
```
gwangju-tourism/
├── index.html           # 페이지 레이아웃 (지도 + FAQ + AI 해설 패널)
├── css/style.css         # 스타일
├── js/app.js             # 지도/필터/차트/FAQ/AI 호출 로직
├── data/places.json      # 실데이터 18곳 (TODO 필드 참고)
├── scripts/geocode.js    # 주소 -> 좌표 변환 1회성 스크립트 (카카오 REST API 키 필요)
└── api/chat.js           # Vercel 서버리스 함수 — Gemini 호출 + 환각 방지 가드레일 프롬프트
```
