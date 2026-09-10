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

// 원본 데이터는 한국어지만 답변 언어는 바꿀 수 있다. 번역 데이터를 따로 만들지 않아도
// 외국인 관광객이 같은 근거 자료로 해설을 받는다.
const LANGUAGES = [
  { id: "ko", label: "한국어" },
  { id: "en", label: "English" },
  { id: "ja", label: "日本語" },
  { id: "zh", label: "中文" },
];

const state = {
  raw: null,
  spots: [],
  exhibitions: [],
  themes: [],
  datasets: [],
  activeTheme: null,
  districtFilter: null,
  selected: null,
  persona: "general",
  language: "ko",
  search: "",
  map: null,
  markers: [],
  asking: false,
  pendingAsk: null, // 진행 중인 /api/chat 요청의 AbortController
  userPos: null, // 위치 권한을 허용했을 때만 채워진다
  sortByDistance: false,
  // 자연어 탐색 결과. null = 적용 안 됨, 배열 = AI(또는 폴백)가 고른 거점 id 순서대로
  discoverIds: null,
  discovering: false,
  mapPopup: null, // 열려 있는 마커 팝업(CustomOverlay). 한 번에 하나만 띄운다.
  pendingDiscover: null, // 진행 중인 추천 요청의 AbortController
};

// 무엇을 입력해야 할지 모르면 입력창은 비어 있는 채로 남는다. 예시를 눌러서 시작할 수 있게 한다.
const DISCOVER_EXAMPLES = ["아이와 함께", "5·18 발자취", "서원·향교", "박물관 위주"];

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

// 칩을 누르면 그 줄을 통째로 다시 그리기 때문에 눌렀던 버튼이 사라지고
// 키보드 포커스가 문서로 튕긴다. 같은 자리의 버튼으로 포커스를 되돌린다.
function refocus(containerId, index) {
  const box = document.getElementById(containerId);
  const target = box && box.children[index];
  if (target && typeof target.focus === "function") target.focus();
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

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * R * Math.asin(Math.sqrt(h));
}

function distanceFromUser(spot) {
  if (!state.userPos || coordStatus(spot) === "missing") return null;
  return haversineKm(state.userPos, spot);
}

