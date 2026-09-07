"use strict";

const DATA_URL = "data/places.json";
const GWANGJU_CENTER = { lat: 35.1595, lng: 126.8526 };
const REQUEST_TIMEOUT_MS = 25000;
const MAX_QUESTION_LENGTH = 200;

// 좌표가 광주 밖으로 찍히면 지오코딩이 엉뚱한 주소를 잡은 것이다. 마커는 그려주되 눈에 띄게 표시한다.
const GWANGJU_BOUNDS = { minLat: 35.0, maxLat: 35.32, minLng: 126.6, maxLng: 127.1 };

const PERSONAS = [
  { id: "general", label: "일반" },
  { id: "family", label: "가족·어린이" },
  { id: "history", label: "역사 탐방" },
];

const state = {
  spots: [],
  themes: [],
  activeTheme: null,
  selected: null,
  persona: "general",
  map: null,
  markers: [],
  asking: false,
};

/* ---------- DOM 유틸 ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/* ---------- 데이터 판정 ---------- */

// places.json의 미작성 필드는 "TODO..." 문자열로 남아 있다.
// 이걸 화면이나 AI 근거 자료에 그대로 노출하면 안 된다.
function isFilled(value) {
  return typeof value === "string" && value.trim() !== "" && !value.trim().startsWith("TODO");
}

function coordStatus(spot) {
  if (!Number.isFinite(spot.lat) || !Number.isFinite(spot.lng)) return "missing";
  const inBounds =
    spot.lat >= GWANGJU_BOUNDS.minLat &&
    spot.lat <= GWANGJU_BOUNDS.maxLat &&
    spot.lng >= GWANGJU_BOUNDS.minLng &&
    spot.lng <= GWANGJU_BOUNDS.maxLng;
  return inBounds ? "ok" : "suspect";
}

function telHref(phone) {
  const digits = String(phone || "").replace(/[^0-9+]/g, "");
  return digits ? "tel:" + digits : null;
}

function directionsHref(spot) {
  if (coordStatus(spot) !== "missing") {
    return `https://map.kakao.com/link/to/${encodeURIComponent(spot.name)},${spot.lat},${spot.lng}`;
  }
  // 좌표가 없으면 주소 검색으로 대체한다.
  return `https://map.kakao.com/link/search/${encodeURIComponent(spot.address || spot.name)}`;
}

/* ---------- 지도 ---------- */

function showMapFallback(message) {
  const container = document.getElementById("map");
  clear(container);
  const box = el("div", "map-fallback");
  box.appendChild(el("p", "map-fallback-title", "지도를 표시할 수 없습니다"));
  box.appendChild(el("p", "map-fallback-body", message));
  box.appendChild(
    el("p", "map-fallback-body", "왼쪽 목록에서 거점을 선택하면 상세 정보와 AI 해설은 그대로 이용할 수 있습니다.")
  );
  container.appendChild(box);
}

function setupMap() {
  // SDK 로드 실패(도메인 미등록·네트워크 차단)로 kakao가 없을 수 있다.
  // 이 경우에도 목록·상세·AI는 계속 동작해야 하므로 여기서 끊어낸다.
  if (typeof kakao === "undefined" || !kakao.maps || typeof kakao.maps.load !== "function") {
    showMapFallback(
      "카카오맵을 불러오지 못했습니다. 카카오 개발자 콘솔의 [내 애플리케이션 > 플랫폼 > Web]에 현재 접속 중인 도메인이 등록돼 있는지 확인해 주세요."
    );
    return;
  }

  try {
    kakao.maps.load(() => {
      try {
        const anchor = state.spots.find((s) => coordStatus(s) === "ok");
        state.map = new kakao.maps.Map(document.getElementById("map"), {
          center: new kakao.maps.LatLng(
            anchor ? anchor.lat : GWANGJU_CENTER.lat,
            anchor ? anchor.lng : GWANGJU_CENTER.lng
          ),
          level: 8,
        });
        renderMarkers(visibleSpots());
      } catch (err) {
        console.error("[map] 초기화 실패", err);
        showMapFallback("지도 초기화 중 문제가 발생했습니다. 페이지를 새로고침해 주세요.");
      }
    });
  } catch (err) {
    console.error("[map] SDK 로드 실패", err);
    showMapFallback("지도 스크립트를 불러오지 못했습니다. 네트워크 상태를 확인해 주세요.");
  }
}

