// 주소 -> 좌표 변환 1회성 스크립트 (Node 18+ 필요)
//
// 카카오 개발자 콘솔 -> 내 애플리케이션 -> 앱 키 -> "REST API 키" 사용 (JavaScript 키 아님).
// 이 키는 커밋하지 말고 실행할 때만 환경변수로 넘긴다.
//
//   PowerShell : $env:KAKAO_REST_KEY="키값"; node scripts/geocode.js
//   cmd        : set KAKAO_REST_KEY=키값 && node scripts\geocode.js
//   mac/linux  : KAKAO_REST_KEY=키값 node scripts/geocode.js

const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "..", "data", "places.json");
const REQUEST_DELAY_MS = 150;

// 결과가 광주 밖으로 나오면 주소를 잘못 잡은 것이다. 지도에 찍기 전에 여기서 잡는다.
const GWANGJU_BOUNDS = { minLat: 35.0, maxLat: 35.32, minLng: 126.6, maxLng: 127.1 };

function inGwangju(lat, lng) {
  return (
    lat >= GWANGJU_BOUNDS.minLat &&
    lat <= GWANGJU_BOUNDS.maxLat &&
    lng >= GWANGJU_BOUNDS.minLng &&
    lng <= GWANGJU_BOUNDS.maxLng
  );
}

function explainHttpError(status, text) {
  if (status === 401) {
    return "키가 올바르지 않습니다. JavaScript 키가 아니라 REST API 키인지 확인하세요.";
  }
  if (status === 403 && text.includes("OPEN_MAP_AND_LOCAL")) {
    return "이 앱에 카카오맵 제품이 꺼져 있습니다. 콘솔 > 제품 설정 > 카카오맵 을 켜고 다시 실행하세요.";
  }
  if (status === 403) return "이 키에 권한이 없습니다. 앱 설정을 확인하세요.";
  if (status === 429) return "호출 한도를 초과했습니다. 잠시 후 다시 실행하세요.";
  return `카카오 API 오류 ${status}: ${text.slice(0, 200)}`;
}

async function geocode(address, restKey) {
  const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { Authorization: `KakaoAK ${restKey}` } });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(explainHttpError(res.status, text));
    err.status = res.status;
    err.fatal = res.status === 401 || res.status === 403;
    throw err;
  }

  const data = await res.json();
  const hit = data.documents && data.documents[0];
  if (!hit) return null;

  return { lat: parseFloat(hit.y), lng: parseFloat(hit.x) };
}

async function main() {
  const restKey = process.env.KAKAO_REST_KEY;
  if (!restKey) {
    console.error("KAKAO_REST_KEY 환경변수가 필요합니다. 파일 상단의 실행 예시를 참고하세요.");
    process.exit(1);
  }

  let json;
  try {
    json = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
  } catch (err) {
    console.error(`data/places.json 을 읽을 수 없습니다: ${err.message}`);
    process.exit(1);
  }

  const result = { done: 0, skipped: 0, empty: [], suspect: [], failed: [] };
  let changed = false;

  for (const spot of json.spots) {
    if (Number.isFinite(spot.lat) && Number.isFinite(spot.lng)) {
      result.skipped += 1;
      console.log(`건너뜀  ${spot.name} (이미 좌표 있음)`);
      continue;
    }

    try {
      const coords = await geocode(spot.address, restKey);

      if (!coords) {
        result.empty.push(spot.name);
        console.warn(`결과없음 ${spot.name} — 주소: ${spot.address}`);
      } else {
        spot.lat = coords.lat;
        spot.lng = coords.lng;
        changed = true;
        result.done += 1;

        if (inGwangju(coords.lat, coords.lng)) {
          console.log(`성공    ${spot.name} -> ${coords.lat}, ${coords.lng}`);
        } else {
          result.suspect.push(spot.name);
          console.warn(`확인필요 ${spot.name} -> ${coords.lat}, ${coords.lng} (광주 경계 밖)`);
        }
      }
    } catch (err) {
      result.failed.push(spot.name);
      console.error(`실패    ${spot.name}: ${err.message}`);

      // 키·권한 문제면 18번 반복해봐야 같은 오류다. 즉시 멈추고 원인을 알려준다.
      if (err.fatal) {
        console.error("\n키 또는 권한 문제로 중단합니다. 위 안내를 처리한 뒤 다시 실행하세요.");
        break;
      }
    }

    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
  }

  if (changed) {
    fs.writeFileSync(DATA_PATH, JSON.stringify(json, null, 2) + "\n", "utf-8");
  }

  const remaining = json.spots.filter((s) => !Number.isFinite(s.lat) || !Number.isFinite(s.lng));

  console.log("\n──────── 결과 ────────");
  console.log(`새로 채움 ${result.done}곳 / 이미 있던 것 ${result.skipped}곳 / 전체 ${json.spots.length}곳`);
  if (result.suspect.length) console.log(`좌표 확인 필요: ${result.suspect.join(", ")}`);
  if (result.empty.length) console.log(`주소 검색 결과 없음: ${result.empty.join(", ")}`);
  if (result.failed.length) console.log(`호출 실패: ${result.failed.join(", ")}`);
  console.log(changed ? "data/places.json 을 갱신했습니다." : "변경 사항이 없어 파일을 쓰지 않았습니다.");

  if (remaining.length === 0) {
    console.log("좌표가 비어 있는 거점이 없습니다. P0 완료.");
  } else {
    console.log(`아직 좌표 없는 ${remaining.length}곳: ${remaining.map((s) => s.name).join(", ")}`);
    console.log("→ 카카오맵에서 장소명으로 검색해 좌표를 직접 넣어 주세요.");
  }
}

main();
