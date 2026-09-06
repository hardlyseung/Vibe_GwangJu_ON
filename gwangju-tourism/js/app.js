// 광주 나들이 지도 - 프로토타입 스크립트
// TODO: data/spots.sample.json 을 실제 광주관광공사 CSV 기반 데이터로 교체하세요 (data/spots.json 권장 파일명).

const DATA_URL = "data/spots.sample.json";

let allSpots = [];
let activeTheme = null;
let map = null;
let markers = [];

async function loadData() {
  const res = await fetch(DATA_URL);
  return res.json();
}

function initMap(centerLat, centerLng) {
  const container = document.getElementById("map");
  const options = {
    center: new kakao.maps.LatLng(centerLat, centerLng),
    level: 8,
  };
  map = new kakao.maps.Map(container, options);
}

function clearMarkers() {
  markers.forEach((m) => m.setMap(null));
  markers = [];
}

function renderMarkers(spots) {
  clearMarkers();
  spots.forEach((spot) => {
    const position = new kakao.maps.LatLng(spot.lat, spot.lng);
    const marker = new kakao.maps.Marker({ position, map });
    const infowindow = new kakao.maps.InfoWindow({
      content: `<div style="padding:6px 10px;font-size:13px;">${spot.name}</div>`,
    });
    kakao.maps.event.addListener(marker, "mouseover", () => infowindow.open(map, marker));
    kakao.maps.event.addListener(marker, "mouseout", () => infowindow.close());
    kakao.maps.event.addListener(marker, "click", () => {
      map.panTo(position);
      showSpotDetail(spot);
    });
    markers.push(marker);
  });
}

function showSpotDetail(spot) {
  const answerBox = document.getElementById("faq-answer");
  answerBox.innerHTML = `
    <strong>${spot.name}</strong><br/>
    ${spot.description}<br/>
    주소: ${spot.address}<br/>
    주차: ${spot.parking} · 운영시간: ${spot.hours}
  `;
}

function renderThemeFilters(themes) {
  const box = document.getElementById("theme-filters");
  box.innerHTML = "";

  const allChip = document.createElement("button");
  allChip.className = "chip active";
  allChip.textContent = "전체";
  allChip.onclick = () => applyThemeFilter(null, allChip);
  box.appendChild(allChip);

  themes.forEach((theme) => {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = theme;
    chip.onclick = () => applyThemeFilter(theme, chip);
    box.appendChild(chip);
  });
}

function applyThemeFilter(theme, clickedChip) {
  activeTheme = theme;
  document.querySelectorAll("#theme-filters .chip").forEach((c) => c.classList.remove("active"));
  clickedChip.classList.add("active");

  const filtered = theme ? allSpots.filter((s) => s.theme === theme) : allSpots;
  renderMarkers(filtered);
  renderSpotList(filtered);
}

function renderSpotList(spots) {
  const list = document.getElementById("spot-list");
  list.innerHTML = "";
  spots.forEach((spot) => {
    const li = document.createElement("li");
    li.className = "spot-item";
    li.innerHTML = `<div class="name">${spot.name}</div><div class="theme-tag">${spot.theme}</div>`;
    li.onclick = () => {
      map.panTo(new kakao.maps.LatLng(spot.lat, spot.lng));
      showSpotDetail(spot);
    };
    list.appendChild(li);
  });
}

// TODO: PDF에서 뽑은 실제 통계 숫자로 labels/values 교체
function renderStatChart() {
  const ctx = document.getElementById("stat-chart");
  new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["2022", "2023", "2024", "2025"],
      datasets: [
        {
          label: "샘플 방문객 수 (단위: 만 명, 예시값)",
          data: [12, 15, 18, 21],
          backgroundColor: "#2f6fed",
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } },
    },
  });
}

// 규칙 기반 간단 FAQ 봇: 실제 LLM 없이 데이터로부터 답변 생성
function renderFaqBot() {
  const box = document.getElementById("faq-questions");
  const questions = [
    {
      label: "주차 가능한 곳은?",
      answer: () =>
        allSpots
          .filter((s) => s.parking === "가능")
          .map((s) => s.name)
          .join(", ") + " 에서 주차가 가능합니다.",
    },
    {
      label: "자연 테마 관광지는?",
      answer: () =>
        allSpots
          .filter((s) => s.theme === "자연")
          .map((s) => s.name)
          .join(", ") || "해당 테마 관광지가 없습니다.",
    },
    {
      label: "역사문화 테마 관광지는?",
      answer: () =>
        allSpots
          .filter((s) => s.theme === "역사문화")
          .map((s) => s.name)
          .join(", ") || "해당 테마 관광지가 없습니다.",
    },
  ];

  box.innerHTML = "";
  questions.forEach((q) => {
    const btn = document.createElement("button");
    btn.className = "chip";
    btn.textContent = q.label;
    btn.onclick = () => {
      document.getElementById("faq-answer").textContent = q.answer();
    };
    box.appendChild(btn);
  });
}

async function main() {
  const data = await loadData();
  allSpots = data.spots;

  kakao.maps.load(() => {
    const first = allSpots[0];
    initMap(first ? first.lat : 35.1595, first ? first.lng : 126.8526);
    renderMarkers(allSpots);
  });

  renderThemeFilters(data.themes);
  renderSpotList(allSpots);
  renderStatChart();
  renderFaqBot();
}

main();