function clearMarkers() {
  state.markers.forEach((m) => m.setMap(null));
  state.markers = [];
}

function renderMarkers(spots) {
  if (!state.map) return;
  clearMarkers();

  spots.forEach((spot) => {
    if (coordStatus(spot) === "missing") return;

    const position = new kakao.maps.LatLng(spot.lat, spot.lng);
    const marker = new kakao.maps.Marker({ position, map: state.map });
    const infowindow = new kakao.maps.InfoWindow({
      content: `<div class="iw">${escapeHtml(spot.name)}</div>`,
    });

    kakao.maps.event.addListener(marker, "mouseover", () => infowindow.open(state.map, marker));
    kakao.maps.event.addListener(marker, "mouseout", () => infowindow.close());
    kakao.maps.event.addListener(marker, "click", () => {
      state.map.panTo(position);
      selectSpot(spot);
    });

    state.markers.push(marker);
  });
}

// 카카오 InfoWindow는 문자열 HTML만 받으므로 이 경로에서만 이스케이프가 필요하다.
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

/* ---------- 목록 · 필터 ---------- */

function visibleSpots() {
  return state.activeTheme ? state.spots.filter((s) => s.theme === state.activeTheme) : state.spots;
}

function renderThemeFilters() {
  const box = document.getElementById("theme-filters");
  clear(box);

  const makeChip = (label, theme) => {
    const chip = el("button", "chip", label);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(state.activeTheme === theme));
    if (state.activeTheme === theme) chip.classList.add("active");
    chip.addEventListener("click", () => {
      state.activeTheme = theme;
      renderThemeFilters();
      renderSpotList();
      renderMarkers(visibleSpots());
    });
    return chip;
  };

  box.appendChild(makeChip("전체", null));
  state.themes.forEach((theme) => box.appendChild(makeChip(theme, theme)));
}

function renderSpotList() {
  const list = document.getElementById("spot-list");
  const spots = visibleSpots();
  clear(list);

  document.getElementById("spot-count").textContent = `${spots.length}곳`;

  if (spots.length === 0) {
    const li = el("li", "empty-hint", "해당 테마의 거점이 없습니다.");
    list.appendChild(li);
    return;
  }

  spots.forEach((spot) => {
    const li = el("li");
    const btn = el("button", "spot-item");
    btn.type = "button";
    if (state.selected && state.selected.id === spot.id) btn.classList.add("selected");

    const nameRow = el("span", "spot-name", spot.name);
    const status = coordStatus(spot);
    if (status !== "ok") {
      const badge = el("span", "badge badge-warn", status === "missing" ? "좌표 없음" : "좌표 확인");
      nameRow.appendChild(badge);
    }

    btn.appendChild(nameRow);
    btn.appendChild(el("span", "spot-meta", `${spot.district} · ${spot.theme}`));
    btn.addEventListener("click", () => {
      if (state.map && status !== "missing") {
        state.map.panTo(new kakao.maps.LatLng(spot.lat, spot.lng));
      }
      selectSpot(spot);
    });

    li.appendChild(btn);
    list.appendChild(li);
  });
}

/* ---------- 상세 패널 ---------- */

function selectSpot(spot) {
  state.selected = spot;
  renderSpotList();
  renderDetail(spot);
  document.getElementById("ai-answer").textContent = "";
}

function addRow(dl, label, value) {
  if (!isFilled(value)) return;
  dl.appendChild(el("dt", null, label));
  dl.appendChild(el("dd", null, value));
}

