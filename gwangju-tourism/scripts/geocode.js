// 1회성 좌표 변환 스크립트. Node 18+ 필요 (전역 fetch 사용).
// 카카오 개발자 콘솔 -> 내 애플리케이션 -> 앱 키 -> "REST API 키"(JavaScript 키 아님)를 발급받아 실행하세요.
// 이 키는 절대 커밋/공개 저장소에 넣지 말고, 실행할 때만 환경변수로 전달하세요.
//
// 실행:
//   KAKAO_REST_KEY=발급받은_REST_API_키 node scripts/geocode.js

const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "..", "data", "places.json");

async function geocodeAddress(address, restKey) {
  const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`;
  const res = await fetch(url, {
    headers: { Authorization: `KakaoAK ${restKey}` },
  });

  if (!res.ok) {
    throw new Error(`카카오 API 오류 (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  const first = data.documents?.[0];
  if (!first) return null;

  return { lat: parseFloat(first.y), lng: parseFloat(first.x) };
}

async function main() {
  const restKey = process.env.KAKAO_REST_KEY;
  if (!restKey) {
    console.error("KAKAO_REST_KEY 환경변수가 필요합니다. 예: KAKAO_REST_KEY=xxxx node scripts/geocode.js");
    process.exit(1);
  }

  const raw = fs.readFileSync(DATA_PATH, "utf-8");
  const json = JSON.parse(raw);

  for (const spot of json.spots) {
    if (spot.lat && spot.lng) {
      console.log(`- 이미 좌표 있음: ${spot.name}`);
      continue;
    }

    try {
      const coords = await geocodeAddress(spot.address, restKey);
      if (coords) {
        spot.lat = coords.lat;
        spot.lng = coords.lng;
        console.log(`OK  ${spot.name} -> ${coords.lat}, ${coords.lng}`);
      } else {
        console.warn(`실패(결과 없음) ${spot.name} (${spot.address}) - 주소를 다시 확인하세요.`);
      }
    } catch (err) {
      console.error(`오류 ${spot.name}: ${err.message}`);
    }

    // 카카오 API 호출 제한 배려용 짧은 딜레이
    await new Promise((r) => setTimeout(r, 150));
  }

  fs.writeFileSync(DATA_PATH, JSON.stringify(json, null, 2) + "\n", "utf-8");
  console.log("\n완료: data/places.json에 좌표를 반영했습니다. 실패 항목은 수동으로 확인해 주세요.");
}

main();