function formatDistance(km) {
  if (km === null) return "";
  return km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(1)}km`;
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
        // 공유 링크로 특정 거점을 열었다면 그곳을, 아니면 좌표가 있는 첫 거점을 중심으로 잡는다.
        const selected = state.selected && coordStatus(state.selected) !== "missing" ? state.selected : null;
        const anchor = selected || state.spots.find((s) => coordStatus(s) === "ok");
        state.map = new kakao.maps.Map(document.getElementById("map"), {
          center: new kakao.maps.LatLng(
            anchor ? anchor.lat : GWANGJU_CENTER.lat,
            anchor ? anchor.lng : GWANGJU_CENTER.lng
          ),
          level: selected ? 5 : 8,
        });
        // 지도 빈 곳을 누르면 열려 있는 팝업을 닫는다.
        kakao.maps.event.addListener(state.map, "click", closeMapPopup);
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

/* ---------- 마커 모양 ----------
   기본 마커는 전부 같은 빨간 핀이라 지도만 봐서는 어떤 성격의 장소인지 알 수 없다.
   테마별로 색을 나눠 두면 목록을 읽지 않고도 "이 동네는 서원이 많구나"가 보인다.
   색만으로 구분하지 않도록 선택 상태는 크기와 흰 테두리로도 표시한다. */

const THEME_MARKER_COLORS = {
  "호국·의병 유적": "#2a6b5b",
  "민주화·독립운동": "#1d5a94",
  "서원·향교·누각": "#9a6420",
  "박물관·체험": "#6a4c93",
};
const MARKER_COLOR_DEFAULT = "#4a515a";
// 좌표가 광주 경계 밖인 거점은 지도에서도 바로 눈에 띄어야 한다.
const MARKER_COLOR_SUSPECT = "#8a5a06";

function markerColorFor(spot) {
  if (coordStatus(spot) === "suspect") return MARKER_COLOR_SUSPECT;
  return THEME_MARKER_COLORS[spot.theme] || MARKER_COLOR_DEFAULT;
}

// 핀을 SVG 로 직접 그려 data URI 로 넘긴다. 이미지 파일을 두지 않으므로
// 색을 바꾸는 데 에셋 추가·배포가 필요 없고, 어떤 배율에서도 또렷하다.
function markerSvg(color, selected) {
  const ring = selected
    ? '<circle cx="16" cy="15" r="12" fill="none" stroke="#fff" stroke-width="2.5" opacity="0.95"/>'
    : "";
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 42">' +
    '<path d="M16 41C16 41 30 25.5 30 15A14 14 0 1 0 2 15c0 10.5 14 26 14 26z" fill="' +
    color +
    '" stroke="#ffffff" stroke-width="2"/>' +
    '<circle cx="16" cy="15" r="5.5" fill="#ffffff"/>' +
    ring +
    "</svg>";
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

function markerImageFor(spot, selected) {
  // MarkerImage 를 제공하지 않는 환경이면 기본 마커로 둔다 — 지도가 아예 안 뜨는 것보다 낫다.
  if (typeof kakao.maps.MarkerImage !== "function") return null;

  const w = selected ? 38 : 30;
  const h = selected ? 50 : 39;
  try {
    return new kakao.maps.MarkerImage(
      markerSvg(markerColorFor(spot), selected),
      new kakao.maps.Size(w, h),
      // 핀 끝(아래 가운데)이 실제 좌표에 닿아야 위치가 어긋나 보이지 않는다.
      { offset: new kakao.maps.Point(w / 2, h) }
    );
  } catch (err) {
    console.warn("[map] 마커 이미지 생성 실패 — 기본 마커를 씁니다", err);
    return null;
  }
}

function clearMarkers() {
  state.markers.forEach((entry) => entry.marker.setMap(null));
  state.markers = [];
}

// 선택이 바뀌었을 때 마커를 다시 만들지 않고 이미지만 갈아끼운다.
// 다시 만들면 열려 있던 팝업이 함께 사라진다.
function refreshMarkerStyles() {
  if (!state.markers.length) return;
  state.markers.forEach((entry) => {
    const selected = !!(state.selected && state.selected.id === entry.spot.id);
    if (entry.selected === selected) return;
    entry.selected = selected;
    const image = markerImageFor(entry.spot, selected);
    if (image) entry.marker.setImage(image);
    // 선택한 핀이 다른 핀에 가리지 않도록 위로 올린다.
    if (typeof entry.marker.setZIndex === "function") entry.marker.setZIndex(selected ? 10 : 1);
  });
}

function renderMarkers(spots) {
  if (!state.map) return;
  closeMapPopup();
  clearMarkers();

  spots.forEach((spot) => {
    if (coordStatus(spot) === "missing") return;

    const position = new kakao.maps.LatLng(spot.lat, spot.lng);
    const selected = !!(state.selected && state.selected.id === spot.id);
    const image = markerImageFor(spot, selected);

    const options = { position, map: state.map, title: spot.name };
    if (image) options.image = image;
    const marker = new kakao.maps.Marker(options);

    kakao.maps.event.addListener(marker, "click", () => {
      state.map.panTo(position);
      // 팝업이 지도 위에 떠 있으므로 상세 패널로 화면을 옮기지 않는다.
      // 옮기면 방금 연 팝업이 화면 밖으로 밀려난다. 이동은 팝업의 버튼이 맡는다.
      selectSpot(spot, { reveal: false });
      openMapPopup(spot, position);
    });

    state.markers.push({ spot, marker, selected });
  });
}

// 고른 거점들이 한눈에 들어오도록 지도 시점을 맞춘다.
// 이게 없으면 목록만 3곳으로 줄고 지도는 광주 전체를 비춘 채라, 마커가 사라진 것처럼만 보인다.
function fitMapTo(spots) {
  // 지도가 실패했거나 SDK가 부분만 로드된 경우에도 목록·AI는 계속 동작해야 한다.
  if (!state.map || typeof kakao === "undefined" || !kakao.maps) return;
  if (typeof kakao.maps.LatLngBounds !== "function") return;

  const points = spots.filter((s) => coordStatus(s) !== "missing");
  if (!points.length) return;

  // 한 곳뿐이면 bounds 가 점 하나라 최대 배율까지 당겨져 주변 맥락이 사라진다. 이동만 한다.
  if (points.length === 1) {
    state.map.panTo(new kakao.maps.LatLng(points[0].lat, points[0].lng));
    return;
  }

  try {
    const bounds = new kakao.maps.LatLngBounds();
    points.forEach((s) => bounds.extend(new kakao.maps.LatLng(s.lat, s.lng)));
    state.map.setBounds(bounds);
  } catch (err) {
    // 시점 조정에 실패해도 마커는 이미 그려져 있다. 지도를 건드리지 않고 넘어간다.
    console.warn("[map] 시점 조정 실패 — 지도는 그대로 둡니다", err);
  }
}

/* ---------- 마커 팝업 ----------
   InfoWindow 는 문자열 HTML 만 받아 데이터를 끼워 넣어야 하지만, CustomOverlay 는
   DOM 노드를 그대로 받는다. el() 로 만들어 넘기면 문자열 조립이 없어 이스케이프도 필요 없다. */

function closeMapPopup() {
  if (state.mapPopup) {
    state.mapPopup.setMap(null);
    state.mapPopup = null;
  }
}

function buildMapPopup(spot) {
  const box = el("div", "map-popup");

  const head = el("div", "map-popup-head");
  head.appendChild(el("strong", "map-popup-name", spot.name));

  const close = el("button", "map-popup-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "닫기");
  close.addEventListener("click", closeMapPopup);
  head.appendChild(close);
  box.appendChild(head);

  const badges = el("div", "map-popup-badges");
  badges.appendChild(el("span", "badge", spot.district));
  badges.appendChild(el("span", "badge", spot.theme));
  box.appendChild(badges);

  if (isFilled(spot.summary)) {
    box.appendChild(el("p", "map-popup-summary", spot.summary));
  }

  if (coordStatus(spot) === "suspect") {
    box.appendChild(el("p", "map-popup-warn", "등록된 좌표가 광주 경계 밖입니다."));
  }

  const actions = el("div", "map-popup-actions");

  const more = el("button", "btn btn-primary map-popup-btn", "상세 보기");
  more.type = "button";
  more.addEventListener("click", () => {
    closeMapPopup();
    revealDetail();
  });
  actions.appendChild(more);

  const route = el("a", "btn map-popup-btn", "길찾기");
  route.href = directionsHref(spot);
  route.target = "_blank";
  route.rel = "noopener";
  actions.appendChild(route);

  box.appendChild(actions);
  return box;
}

function openMapPopup(spot, position) {
  if (!state.map || typeof kakao.maps.CustomOverlay !== "function") return;
  closeMapPopup();

  try {
    state.mapPopup = new kakao.maps.CustomOverlay({
      position,
      content: buildMapPopup(spot),
      // 핀 위에 뜨도록. 1이면 팝업 아래끝이 좌표에 붙어 핀을 가린다.
      yAnchor: 1.35,
      zIndex: 20,
    });
    state.mapPopup.setMap(state.map);
  } catch (err) {
    // 팝업이 없어도 상세 패널에 같은 내용이 이미 들어가 있다. 조용히 넘어간다.
    console.warn("[map] 팝업을 열지 못했습니다", err);
    state.mapPopup = null;
  }
}

/* ---------- 목록 · 필터 ---------- */

function visibleSpots() {
  // AI 추천이 적용돼 있으면 그 결과가 목록의 출발점이다. 순서도 AI가 매긴 순서를 지킨다 —
  // 원본 순서로 되돌리면 "가장 잘 맞는 곳이 맨 위"라는 정보가 사라진다.
  let filtered;
  if (Array.isArray(state.discoverIds)) {
    const byId = new Map(state.spots.map((s) => [Number(s.id), s]));
    filtered = state.discoverIds.map((id) => byId.get(Number(id))).filter(Boolean);
  } else {
    filtered = state.spots.slice();
  }

  if (state.activeTheme) filtered = filtered.filter((s) => s.theme === state.activeTheme);
  if (state.districtFilter) filtered = filtered.filter((s) => s.district === state.districtFilter);

  if (state.search) {
    const q = state.search.toLowerCase();
    filtered = filtered.filter((s) =>
      [s.name, s.address, s.district, s.theme, s.organization]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }

  if (!state.sortByDistance || !state.userPos) return filtered;

  // 좌표가 없는 거점은 거리를 잴 수 없으므로 뒤로 보낸다.
  return filtered.slice().sort((a, b) => {
    const da = distanceFromUser(a);
    const db = distanceFromUser(b);
    if (da === null && db === null) return 0;
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  });
}

function renderThemeFilters() {
  const box = document.getElementById("theme-filters");
  clear(box);

  const makeChip = (label, theme) => {
    const chip = el("button", "chip", label);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(state.activeTheme === theme));
    if (state.activeTheme === theme) chip.classList.add("active");
    chip.addEventListener("click", (e) => {
      const index = [...e.currentTarget.parentNode.children].indexOf(e.currentTarget);
      state.activeTheme = theme;
      state.districtFilter = null; // 테마를 고르면 자치구 한정은 푼다
      // 테마를 직접 고른다는 건 AI 추천을 그만 보겠다는 뜻이다. 둘이 겹치면
      // 목록이 왜 이렇게 나왔는지 설명할 수 없다.
      state.discoverIds = null;
      cancelPendingDiscover();
      setDiscoverStatus("");
      renderThemeFilters();
      renderSpotList();
      renderMarkers(visibleSpots());
      setLocationStatus("");
      refocus("theme-filters", index);
    });
    return chip;
  };

  box.appendChild(makeChip("전체", null));
  state.themes.forEach((theme) => box.appendChild(makeChip(theme, theme)));

  if (state.districtFilter) {
    const active = el("button", "chip active", `${state.districtFilter} 해제`);
    active.type = "button";
    active.addEventListener("click", () => {
      state.districtFilter = null;
      renderThemeFilters();
      renderSpotList();
      renderMarkers(visibleSpots());
      setLocationStatus("");
    });
    box.appendChild(active);
  }
}

function renderSpotList() {
  const list = document.getElementById("spot-list");
  const spots = visibleSpots();
  clear(list);

  document.getElementById("spot-count").textContent = `${spots.length}곳`;

  if (spots.length === 0) {
    const message = state.search
      ? `'${state.search}' 검색 결과가 없습니다.`
      : "조건에 맞는 거점이 없습니다.";
    list.appendChild(el("li", "empty-hint", message));
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

    const km = distanceFromUser(spot);
    const meta = km === null
      ? `${spot.district} · ${spot.theme}`
      : `${formatDistance(km)} · ${spot.district} · ${spot.theme}`;
    btn.appendChild(el("span", "spot-meta", meta));
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

/* ---------- 자연어 탐색 (AI가 필터를 대신 걸어준다) ----------
   지금까지는 사용자가 테마를 고르고 검색어를 넣어 18곳을 직접 좁혀야 했다.
   AI가 그 판단을 대신 하면 "아이랑 반나절"처럼 데이터에 없는 말로도 찾을 수 있다.
   단, AI가 죽어도 탐색 자체는 살아야 하므로 실패하면 규칙 기반 검색으로 넘어간다. */

// 사용자가 테마를 고르거나 추천을 지우면, 날아오고 있던 이전 추천 응답은 버려야 한다.
// 그대로 두면 늦게 도착한 응답이 방금 한 선택을 조용히 덮어쓴다.
function cancelPendingDiscover() {
  if (!state.pendingDiscover) return;
  state.pendingDiscover.superseded = true; // 타임아웃이 아니라 의도적 취소라는 표시
  state.pendingDiscover.abort();
  state.pendingDiscover = null;
}

function setDiscovering(on) {
  state.discovering = on;
  const btn = document.getElementById("discover-btn");
  if (!btn) return;
  btn.disabled = on;
  btn.textContent = on ? "찾는 중" : "AI 추천";
}

function setDiscoverStatus(message, withReset) {
  const box = document.getElementById("discover-result");
  if (!box) return;
  clear(box);
  if (!message) return;

  box.appendChild(el("span", "discover-msg", message));

  if (withReset) {
    const reset = el("button", "linkish", "전체 보기");
    reset.type = "button";
    reset.addEventListener("click", clearDiscover);
    box.appendChild(reset);
  }
}

function clearDiscover() {
  cancelPendingDiscover();
  state.discoverIds = null;
  const input = document.getElementById("discover-input");
  if (input) input.value = "";
  setDiscoverStatus("");
  renderSpotList();

  // 추천을 풀면 지도도 원래대로 — 18곳이 다 보이는 시점으로 되돌린다.
  const all = visibleSpots();
  renderMarkers(all);
  fitMapTo(all);
}

// 추천 결과를 목록·지도에 반영한다. 경쟁하는 다른 필터는 풀어준다 —
// 테마 칩이 켜진 채로 추천이 겹치면 왜 이 목록이 나왔는지 설명할 수 없다.
function applyDiscoverIds(ids, message) {
  state.discoverIds = ids;
  state.activeTheme = null;
  state.districtFilter = null;
  state.search = "";
  const search = document.getElementById("spot-search");
  if (search) search.value = "";

  renderThemeFilters();
  renderSpotList();

  const shown = visibleSpots();
  renderMarkers(shown);
  fitMapTo(shown);

  setLocationStatus("");
  setDiscoverStatus(message, true);
  revealDiscover();
}

// 추천 상자를 화면 위로 올린다. 목록(.panel-list)으로 스크롤하면 방금 받은
// "왜 이 곳들인가" 설명이 화면 밖으로 밀려나므로, 상자 자체를 기준으로 잡는다.
// 상자 위에서 결과 첫 줄까지가 한 화면에 들어온다.
function revealDiscover() {
  const box = document.querySelector(".discover");
  if (!box) return;

  requestAnimationFrame(() => {
    const rect = box.getBoundingClientRect();
    // 이미 위쪽에 자리잡고 있으면 다시 흔들지 않는다.
    if (rect.top >= 0 && rect.top < window.innerHeight * 0.25) return;

    try {
      box.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "start",
      });
    } catch (err) {
      box.scrollIntoView();
    }
  });
}

// AI가 못 쓸 때의 대체 경로. 이름·테마·자치구·요약에서 낱말을 찾는다.
// TODO 값은 isFilled 로 걸러 매칭 대상에서 뺀다 — 미작성 필드가 검색에 걸리면 안 된다.
function applyKeywordFallback(query, note) {
  const tokens = query
    .toLowerCase()
    .split(/[\s,·]+/)
    .filter((t) => t.length >= 2);

  const matched = tokens.length
    ? state.spots.filter((s) => {
        const hay = [s.name, s.theme, s.district, s.summary, s.visit_tips]
          .filter(isFilled)
          .join(" ")
          .toLowerCase();
        return tokens.some((t) => hay.includes(t));
      })
    : [];

  if (!matched.length) {
    state.discoverIds = null;
    renderSpotList();
    const all = visibleSpots();
    renderMarkers(all);
    fitMapTo(all);
    setDiscoverStatus(
      note
        ? `${note} 그리고 '${query}'에 맞는 거점도 찾지 못했습니다.`
        : `'${query}'에 맞는 거점을 찾지 못했습니다. 다른 말로 해보시겠어요?`
    );
    return;
  }

  applyDiscoverIds(
    matched.map((s) => Number(s.id)),
    `${note ? note + " " : ""}일반 검색으로 ${matched.length}곳을 찾았습니다.`
  );
}

async function runDiscover() {
  if (state.discovering) return;

  const input = document.getElementById("discover-input");
  const query = input ? input.value.trim() : "";
  if (!query) {
    setDiscoverStatus("찾고 싶은 조건을 입력해 주세요. 예: 아이와 함께");
    return;
  }

  setDiscovering(true);
  setDiscoverStatus("AI가 조건에 맞는 거점을 고르는 중입니다…");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  state.pendingDiscover = controller;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "discover", query }),
      signal: controller.signal,
    });

    // 정적 서버로 열었거나 배포 설정이 어긋나면 JSON 이 아니라 HTML 이 돌아온다.
    let payload = null;
    try {
      payload = await res.json();
    } catch (parseErr) {
      payload = null;
    }

    if (!res.ok || !payload || !Array.isArray(payload.ids)) {
      applyKeywordFallback(query, "AI 추천을 쓸 수 없어");
      return;
    }

    // AI가 "맞는 곳 없음"이라고 했어도 낱말은 걸릴 수 있으니 한 번 더 훑는다.
    if (!payload.ids.length) {
      applyKeywordFallback(query, "");
      return;
    }

    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    applyDiscoverIds(
      payload.ids,
      reason ? `${reason} (${payload.ids.length}곳)` : `${payload.ids.length}곳을 찾았습니다.`
    );
  } catch (err) {
    if (err.name === "AbortError") {
      // 사용자가 다른 조작을 해서 취소된 경우에는 아무 말도 남기지 않는다.
      // 그 조작의 결과가 이미 화면에 있으므로, 여기서 폴백을 돌리면 그걸 덮어쓴다.
      if (controller.superseded) return;
      applyKeywordFallback(query, "AI 추천이 지연되어");
    } else {
      console.error("[discover] 요청 실패", err);
      applyKeywordFallback(query, "AI에 연결하지 못해");
    }
  } finally {
    clearTimeout(timer);
    if (state.pendingDiscover === controller) state.pendingDiscover = null;
    setDiscovering(false);
  }
}

function renderDiscoverExamples() {
  const box = document.getElementById("discover-examples");
  if (!box) return;
  clear(box);

  DISCOVER_EXAMPLES.forEach((example) => {
    const chip = el("button", "chip chip-sm", example);
    chip.type = "button";
    chip.addEventListener("click", () => {
      const input = document.getElementById("discover-input");
      if (input) input.value = example;
      runDiscover();
    });
    box.appendChild(chip);
  });
}

function setupDiscover() {
  const btn = document.getElementById("discover-btn");
  const input = document.getElementById("discover-input");
  if (btn) btn.addEventListener("click", runDiscover);
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runDiscover();
      }
    });
  }
  renderDiscoverExamples();
}

/* ---------- 상세 패널 ---------- */

function shareUrlFor(spot) {
  const url = new URL(window.location.href);
  url.searchParams.set("place", spot.id);
  url.hash = "";
  return url.toString();
}

/* ---------- 선택 → 상세로 데려가기 ---------- */

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// 상세 패널은 이제 화면 폭과 관계없이 지도 섹션 "아래"에 있다.
// (3단 나란히 배치를 히어로+섹션 리듬으로 바꾸면서 생긴 구조 변화다.)
// 거점을 눌러도 화면이 그대로면 아무 일도 안 일어난 것처럼 보이므로
// 폭을 따지지 않고 선택한 내용이 있는 곳으로 데려간다.
// 이미 화면에 들어와 있으면 아래 가시성 검사에서 걸러진다.
function revealDetail() {
  const panel = document.getElementById("detail-panel");
  if (!panel) return;

  // 클릭 직후에는 방금 다시 그린 DOM의 위치가 아직 확정되지 않았을 수 있다.
  requestAnimationFrame(() => {
    const rect = panel.getBoundingClientRect();

    // 이미 화면에 충분히 들어와 있으면 다시 스크롤해 흔들지 않는다.
    const alreadyVisible = rect.top >= 0 && rect.top < window.innerHeight * 0.6;
    if (alreadyVisible) return;

    try {
      panel.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "start",
      });
    } catch (err) {
      // 옵션 객체를 못 받는 구형 브라우저는 인자 없이 부른다.
      panel.scrollIntoView();
    }
  });
}

function scrollToList() {
  const list = document.querySelector(".panel-list");
  if (!list) return;
  try {
    list.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  } catch (err) {
    list.scrollIntoView();
  }
}

function selectSpot(spot, options) {
  // 거점을 바꾸면 이전 거점에 대한 요청은 버린다.
  // 그대로 두면 앞선 답변이 새 거점 화면에 도착한다.
  if (state.pendingAsk) {
    state.pendingAsk.abort();
    state.pendingAsk = null;
  }

  state.selected = spot;
  renderSpotList();
  renderDetail(spot);
  refreshMarkerStyles();
  document.getElementById("ai-answer").textContent = "";
  clearHandoff();
  // 마커에서 고른 경우에는 팝업이 지도 위에 떠 있으므로 화면을 옮기지 않는다.
  if (!options || options.reveal !== false) revealDetail();

  // 주소창을 갱신해 두면 이 화면 그대로 공유·재방문할 수 있다.
  // file:// 등 일부 환경에서는 replaceState가 막히므로 실패해도 넘어간다.
  try {
    window.history.replaceState({}, "", shareUrlFor(spot));
  } catch (err) {
    /* 주소창 갱신 실패는 기능에 영향 없음 */
  }
}

function addRow(dl, label, value) {
  if (!isFilled(value)) return;
  dl.appendChild(el("dt", null, label));
  dl.appendChild(el("dd", null, value));
}

function renderDetail(spot) {
  const panel = document.getElementById("detail-panel");
  clear(panel);

  // 상세로 내려오면 목록이 화면 위로 밀린다. 돌아갈 길을 만들어 준다.
  const back = el("button", "back-to-list", "← 목록으로");
  back.type = "button";
  back.addEventListener("click", scrollToList);
  panel.appendChild(back);

  // 섹션 제목("거점 상세")이 이미 h2다. 거점 이름을 h2로 두면 같은 층에
  // 제목이 둘이 되어 스크린리더의 문서 구조가 어긋난다. 한 단계 낮춘다.
  panel.appendChild(el("h3", "detail-name", spot.name));

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

  const share = el("button", "btn", "링크 복사");
  share.type = "button";
  share.addEventListener("click", () => copyShareLink(spot, share));
  actions.appendChild(share);

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

async function copyShareLink(spot, button) {
  const link = shareUrlFor(spot);

  // 연타하면 두 번째 호출이 "복사됨"을 원래 라벨로 기억해, 버튼이 그 상태로 굳는다.
  // 원래 라벨은 버튼에 한 번만 새겨두고, 앞선 되돌리기 타이머는 취소한다.
  if (!button.dataset.label) button.dataset.label = button.textContent;
  if (button.dataset.restoreTimer) clearTimeout(Number(button.dataset.restoreTimer));

  const done = (label) => {
    button.textContent = label;
    button.dataset.restoreTimer = String(
      setTimeout(() => {
        button.textContent = button.dataset.label;
        delete button.dataset.restoreTimer;
      }, 1800)
    );
  };

  // clipboard API는 HTTPS(또는 localhost)에서만 동작한다. 실패하면 주소를 직접 보여준다.
  try {
    await navigator.clipboard.writeText(link);
    done("복사됨");
  } catch (err) {
    const panel = document.getElementById("detail-panel");
    const existing = panel.querySelector(".share-fallback");
    if (existing) existing.remove();

    const box = el("p", "notice share-fallback", `아래 주소를 직접 복사해 주세요: ${link}`);
    panel.appendChild(box);
    done("복사 실패");
  }
}

/* ---------- 내 위치 ---------- */

function setLocationStatus(message, isError) {
  const node = document.getElementById("location-status");
  node.textContent = message || "";
  node.classList.toggle("status-error", Boolean(isError));
}

function geolocationErrorMessage(err) {
  if (!err || typeof err.code !== "number") return "현재 위치를 확인하지 못했습니다.";
  if (err.code === 1) return "위치 권한이 거부되었습니다. 브라우저 주소창의 권한 설정에서 허용해 주세요.";
  if (err.code === 2) return "현재 위치를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  if (err.code === 3) return "위치 확인이 지연되고 있습니다. 다시 시도해 주세요.";
  return "현재 위치를 확인하지 못했습니다.";
}

function requestLocation() {
  const button = document.getElementById("nearby-btn");

  // 이미 켜져 있으면 원래 순서로 되돌린다.
  if (state.sortByDistance) {
    state.sortByDistance = false;
    button.classList.remove("active");
    button.setAttribute("aria-pressed", "false");
    setLocationStatus("");
    renderSpotList();
    return;
  }

  if (!state.spots.some((s) => coordStatus(s) !== "missing")) {
    setLocationStatus("거점 좌표가 아직 등록되지 않아 거리를 계산할 수 없습니다.", true);
    return;
  }

  if (!("geolocation" in navigator)) {
    setLocationStatus("이 브라우저는 위치 기능을 지원하지 않습니다.", true);
    return;
  }

  if (window.isSecureContext === false) {
    setLocationStatus("위치 기능은 https 주소에서만 동작합니다. 배포된 주소에서 사용해 주세요.", true);
    return;
  }

  // 이미 위치를 받아둔 상태면 다시 묻지 않는다.
  if (state.userPos) {
    applyNearbySort();
    return;
  }

  button.disabled = true;
  setLocationStatus("현재 위치를 확인하는 중…");

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      button.disabled = false;
      applyNearbySort();
    },
    (err) => {
      button.disabled = false;
      setLocationStatus(geolocationErrorMessage(err), true);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
}

function applyNearbySort() {
  const button = document.getElementById("nearby-btn");
  state.sortByDistance = true;
  button.classList.add("active");
  button.setAttribute("aria-pressed", "true");

  const nearest = visibleSpots()[0];
  const km = nearest ? distanceFromUser(nearest) : null;
  setLocationStatus(
    km === null
      ? "현재 위치를 기준으로 정렬했습니다."
      : `가장 가까운 거점은 ${nearest.name} (${formatDistance(km)}) 입니다.`
  );

  renderSpotList();
}

/* ---------- 지금 광주에서 (전시회) ---------- */

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function exhibitionPhase(ex, today) {
  if (!ex.start_date || !ex.end_date) return "unknown";
  if (ex.end_date < today) return "past";
  if (ex.start_date > today) return "upcoming";
  return "ongoing";
}

function formatPeriod(ex) {
  if (!ex.start_date && !ex.end_date) return "일정 미정";
  const trim = (d) => (d ? d.replace(/^\d{4}-/, "").replace("-", ".") : "?");
  return `${trim(ex.start_date)} ~ ${trim(ex.end_date)}`;
}

function renderExhibitions() {
  const band = document.getElementById("exhibition-band");
  const box = document.getElementById("exhibition-list");

  // 아직 CSV를 변환하지 않았으면 이 영역 자체를 감춘다. 빈 섹션을 보여주지 않는다.
  if (!state.exhibitions.length) {
    band.hidden = true;
    return;
  }

  const today = todayIso();
  const ranked = state.exhibitions
    .map((ex) => ({ ex, phase: exhibitionPhase(ex, today) }))
    .filter((row) => row.phase !== "past")
    .sort((a, b) => {
      const order = { ongoing: 0, upcoming: 1, unknown: 2 };
      if (order[a.phase] !== order[b.phase]) return order[a.phase] - order[b.phase];
      return String(a.ex.start_date || "").localeCompare(String(b.ex.start_date || ""));
    });

  // 진행 중·예정이 하나도 없으면 최근 것이라도 보여준다 (과거 데이터만 있는 경우).
  const rows = ranked.length
    ? ranked.slice(0, 6)
    : state.exhibitions
        .slice()
        .sort((a, b) => String(b.start_date || "").localeCompare(String(a.start_date || "")))
        .slice(0, 3)
        .map((ex) => ({ ex, phase: "past" }));

  if (!rows.length) {
    band.hidden = true;
    return;
  }

  band.hidden = false;
  clear(box);

  const phaseLabel = { ongoing: "진행 중", upcoming: "예정", past: "종료", unknown: "일정 미정" };

  rows.forEach(({ ex, phase }) => {
    const card = el("article", "exhibition-card");

    const top = el("div", "exhibition-top");
    top.appendChild(el("span", `badge phase-${phase}`, phaseLabel[phase]));
    // 날짜가 아예 없으면 뱃지가 이미 "일정 미정"이라, 기간까지 같은 문구로 찍으면 두 번 나온다.
    if (phase !== "unknown") {
      top.appendChild(el("span", "exhibition-period", formatPeriod(ex)));
    }
    card.appendChild(top);

    card.appendChild(el("h3", "exhibition-name", ex.name));
    if (ex.venue) card.appendChild(el("p", "exhibition-venue", ex.venue));

    const facts = [];
    if (ex.items) facts.push(ex.items);
    if (ex.booths) facts.push(`부스 ${ex.booths}개`);
    if (ex.companies) facts.push(`참여 ${ex.companies}개사`);
    if (facts.length) card.appendChild(el("p", "exhibition-facts", facts.join(" · ")));

    // 두 데이터셋을 잇는 지점: 전시 장소의 자치구로 해설 거점을 연결한다.
    if (ex.district) {
      const nearby = state.spots.filter((s) => s.district === ex.district);
      if (nearby.length) {
        const link = el("button", "linkish", `${ex.district}의 해설 거점 ${nearby.length}곳 보기`);
        link.type = "button";
        link.addEventListener("click", () => focusDistrict(ex.district));
        card.appendChild(link);
      }
    }

    if (ex.website) {
      const site = el("a", "exhibition-site", "전시 홈페이지");
      site.href = ex.website;
      site.target = "_blank";
      site.rel = "noopener";
      card.appendChild(site);
    }

    box.appendChild(card);
  });
}

// 전시 카드에서 자치구를 눌렀을 때 목록·지도를 그 자치구로 좁힌다.
function focusDistrict(district) {
  state.activeTheme = null;
  state.districtFilter = district;
  state.discoverIds = null;
  cancelPendingDiscover();
  setDiscoverStatus("");
  renderThemeFilters();
  renderSpotList();
  renderMarkers(visibleSpots());
  setLocationStatus(`${district}의 해설 거점만 표시하고 있습니다.`);
  document.querySelector(".layout").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------- 활용한 공공데이터 ---------- */

function renderQuality() {
  const quality = state.raw && state.raw.data_quality;
  const block = document.getElementById("quality-block");

  if (!quality || !Array.isArray(quality.findings) || !quality.findings.length) {
    block.hidden = true;
    return;
  }

  block.hidden = false;
  document.getElementById("quality-note").textContent = quality.note || "";

  const list = document.getElementById("quality-list");
  clear(list);

  quality.findings.forEach((f) => {
    const item = el("div", "quality-item");

    const head = el("div", "quality-head");
    head.appendChild(el("span", `badge kind-${f.kind}`, f.kind));
    head.appendChild(el("span", "quality-dataset", f.dataset));
    if (f.affected) head.appendChild(el("span", "quality-affected", `${f.affected}건`));
    item.appendChild(head);

    item.appendChild(el("p", "quality-issue", f.issue));
    item.appendChild(el("p", "quality-action", f.action));
    list.appendChild(item);
  });
}

// 건수는 실제 로드된 배열에서 센다. 선언만 해두고 데이터가 없으면 0이 된다.
function recordCount(ds) {
  const collections = { spots: state.spots, exhibitions: state.exhibitions };
  const arr = collections[ds.record_key];
  return Array.isArray(arr) ? arr.length : 0;
}

function renderDatasets() {
  const box = document.getElementById("dataset-list");
  clear(box);

  // 실제로 데이터가 들어온 데이터셋만 보여준다. 쓰지도 않는 데이터를 활용했다고 적지 않는다.
  const active = state.datasets.filter((ds) => recordCount(ds) > 0);

  if (!active.length) {
    box.appendChild(el("p", "empty-hint", "등록된 데이터셋 정보가 없습니다."));
    return;
  }

  active.forEach((ds) => {
    const card = el("article", "dataset-card");

    const head = el("div", "dataset-head");
    head.appendChild(el("h3", "dataset-name", ds.name));
    const tags = el("div", "dataset-tags");
    if (ds.format) tags.appendChild(el("span", "badge", ds.format));
    if (ds.source_date) tags.appendChild(el("span", "badge", `기준일 ${ds.source_date}`));
    head.appendChild(tags);
    card.appendChild(head);

    if (ds.provider) card.appendChild(el("p", "dataset-provider", ds.provider));

    card.appendChild(
      el("p", "dataset-count", `${recordCount(ds)}${ds.record_unit || "건"}`)
    );

    if (Array.isArray(ds.powers) && ds.powers.length) {
      card.appendChild(el("p", "dataset-label", "이 데이터가 구동하는 기능"));
      const ul = el("ul", "dataset-powers");
      ds.powers.forEach((p) => ul.appendChild(el("li", null, p)));
      card.appendChild(ul);
    }

    if (ds.url) {
      const link = el("a", "dataset-link", "원본 데이터 보기");
      link.href = ds.url;
      link.target = "_blank";
      link.rel = "noopener";
      card.appendChild(link);
    }

    box.appendChild(card);
  });
}

/* ---------- 교차 검증 출처 ----------
   거점마다 어떤 자료를 근거로 삼았는지는 상세 화면에 한 줄씩 흩어져 있다.
   모아 세지 않으면 "데이터셋 1종"으로만 보이는데, 실제로 대조한 자료는 그보다 많다.
   숫자는 화면에 박아두지 않고 데이터에서 센다 — 출처가 늘거나 줄면 저절로 따라간다. */

function renderSources() {
  const block = document.getElementById("sources-block");
  const list = document.getElementById("sources-list");
  if (!block || !list) return;

  // 한 거점이 여러 자료를 대조한 경우 " · " 로 이어 붙여 두었다.
  const counts = new Map();
  state.spots.forEach((spot) => {
    if (!isFilled(spot.source_name)) return;
    spot.source_name.split(" · ").forEach((raw) => {
      const name = raw.trim();
      if (!name) return;
      counts.set(name, (counts.get(name) || 0) + 1);
    });
  });

  if (!counts.size) {
    block.hidden = true;
    return;
  }
  block.hidden = false;

  const hint = document.getElementById("sources-hint");
  if (hint) hint.textContent = `${counts.size}종`;

  clear(list);
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"))
    .forEach(([name, used]) => {
      const item = el("li", "source-item");
      item.appendChild(el("span", "source-name", name));
      item.appendChild(el("span", "source-count", `${used}곳`));
      list.appendChild(item);
    });
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

  PERSONAS.forEach((p, idx) => {
    const chip = el("button", "chip", p.label);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(state.persona === p.id));
    if (state.persona === p.id) chip.classList.add("active");
    chip.addEventListener("click", () => {
      state.persona = p.id;
      renderPersonaChips();
      refocus("persona-chips", idx);
    });
    box.appendChild(chip);
  });
}

function renderLanguageChips() {
  const box = document.getElementById("language-chips");
  clear(box);

  LANGUAGES.forEach((lang, idx) => {
    const chip = el("button", "chip chip-sm", lang.label);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(state.language === lang.id));
    if (state.language === lang.id) chip.classList.add("active");
    chip.addEventListener("click", () => {
      state.language = lang.id;
      renderLanguageChips();
      refocus("language-chips", idx);
    });
    box.appendChild(chip);
  });
}

/* ---------- 데이터로 본 광주 ---------- */

function renderInsights() {
  const box = document.getElementById("insight-block");
  clear(box);
  if (!state.spots.length) return;

  const total = state.spots.length;

  const countBy = (key) => {
    const counts = {};
    state.spots.forEach((s) => {
      const k = s[key];
      if (k) counts[k] = (counts[k] || 0) + 1;
    });
    return Object.keys(counts)
      .map((k) => ({ label: k, count: counts[k] }))
      .sort((a, b) => b.count - a.count);
  };

  // 강조할 테마 묶음은 데이터에서 선언한다. 코드에 테마 이름을 박아두면
  // 원본이 갱신되며 이름이 바뀌었을 때 "0곳(0%)"이라는 문장이 조용히 화면에 남는다.
  const insight = (state.raw && state.raw.insight) || null;
  if (insight && Array.isArray(insight.themes)) {
    const matched = state.spots.filter((s) => insight.themes.includes(s.theme)).length;
    if (matched > 0) {
      const share = Math.round((matched / total) * 100);
      const lead = el("p", "insight-headline");
      lead.appendChild(el("strong", null, `${total}곳 중 ${matched}곳(${share}%)`));
      lead.appendChild(
        document.createTextNode(`이 ${insight.label}과 관련된 장소입니다. ${insight.note || ""}`)
      );
      box.appendChild(lead);
    }
  }

  const grid = el("div", "insight-grid");
  [
    { title: "테마별 분포", rows: countBy("theme") },
    { title: "자치구별 분포", rows: countBy("district") },
  ].forEach((group) => {
    const col = el("div", "insight-col");
    col.appendChild(el("h4", "insight-title", group.title));

    const max = Math.max(...group.rows.map((r) => r.count), 1);
    group.rows.forEach((row) => {
      const line = el("div", "bar-row");
      line.appendChild(el("span", "bar-label", row.label));

      const track = el("span", "bar-track");
      const fill = el("span", "bar-fill");
      fill.style.width = `${(row.count / max) * 100}%`;
      track.appendChild(fill);
      line.appendChild(track);

      line.appendChild(el("span", "bar-value", String(row.count)));
      col.appendChild(line);
    });

    grid.appendChild(col);
  });

  box.appendChild(grid);
}

/* ---------- 히어로 통계 ---------- */

// 첫 화면의 숫자는 문구에 박아두지 않고 실제 로드된 데이터에서 센다.
// 원본이 갱신돼 거점 수가 바뀌었을 때 "18곳"이라는 문장만 조용히 거짓이 되는 걸 막는다.
function renderHeroStats() {
  const put = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };
  put("stat-spots", String(state.spots.length));
  put("stat-themes", String(state.themes.length));
  put("stat-langs", String(LANGUAGES.length));
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
      return typeof (payload && payload.error) === "string"
        ? payload.error
        : "서버에서 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.";
    case 502:
    case 503:
      // 우리 함수까지 못 가고 플랫폼 단에서 막힌 응답은 error가 문자열이 아니거나 없다.
      // 그런 경우까지 화면에 [object Object] 같은 값이 나가지 않도록 문자열일 때만 쓴다.
      return typeof (payload && payload.error) === "string"
        ? payload.error
        : "AI 서비스에 일시적으로 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.";
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
  clearHandoff();
  answerBox.textContent = "답변을 준비하고 있습니다…";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const askedFor = state.selected;
  state.pendingAsk = controller;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        placeId: askedFor.id,
        persona: state.persona,
        language: state.language,
        question,
      }),
      signal: controller.signal,
    });

    // 응답이 오는 사이 다른 거점으로 옮겼다면 이 답변은 버린다.
    if (state.selected !== askedFor) return;

    // 로컬 정적 서버나 배포 설정 오류일 때는 JSON이 아니라 HTML이 돌아온다.
    let payload = null;
    try {
      payload = await res.json();
    } catch (parseErr) {
      if (state.selected !== askedFor) return;
      answerBox.textContent =
        res.status === 404
          ? "AI 기능은 배포된 주소에서만 동작합니다. (정적 파일만 여는 환경에서는 /api/chat 이 없습니다)"
          : "서버 응답을 해석할 수 없습니다. 잠시 후 다시 시도해 주세요.";
      return;
    }

    // 본문을 읽는 사이에도 거점이 바뀔 수 있다. 화면에 쓰기 직전에 한 번 더 확인한다.
    if (state.selected !== askedFor) return;

    if (!res.ok) {
      answerBox.textContent = errorMessageFor(res.status, payload);
      return;
    }

    const parts = [payload.answer];
    if (payload.source && payload.source.name) {
      const date = payload.source.date ? ` (기준일 ${payload.source.date})` : "";
      parts.push(`\n\n출처: ${payload.source.name}${date}`);
    }
    if (payload.truncated) {
      parts.push("\n\n(답변이 길어 일부가 잘렸습니다. 더 짧게 나눠 물어보시면 전체를 받을 수 있습니다.)");
    }
    answerBox.textContent = parts.join("");

    // 자료로 답하지 못한 경우에는 사람에게 넘긴다. AI가 멈추는 지점이 서비스가 멈추는 지점이 아니다.
    // 질문을 보낸 거점을 명시적으로 넘긴다. state.selected 를 읽으면 늦게 도착한 답변에
    // 엉뚱한 거점의 전화번호가 붙을 수 있다.
    if (payload.grounded === false || payload.blocked) {
      showHandoff(askedFor);
    }
  } catch (err) {
    if (err.name === "AbortError") {
      // 거점을 바꿔서 취소한 경우에는 아무 말도 남기지 않는다. 타임아웃일 때만 안내한다.
      if (state.selected === askedFor) {
        answerBox.textContent = "응답이 지연되어 요청을 중단했습니다. 잠시 후 다시 시도해 주세요.";
      }
    } else {
      console.error("[ai] 요청 실패", err);
      answerBox.textContent = "네트워크에 연결할 수 없습니다. 연결 상태를 확인해 주세요.";
    }
  } finally {
    clearTimeout(timer);
    if (state.pendingAsk === controller) state.pendingAsk = null;
    setAsking(false);
  }
}

function clearHandoff() {
  const existing = document.querySelector(".handoff");
  if (existing) existing.remove();
}

// AI가 답을 못 낼 때 현장 해설사로 연결하는 안내를 답변 아래에 붙인다.
// 대상 거점은 호출자가 넘긴다 — 답변이 늦게 도착하는 동안 선택이 바뀔 수 있기 때문이다.
function showHandoff(spot) {
  const answerBox = document.getElementById("ai-answer");
  if (!spot) return;

  clearHandoff();

  const box = el("div", "handoff");
  box.appendChild(el("p", "handoff-title", "현장 문화관광해설사에게 물어보세요"));
  box.appendChild(
    el("p", "handoff-body", `${spot.name}은(는) ${spot.organization}이 관리합니다. 자료에 없는 내용은 현장에서 더 정확히 안내받을 수 있습니다.`)
  );

  const tel = telHref(spot.phone);
  if (tel) {
    const call = el("a", "btn btn-primary", `${spot.phone} 전화하기`);
    call.href = tel;
    box.appendChild(call);
  }

  answerBox.insertAdjacentElement("afterend", box);
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

// 전시 데이터는 선택 사항이다. 파일이 없거나 아직 비어 있어도 나머지는 정상 동작해야 한다.
async function loadExhibitions() {
  try {
    const res = await fetch("data/exhibitions.json", { cache: "no-cache" });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json.exhibitions) ? json.exhibitions : [];
  } catch (err) {
    console.warn("[data] 전시 데이터 없음 — 해당 영역을 건너뜁니다");
    return [];
  }
}

async function main() {
  setupAiForm();
  setupDiscover();

  let data;
  try {
    data = await loadData();
  } catch (err) {
    console.error("[data] 로드 실패", err);
    showFatalError("거점 데이터를 불러오지 못했습니다. 페이지를 새로고침해 주세요.");
    showMapFallback("거점 데이터를 불러오지 못해 지도를 표시할 수 없습니다.");
    return;
  }

  state.raw = data;
  state.spots = data.spots;
  state.datasets = Array.isArray(data.datasets) ? data.datasets : [];
  state.exhibitions = await loadExhibitions();
  state.themes = Array.isArray(data.themes)
    ? data.themes
    : [...new Set(state.spots.map((s) => s.theme).filter(Boolean))];

  renderHeroStats();
  renderThemeFilters();
  renderSpotList();
  renderPersonaChips();
  renderLanguageChips();
  renderFaq();
  renderExhibitions();
  renderDatasets();
  renderSources();
  renderInsights();
  renderQuality();

  document.getElementById("nearby-btn").addEventListener("click", requestLocation);

  document.getElementById("spot-search").addEventListener("input", (e) => {
    state.search = e.target.value.trim();
    renderSpotList();
    renderMarkers(visibleSpots());
  });

  // 공유 링크(?place=7)로 들어온 경우 해당 거점을 바로 연다.
  const requested = new URLSearchParams(window.location.search).get("place");
  if (requested) {
    const spot = state.spots.find((s) => String(s.id) === requested);
    if (spot) selectSpot(spot);
  }

  // 지도는 마지막에. 실패해도 위의 기능들은 이미 살아 있다.
  setupMap();
}

main();