function renderDetail(spot) {
  const panel = document.getElementById("detail-panel");
  clear(panel);

  panel.appendChild(el("h2", "detail-name", spot.name));

  const badges = el("div", "badge-row");
  badges.appendChild(el("span", "badge", spot.district));
  badges.appendChild(el("span", "badge", spot.theme));
  panel.appendChild(badges);

  if (isFilled(spot.summary)) {
    panel.appendChild(el("p", "detail-summary", spot.summary));
  }

  const dl = el("dl", "kv");
  addRow(dl, "주소", spot.address);
  addRow(dl, "문의", spot.phone);
  addRow(dl, "관리기관", spot.organization);
  addRow(dl, "운영시간", spot.operating_hours);
  addRow(dl, "입장료", spot.admission);
  addRow(dl, "주차", spot.parking);
  if (dl.childNodes.length) panel.appendChild(dl);

  const actions = el("div", "actions");
  const tel = telHref(spot.phone);
  if (tel) {
    const call = el("a", "btn btn-primary", "전화 문의");
    call.href = tel;
    actions.appendChild(call);
  }
  const route = el("a", "btn", "길찾기");
  route.href = directionsHref(spot);
  route.target = "_blank";
  route.rel = "noopener";
  actions.appendChild(route);
  panel.appendChild(actions);

  const status = coordStatus(spot);
  if (status === "missing") {
    panel.appendChild(
      el("p", "notice", "이 거점은 아직 지도 좌표가 등록되지 않아 길찾기가 주소 검색으로 연결됩니다.")
    );
  } else if (status === "suspect") {
    panel.appendChild(
      el("p", "notice notice-warn", "등록된 좌표가 광주 경계 밖입니다. 주소를 다시 확인해 주세요.")
    );
  }

  if (isFilled(spot.source_name)) {
    const src = isFilled(spot.source_date)
      ? `출처: ${spot.source_name} (기준일 ${spot.source_date})`
      : `출처: ${spot.source_name}`;
    panel.appendChild(el("p", "source-line", src));
  }
}

/* ---------- 규칙 기반 빠른 안내 ---------- */

function renderFaq() {
  const box = document.getElementById("faq-questions");
  const answerBox = document.getElementById("faq-answer");
  clear(box);

  const byTheme = (theme) => {
    const names = state.spots.filter((s) => s.theme === theme).map((s) => s.name);
    return names.length ? names.join(", ") : "해당 테마의 거점이 없습니다.";
  };

  const questions = state.themes.map((theme) => ({
    label: theme,
    answer: () => byTheme(theme),
  }));

  questions.push({
    label: "전체 거점 수",
    answer: () => {
      const counts = {};
      state.spots.forEach((s) => {
        counts[s.district] = (counts[s.district] || 0) + 1;
      });
      const detail = Object.keys(counts)
        .map((d) => `${d} ${counts[d]}곳`)
        .join(", ");
      return `총 ${state.spots.length}곳 — ${detail}`;
    },
  });

  questions.forEach((q) => {
    const btn = el("button", "chip", q.label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      answerBox.textContent = q.answer();
    });
    box.appendChild(btn);
  });
}

/* ---------- AI 해설 ---------- */

function renderPersonaChips() {
  const box = document.getElementById("persona-chips");
  clear(box);

  PERSONAS.forEach((p) => {
    const chip = el("button", "chip", p.label);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(state.persona === p.id));
    if (state.persona === p.id) chip.classList.add("active");
    chip.addEventListener("click", () => {
      state.persona = p.id;
      renderPersonaChips();
    });
    box.appendChild(chip);
  });
}

function setAsking(asking) {
  state.asking = asking;
  const btn = document.getElementById("ai-ask-btn");
  btn.disabled = asking;
  btn.textContent = asking ? "생성 중" : "질문";
}

