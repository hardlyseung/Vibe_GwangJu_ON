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
  raw: null,
  spots: [],
  exhibitions: [],
  themes: [],
  datasets: [],
  activeTheme: null,
  districtFilter: null,
  selected: null,
  persona: "general",
  map: null,
  markers: [],
  asking: false,
  userPos: null, // 위치 권한을 허용했을 때만 채워진다
  sortByDistance: false,
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
  let filtered = state.spots.slice();
  if (state.activeTheme) filtered = filtered.filter((s) => s.theme === state.activeTheme);
  if (state.districtFilter) filtered = filtered.filter((s) => s.district === state.districtFilter);

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
    chip.addEventListener("click", () => {
      state.activeTheme = theme;
      state.districtFilter = null; // 테마를 고르면 자치구 한정은 푼다
      renderThemeFilters();
      renderSpotList();
      renderMarkers(visibleSpots());
      setLocationStatus("");
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

/* ---------- 상세 패널 ---------- */

function shareUrlFor(spot) {
  const url = new URL(window.location.href);
  url.searchParams.set("place", spot.id);
  url.hash = "";
  return url.toString();
}

function selectSpot(spot) {
  state.selected = spot;
  renderSpotList();
  renderDetail(spot);
  document.getElementById("ai-answer").textContent = "";

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
  const original = button.textContent;

  const done = (label) => {
    button.textContent = label;
    setTimeout(() => {
      button.textContent = original;
    }, 1800);
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
    top.appendChild(el("span", "exhibition-period", formatPeriod(ex)));
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

  renderThemeFilters();
  renderSpotList();
  renderPersonaChips();
  renderFaq();
  renderExhibitions();
  renderDatasets();
  renderQuality();

  document.getElementById("nearby-btn").addEventListener("click", requestLocation);

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
