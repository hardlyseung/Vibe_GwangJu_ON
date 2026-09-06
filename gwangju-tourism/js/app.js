// 광주 나들이 지도 - 프로토타입 스크립트
// TODO: data/places.json 을 실제 광주관광공사 CSV/가이드북 기반 데이터로 교체하세요 (특히 history_details의 TODO 항목).

const DATA_URL = "data/places.json";

let allSpots = [];
let activeTheme = null;
let map = null;
let markers = [];
let selectedPlace = null;
let selectedPersona = "general";

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
  selectedPlace = spot;
  document.getElementById("ai-selected-place").textContent = `선택된 장소: ${spot.name}`;

  const answerBox = document.getElementById("faq-answer");
  answerBox.innerHTML = `
    <strong>${spot.name}</strong><br/>
    ${spot.description}<br/>
    주소: ${spot.address}<br/>
    주차: ${spot.parking} · 운영시간: ${spot.operating_hours}
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

function renderPersonaChips() {
  const box = document.getElementById("persona-chips");
  const personas = [
    { id: "general", label: "일반" },
    { id: "family", label: "가족/어린이" },
    { id: "history", label: "역사 탐방" },
  ];

  box.innerHTML = "";
  personas.forEach((p, idx) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (idx === 0 ? " active" : "");
    chip.textContent = p.label;
    chip.onclick = () => {
      selectedPersona = p.id;
      document.querySelectorAll("#persona-chips .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
    };
    box.appendChild(chip);
  });
}

// AI 서버리스 함수(/api/chat) 호출. Vercel에 GEMINI_API_KEY가 없으면 에러 메시지를 그대로 보여줌.
async function askAi() {
  const answerBox = document.getElementById("ai-answer");
  const input = document.getElementById("ai-question");
  const question = input.value.trim();

  if (!selectedPlace) {
    answerBox.textContent = "먼저 지도에서 관광지를 선택해 주세요.";
    return;
  }
  if (!question) {
    answerBox.textContent = "질문을 입력해 주세요.";
    return;
  }

  answerBox.textContent = "답변 생성 중...";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ placeId: selectedPlace.id, persona: selectedPersona, question }),
    });
    const data = await res.json();

    if (!res.ok) {
      answerBox.textContent = `오류: ${data.error || "알 수 없는 오류"}`;
      return;
    }

    answerBox.textContent = `${data.answer}\n\n[출처: ${data.source.name} (기준일: ${data.source.date})]`;
  } catch (err) {
    answerBox.textContent = "AI 서버에 연결할 수 없습니다. (로컬에서는 /api 함수가 동작하지 않을 수 있습니다 — Vercel 배포 후 확인)";
  }
}

function setupAiForm() {
  document.getElementById("ai-ask-btn").onclick = askAi;
  document.getElementById("ai-question").addEventListener("keydown", (e) => {
    if (e.key === "Enter") askAi();
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
  renderPersonaChips();
  setupAiForm();
}

main();