function errorMessageFor(status, payload) {
  if (payload && typeof payload.error === "string" && status === 400) return payload.error;

  switch (status) {
    case 404:
      return "선택한 거점 정보를 찾을 수 없습니다. 다시 선택해 주세요.";
    case 429:
      return "지금 AI 이용량이 많습니다. 잠시 후 다시 시도해 주세요.";
    case 500:
      return payload && payload.error
        ? payload.error
        : "서버에서 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.";
    case 502:
    case 503:
      return "AI 서비스에 일시적으로 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.";
    case 504:
      return "응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.";
    default:
      return "답변을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
}

async function askAi() {
  if (state.asking) return;

  const answerBox = document.getElementById("ai-answer");
  const input = document.getElementById("ai-question");
  const question = input.value.trim();

  if (!state.selected) {
    answerBox.textContent = "먼저 지도나 목록에서 거점을 선택해 주세요.";
    return;
  }
  if (!question) {
    answerBox.textContent = "질문을 입력해 주세요.";
    return;
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    answerBox.textContent = `질문은 ${MAX_QUESTION_LENGTH}자 이내로 입력해 주세요.`;
    return;
  }

  setAsking(true);
  answerBox.textContent = "답변을 준비하고 있습니다…";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        placeId: state.selected.id,
        persona: state.persona,
        question,
      }),
      signal: controller.signal,
    });

    // 로컬 정적 서버나 배포 설정 오류일 때는 JSON이 아니라 HTML이 돌아온다.
    let payload = null;
    try {
      payload = await res.json();
    } catch (parseErr) {
      answerBox.textContent =
        res.status === 404
          ? "AI 기능은 배포된 주소에서만 동작합니다. (정적 파일만 여는 환경에서는 /api/chat 이 없습니다)"
          : "서버 응답을 해석할 수 없습니다. 잠시 후 다시 시도해 주세요.";
      return;
    }

    if (!res.ok) {
      answerBox.textContent = errorMessageFor(res.status, payload);
      return;
    }

    const parts = [payload.answer];
    if (payload.source && payload.source.name) {
      const date = payload.source.date ? ` (기준일 ${payload.source.date})` : "";
      parts.push(`\n\n출처: ${payload.source.name}${date}`);
    }
    answerBox.textContent = parts.join("");
  } catch (err) {
    if (err.name === "AbortError") {
      answerBox.textContent = "응답이 지연되어 요청을 중단했습니다. 잠시 후 다시 시도해 주세요.";
    } else {
      console.error("[ai] 요청 실패", err);
      answerBox.textContent = "네트워크에 연결할 수 없습니다. 연결 상태를 확인해 주세요.";
    }
  } finally {
    clearTimeout(timer);
    setAsking(false);
  }
}

function setupAiForm() {
  document.getElementById("ai-ask-btn").addEventListener("click", askAi);
  document.getElementById("ai-question").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      askAi();
    }
  });
}

/* ---------- 시작 ---------- */

function showFatalError(message) {
  const list = document.getElementById("spot-list");
  clear(list);
  const li = el("li", "notice notice-warn", message);
  list.appendChild(li);
}

async function loadData() {
  const res = await fetch(DATA_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error(`데이터 응답 오류 ${res.status}`);
  const json = await res.json();
  if (!json || !Array.isArray(json.spots)) throw new Error("데이터 형식이 올바르지 않습니다");
  return json;
}

async function main() {
  setupAiForm();

  let data;
  try {
    data = await loadData();
  } catch (err) {
    console.error("[data] 로드 실패", err);
    showFatalError("거점 데이터를 불러오지 못했습니다. 페이지를 새로고침해 주세요.");
    showMapFallback("거점 데이터를 불러오지 못해 지도를 표시할 수 없습니다.");
    return;
  }

  state.spots = data.spots;
  state.themes = Array.isArray(data.themes)
    ? data.themes
    : [...new Set(state.spots.map((s) => s.theme).filter(Boolean))];

  renderThemeFilters();
  renderSpotList();
  renderPersonaChips();
  renderFaq();

  // 지도는 마지막에. 실패해도 위의 기능들은 이미 살아 있다.
  setupMap();
}

main();
