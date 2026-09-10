// Vercel 서버리스 함수 (Node.js). 프레임워크 없이 이 파일 하나로 /api/chat 이 된다.
//
// 환경변수 GEMINI_API_KEY 는 ai.google.com/aistudio 의 상시 무료 티어 키를 쓴다.
// GCP 체험판 크레딧에 연결된 키는 크레딧 만료 시 서비스가 끊겨 공모전 운영 조건(2027-03-31까지 공개)을 위반한다.

// 정적 require 를 쓴다. fs.readFileSync(process.cwd() + ...) 는 번들러가 추적하지 못해
// 배포된 함수에 데이터 파일이 빠지고, 모든 질문이 500으로 떨어진다.
// require 는 빌드 시 추적되고 결과가 캐시되므로 별도 캐시 변수도 필요 없다.
//
// 다만 require 는 모듈 로드 시점에 실행되므로, JSON 이 깨져 있으면 핸들러의 try/catch 밖에서
// 함수 자체가 부팅에 실패한다. 데이터는 GitHub 웹 편집기로 손편집하는 것이 정식 절차라
// 문법 오류가 현실적인 경로다. 여기서 잡아 두고 요청 시점에 안내 응답으로 바꾼다.
let placesData = null;
let placesLoadError = null;
try {
  placesData = require("../data/places.json");
} catch (err) {
  placesLoadError = err;
  console.error("[chat] places.json 을 읽을 수 없습니다", err);
}

// 모델명은 키가 속한 계정·프로젝트에 따라 제공 여부가 다르다. 없는 이름으로 부르면
// 인증 오류가 아니라 404(경로 없음)가 돌아오므로, 후보를 순서대로 시도한다.
// 성공한 이름은 워밍된 함수 인스턴스에 기억해 두어 다음 요청부터는 한 번에 맞춘다.
//
// "-latest" 별명은 쓰지 않는다 — Google이 신모델을 낼 때마다 조용히 그쪽을 가리키도록
// 바뀌는데, 갓 나온 모델은 무료 할당량이 분당 5회·하루 20회 수준으로 극히 작게 잡혀
// 있는 경우가 있다(2026-09-08 실측).
//
// 이 프로젝트의 실제 키는 세대가 넘어가 gemini-2.x·-latest 계열이 전부 404 였고,
// AI Studio Playground 의 "Get code" 로 확인한 정확한 슬러그가 gemini-3.5-flash-lite다.
// Lite 계열은 방금 나온 gemini-3.8-flash(RPM 5/RPD 20)보다 무료 할당량이 넉넉해 주 후보로
// 쓰고, 3.8-flash 는 그게 막혔을 때 쓸 여분으로만 둔다.
//
// ⚠️ 이 키가 어떤 세대를 열어주는지는 계정마다 다르다. 다음에 또 전부 404 가 뜨면
// aistudio.google.com → Playground → 원하는 모델 선택 → "Get code" 로 정확한 model
// 문자열을 다시 확인할 것 — 표시 이름("Gemini 3.5 Flash Lite")과 API 슬러그가 다르다.
const MODEL_CANDIDATES = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];
let resolvedModel = null;
const MAX_QUESTION_LENGTH = 200;

// 자연어 탐색("아이랑 반나절 코스")은 질문이 아니라 조건이므로 더 짧다.
const MAX_QUERY_LENGTH = 100;
// 한 번에 너무 많이 고르면 "추천"이 아니라 그냥 목록이 된다.
const DISCOVER_MAX_RESULTS = 5;
// Vercel Hobby 함수는 오래 걸리면 플랫폼이 먼저 끊는다.
// 그 전에 우리가 끊어야 사용자에게 깔끔한 메시지를 돌려줄 수 있다.
const UPSTREAM_TIMEOUT_MS = 9000;

const PERSONA_INSTRUCTIONS = {
  general: "친절하고 깔끔하게 세 문장 이내로 핵심 관람 포인트를 설명하세요.",
  family: "초등학생에게 이야기하듯 쉬운 단어로, 존댓말로 흥미롭게 설명하세요.",
  history: "시대적 배경과 인물, 문화유산으로서의 가치를 중심으로 깊이 있게 설명하세요.",
};

// 근거 자료는 한국어 그대로 두고 출력 언어만 지정한다.
// 번역본을 따로 만들지 않으므로 언어를 늘려도 근거의 일관성이 깨지지 않는다.
const LANGUAGE_INSTRUCTIONS = {
  ko: "한국어로 답변하세요.",
  en: "Answer in English. The source material below is in Korean; translate faithfully and do not add facts that are not in it. Keep Korean proper nouns in romanized form with the Korean name in parentheses on first mention.",
  ja: "日本語で回答してください。以下の資料は韓国語ですが、忠実に翻訳し、資料にない事実を追加しないでください。",
  zh: "请用中文回答。以下资料为韩语，请忠实翻译，不要添加资料中没有的事实。",
};

// 답하지 못하는 이유는 세 가지이고, 서로 다른 사실을 뜻한다.
//   not_found : 자료에 그 내용이 없다
//   blocked   : 자료에 있을 수도 있으나 안전 필터가 생성을 막았다
//   too_long  : 자료도 있고 차단도 아니지만 토큰 한도로 본문이 비었다
// 셋을 같은 문구로 뭉치면 사용자에게 틀린 이유를 말하게 되고,
// too_long 은 생성 설정이 잘못됐다는 신호인데 그것도 묻혀 버린다.
// 언어별로 미리 써 두지 않으면 모델이 이 문장마저 지어낸다.
const FALLBACK_MESSAGES = {
  not_found: {
    ko: (p) => `해당 내용은 공식 관광 자료에서 확인되지 않았습니다. 현장 문의(${p})로 확인해 주세요.`,
    en: (p) => `This information is not confirmed in the official tourism materials. Please contact the site directly at ${p}.`,
    ja: (p) => `この内容は公式観光資料では確認できませんでした。現地(${p})までお問い合わせください。`,
    zh: (p) => `该内容未能在官方旅游资料中得到确认。请拨打现场电话(${p})咨询。`,
  },
  blocked: {
    ko: (p) => `이 질문에는 자동 해설을 제공하기 어렵습니다. 현장 문화관광해설사(${p})에게 문의해 주세요.`,
    en: (p) => `An automated explanation cannot be provided for this question. Please ask the on-site interpreter at ${p}.`,
    ja: (p) => `この質問には自動解説を提供できません。現地の文化観光解説士(${p})にお問い合わせください。`,
    zh: (p) => `无法为该问题提供自动讲解。请咨询现场文化观光讲解员(${p})。`,
  },
  too_long: {
    ko: () => "답변이 길어져 생성하지 못했습니다. 질문을 더 짧게 나눠서 물어봐 주세요.",
    en: () => "The answer grew too long to generate. Please ask a shorter, more specific question.",
    ja: () => "回答が長くなりすぎて生成できませんでした。もう少し短く質問してください。",
    zh: () => "回答过长，无法生成。请把问题拆得更简短一些。",
  },
};

function fallbackText(kind, place, language) {
  const table = FALLBACK_MESSAGES[kind] || FALLBACK_MESSAGES.not_found;
  const build = table[language] || table.ko;
  return build((place && place.phone) || "관리기관");
}

function loadPlaces() {
  if (!placesData || !Array.isArray(placesData.spots)) {
    throw placesLoadError || new Error("places.json 의 형식이 올바르지 않습니다");
  }
  return placesData.spots;
}

// 프로토타입 키("toString", "constructor" 등)가 통과하면 네이티브 함수 소스가
// 시스템 프롬프트에 그대로 들어간다. 자체 속성만 인정한다.
function pickKey(table, value, fallback) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(table, value)
    ? value
    : fallback;
}

// places.json의 미작성 필드는 "TODO..." 문자열이다.
// 이걸 근거 자료로 넘기면 모델이 TODO 문구를 사실로 취급하므로 반드시 걸러낸다.
function isFilled(value) {
  return typeof value === "string" && value.trim() !== "" && !value.trim().startsWith("TODO");
}

function buildGroundingBlock(place) {
  const lines = [];
  const add = (label, value) => {
    if (isFilled(value)) lines.push(`- ${label}: ${value.trim()}`);
  };

  add("장소명", `${place.name} (${place.district})`);
  add("주소", place.address);
  add("관리기관", place.organization);
  add("문의 전화", place.phone);
  add("요약", place.summary);
  add("상세 연혁", place.history_details);
  add("관람 팁", place.visit_tips);
  add("운영시간", place.operating_hours);
  add("입장료", place.admission);
  add("주차", place.parking);

  return lines.join("\n");
}

// 모델이 자료 부족으로 거절하면 우리가 프롬프트에 넣어 준 그 문장을 그대로 돌려준다.
// 성공 응답이지만 "자료로 답한 것"은 아니므로 근거 있음으로 보내면 안 된다.
// 이 서비스가 사람 해설사로 넘기는 지점이 정확히 여기라, 이 구분이 곧 화면 동작이 된다.
function isRefusal(answer, refusal) {
  const norm = (t) => t.replace(/\s+/g, " ").trim();
  const a = norm(answer);
  const r = norm(refusal);
  if (a === r) return true;
  // 모델이 전화번호를 빠뜨리거나 뒤에 한 문장을 덧붙이는 경우까지 받아 준다.
  // 첫 문장만으로 판정한다 — 뒤따르는 연락처 안내는 흔들려도 첫 문장은 그대로 돌아온다.
  const head = norm(r.split(/[.。]/)[0]);
  return head.length >= 10 && a.startsWith(head);
}

function buildSystemPrompt(place, persona, grounding, language) {
  const personaLine = PERSONA_INSTRUCTIONS[pickKey(PERSONA_INSTRUCTIONS, persona, "general")];
  const languageLine = LANGUAGE_INSTRUCTIONS[pickKey(LANGUAGE_INSTRUCTIONS, language, "ko")];
  const refusal = fallbackText("not_found", place, language);

  return `당신은 "광주 ON AIR"의 AI 문화관광해설사입니다.
관광객은 지금 [${place.name}]에 대해 묻고 있습니다.

[답변 언어]
${languageLine}

[해설 톤]
${personaLine}

[반드시 지킬 제약]
1. 아래 [공식 관광 자료]에 적힌 내용만을 근거로 답변합니다.
2. 자료에 없는 사실, 연도, 인물, 수치는 추측하거나 지어내지 않습니다.
3. 자료로 답할 수 없는 질문에는 다음 문장으로만 답합니다.
   "${refusal}"
4. 광주 관광과 무관한 질문에도 3번과 동일하게 답합니다.
5. 답변에 출처 표기를 직접 쓰지 마세요. 출처는 화면에서 따로 표시됩니다.

[공식 관광 자료]
${grounding}`;
}

/* ---------- 자연어 탐색 (AI가 필터를 대신 걸어준다) ---------- */

// 모델에게 넘길 거점 카탈로그. 요약을 통째로 넣으면 18곳만으로도 프롬프트가 커져
// 무료 할당량을 빨리 태운다. 고르는 데 필요한 만큼만 자른다.
function buildCatalog(spots) {
  return spots
    .map((s) => {
      const summary = isFilled(s.summary) ? s.summary.trim().slice(0, 60) : "";
      // 관람 팁 유무는 "아이랑 갈 만한 곳" 같은 요청을 고를 때 실제로 쓰이는 신호다.
      const tip = isFilled(s.visit_tips) ? " [관람팁있음]" : "";
      return `${s.id}|${s.name}|${s.district}|${s.theme}|${summary}${tip}`;
    })
    .join("\n");
}

function buildDiscoverPrompt(catalog) {
  return `당신은 "광주 ON AIR"의 거점 추천기입니다.
관광객이 원하는 조건을 말하면, 아래 [거점 목록]에서 맞는 곳을 골라줍니다.

[반드시 지킬 제약]
1. 반드시 아래 목록에 있는 id 만 고릅니다. 목록에 없는 장소를 지어내지 않습니다.
2. 최대 ${DISCOVER_MAX_RESULTS}곳까지 고릅니다.
3. 조건에 맞는 곳이 없으면 ids 를 빈 배열로 둡니다. 억지로 채우지 않습니다.
4. 광주 관광과 무관한 요청이면 ids 를 빈 배열로 둡니다.
5. reason 은 왜 이 곳들을 골랐는지 한 문장으로만 씁니다. 목록에 없는 사실을 덧붙이지 않습니다.
6. 아래 JSON 형식으로만 답합니다. 다른 말을 앞뒤에 붙이지 않습니다.

{"ids":[1,2],"reason":"한 문장"}

[거점 목록]
id|이름|자치구|테마|요약
${catalog}`;
}

// 모델이 ```json 울타리나 앞뒤 설명을 붙여 보내는 경우가 있다. 첫 중괄호 블록만 건져낸다.
function extractJson(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return null;
  }
}

// 모델이 돌려준 id 를 실제 데이터와 대조한다. 이 검증이 "없는 거점을 추천하는" 사고를
// 막는 마지막 관문이다 — 프롬프트 제약만 믿지 않는다.
function validateIds(rawIds, spots) {
  if (!Array.isArray(rawIds)) return [];
  const known = new Set(spots.map((s) => Number(s.id)));
  const seen = new Set();
  const out = [];
  for (const raw of rawIds) {
    const id = Number(raw);
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= DISCOVER_MAX_RESULTS) break;
  }
  return out;
}

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch (err) {
      return null;
    }
  }
  return {};
}

// 인증 없는 공개 엔드포인트가 2027-03-31까지 하나의 무료 할당량을 쓴다.
// 서버리스는 인스턴스마다 메모리가 분리되므로 이 제한은 완벽하지 않지만,
// 한 클라이언트가 한 인스턴스를 두들기는 최악의 경우는 막아준다.
const RATE_WINDOW_MS = 60000;
const RATE_MAX_PER_WINDOW = 20;
const rateHits = new Map();

function isRateLimited(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "");
  const ip = forwarded.split(",")[0].trim() || "unknown";
  const now = Date.now();
  const entry = rateHits.get(ip);

  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    if (rateHits.size > 500) rateHits.clear(); // 메모리 상한
    rateHits.set(ip, { start: now, count: 1 });
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_MAX_PER_WINDOW;
}

// signal 이 이미 물려 있는 타임아웃 예산 안에서만 기다린다. 예산을 넘기면 delay 가 아니라
// fetch 자신이 AbortError 를 던지도록, 여기서도 같은 signal 로 걸어 둔다.
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

// 모델 후보를 순서대로 호출한다. 404 는 "이 키에 그 모델 경로가 없다"는 뜻이라 다음 후보로 넘어가고,
// 503 은 "이 모델이 지금 과부하"라는 구글 쪽 일시적 신호라 같은 모델로 짧게 한 번만 재시도한다.
// 그 외 응답(성공이든 429/403이든)은 원인이 모델명이 아니므로 그대로 돌려준다.
// AbortController 는 후보 전체에 공유된다 — 404 는 즉시 돌아오므로 총 예산을 넘기지 않는다.
async function callGemini(apiKey, body, signal) {
  const ordered = resolvedModel
    ? [resolvedModel].concat(MODEL_CANDIDATES.filter((m) => m !== resolvedModel))
    : MODEL_CANDIDATES;

  let lastNotFound = null;
  let lastUnavailable = null;

  const request = (model) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body,
      signal,
    });

  for (const model of ordered) {
    let upstream = await request(model);

    if (upstream.status === 503) {
      console.warn(`[chat] 모델 ${model} 과부하(503) — 700ms 후 한 번 재시도`);
      // 타임아웃 예산을 넘기면 delay 가 AbortError 를 던지고, 그대로 위로 전파되어
      // 호출부의 catch 가 504(지연) 응답으로 처리한다.
      await delay(700, signal);
      upstream = await request(model);
    }

    if (upstream.status === 404) {
      // 본문은 여기서 읽지 않는다 — 호출부가 실패를 최종 판단한 뒤 그 Response의 본문을
      // 딱 한 번만 읽는다. 스트림은 한 번만 읽을 수 있어, 여기서 먼저 읽으면 호출부의
      // 읽기가 빈 문자열로 조용히 실패한다.
      console.warn(`[chat] 모델 ${model} 사용 불가(404)`);
      // 기억해 둔 이름이 더 이상 유효하지 않은 경우이므로 캐시를 비운다.
      if (resolvedModel === model) resolvedModel = null;
      lastNotFound = upstream;
      continue;
    }

    if (upstream.status === 503) {
      // 재시도까지 했는데도 과부하다. 다른 모델은 별도 용량 풀이라 안 바쁠 수 있으므로
      // 여기서 포기하지 않고 다음 후보로 넘어간다.
      console.warn(`[chat] 모델 ${model} 재시도도 과부하(503) — 다음 후보로 전환`);
      lastUnavailable = upstream;
      continue;
    }

    if (upstream.ok) {
      if (resolvedModel !== model) {
        console.log(`[chat] 사용 모델 확정: ${model}`);
        resolvedModel = model;
      }
    }
    return upstream;
  }

  // 후보를 전부 시도했다. 503(모델이 있고 응답했으나 바빴다)이 404(모델명 자체가 없다)보다
  // 더 구체적인 신호이므로 우선 돌려준다.
  return lastUnavailable || lastNotFound;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST 요청만 지원합니다." });
    return;
  }

  if (isRateLimited(req)) {
    sendJson(res, 429, { error: "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요." });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[chat] GEMINI_API_KEY 미설정");
    sendJson(res, 500, {
      error: "AI 키가 서버에 설정되지 않았습니다. 환경변수 등록 후 재배포가 필요합니다.",
    });
    return;
  }

  const body = parseBody(req);
  if (body === null) {
    sendJson(res, 400, { error: "요청 형식이 올바르지 않습니다." });
    return;
  }

  // 자연어 탐색은 거점을 고르기 "전"에 부르는 것이라 placeId 가 없다.
  // 기존 해설 경로와 완전히 갈라서 처리한다.
  if (body.mode === "discover") {
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      sendJson(res, 400, { error: "찾고 싶은 조건을 입력해 주세요." });
      return;
    }
    if (query.length > MAX_QUERY_LENGTH) {
      sendJson(res, 400, { error: `조건은 ${MAX_QUERY_LENGTH}자 이내로 입력해 주세요.` });
      return;
    }

    let spots;
    try {
      spots = loadPlaces();
    } catch (err) {
      console.error("[discover] places.json 로드 실패", err);
      sendJson(res, 500, { error: "거점 데이터를 읽을 수 없습니다." });
      return;
    }

    const dController = new AbortController();
    const dTimer = setTimeout(() => dController.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const upstream = await callGemini(
        apiKey,
        JSON.stringify({
          contents: [{ role: "user", parts: [{ text: query }] }],
          systemInstruction: {
            parts: [{ text: buildDiscoverPrompt(buildCatalog(spots)) }],
          },
          // 추천은 창작이 아니라 분류다. 온도를 낮춰 같은 조건에 같은 답이 나오게 한다.
          generationConfig: { temperature: 0.1, maxOutputTokens: 400 },
        }),
        dController.signal
      );

      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        console.error(`[discover] Gemini ${upstream.status}: ${detail.slice(0, 300)}`);
        // 클라이언트는 200이 아니면 규칙 기반 검색으로 넘어간다. 상태코드만 정확히 준다.
        sendJson(res, upstream.status === 429 ? 429 : 502, {
          error: "AI 추천을 사용할 수 없어 일반 검색으로 찾았습니다.",
        });
        return;
      }

      const data = await upstream.json();
      const candidate = data && data.candidates && data.candidates[0];
      const text =
        candidate &&
        candidate.content &&
        Array.isArray(candidate.content.parts) &&
        candidate.content.parts.map((p) => p.text || "").join("");

      const parsed = extractJson(text);
      const ids = validateIds(parsed && parsed.ids, spots);
      const reason =
        parsed && typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 200) : "";

      // 고른 게 없으면 그렇다고 말한다. 억지로 아무 거점이나 채우지 않는다.
      sendJson(res, 200, { mode: "discover", ids, reason: ids.length ? reason : "" });
    } catch (err) {
      if (err.name === "AbortError") {
        console.error("[discover] 업스트림 타임아웃");
        sendJson(res, 504, { error: "AI 추천이 지연되어 일반 검색으로 찾았습니다." });
        return;
      }
      console.error("[discover] 예외", err);
      sendJson(res, 500, { error: "서버에서 문제가 발생했습니다." });
    } finally {
      clearTimeout(dTimer);
    }
    return;
  }

  const placeId = Number(body.placeId);
  const question = typeof body.question === "string" ? body.question.trim() : "";
  const persona = pickKey(PERSONA_INSTRUCTIONS, body.persona, "general");
  const language = pickKey(LANGUAGE_INSTRUCTIONS, body.language, "ko");

  if (!Number.isFinite(placeId) || !question) {
    sendJson(res, 400, { error: "거점과 질문이 모두 필요합니다." });
    return;
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    sendJson(res, 400, { error: `질문은 ${MAX_QUESTION_LENGTH}자 이내로 입력해 주세요.` });
    return;
  }

  let place;
  try {
    place = loadPlaces().find((p) => Number(p.id) === placeId);
  } catch (err) {
    console.error("[chat] places.json 로드 실패", err);
    sendJson(res, 500, { error: "거점 데이터를 읽을 수 없습니다." });
    return;
  }

  if (!place) {
    sendJson(res, 404, { error: "존재하지 않는 거점입니다." });
    return;
  }

  const source = { name: place.source_name, date: place.source_date };
  const notFound = fallbackText("not_found", place, language);
  const grounding = buildGroundingBlock(place);

  // 근거 자료가 이름·주소 수준뿐이면 모델을 부를 필요도 없다. 할당량도 아끼고 환각 여지도 없앤다.
  if (!isFilled(place.summary) && !isFilled(place.history_details) && !isFilled(place.visit_tips)) {
    sendJson(res, 200, { answer: notFound, reason: "not_found", grounded: false, source });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const requestBody = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: question }] }],
      systemInstruction: {
        parts: [{ text: buildSystemPrompt(place, persona, grounding, language) }],
      },
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1200,
      },
    });

    const upstream = await callGemini(apiKey, requestBody, controller.signal);

    if (!upstream.ok) {
      // 업스트림 원문에는 키·할당량 정보가 섞일 수 있으므로 로그에만 남기고 클라이언트에는 요약만 준다.
      const detail = await upstream.text().catch(() => "");
      console.error(`[chat] Gemini ${upstream.status}: ${detail.slice(0, 500)}`);

      if (upstream.status === 429) {
        sendJson(res, 429, { error: "AI 이용량 한도에 도달했습니다. 잠시 후 다시 시도해 주세요." });
      } else if (upstream.status === 400 || upstream.status === 401 || upstream.status === 403) {
        sendJson(res, 500, { error: "AI 키 설정에 문제가 있습니다. 키 값과 재배포 여부를 확인해 주세요." });
      } else if (upstream.status === 404) {
        // 후보 모델을 모두 시도했는데 전부 없다. 키는 유효하지만 이 계정이 쓸 수 있는 모델명이
        // 후보 목록에 없다는 뜻이라, 키를 다시 확인하라고 안내하면 잘못된 곳을 뒤지게 된다.
        sendJson(res, 502, {
          error: "AI 모델을 사용할 수 없습니다. 아래 ‘빠른 안내’는 그대로 이용하실 수 있습니다. (업스트림 상태 404)",
        });
      } else if (upstream.status === 503) {
        // 이미 한 번 재시도(callGemini)한 뒤에도 온 503이다. 구글 쪽 모델 과부하로,
        // 키·모델명과 무관하다. "다시 시도" 라고만 말해야 사용자가 엉뚱한 설정을 뒤지지 않는다.
        sendJson(res, 503, {
          error: "AI 서버가 일시적으로 혼잡합니다. 잠시 후 다시 시도해 주세요.",
        });
      } else {
        // 원문은 안 보내되, 상태코드는 숫자뿐이라 노출해도 안전하고 원인 추적에 필수적이다.
        sendJson(res, 502, { error: `AI 응답을 생성하지 못했습니다. (업스트림 상태 ${upstream.status})` });
      }
      return;
    }

    const data = await upstream.json();

    // 안전 필터 차단. 5·18 같은 민감한 역사 주제에서 발생할 수 있으며,
    // 이때 candidates가 비어 오므로 "알 수 없는 오류"가 아니라 안내 문구로 받아준다.
    const blockReason = data && data.promptFeedback && data.promptFeedback.blockReason;
    const candidate = data && data.candidates && data.candidates[0];
    const finishReason = candidate && candidate.finishReason;
    const blockedFinish = ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"];

    if (blockReason || (finishReason && blockedFinish.includes(finishReason))) {
      console.warn(`[chat] 차단됨 place=${place.name} reason=${blockReason || finishReason}`);
      sendJson(res, 200, {
        answer: fallbackText("blocked", place, language),
        reason: "blocked",
        blocked: true,
        source,
      });
      return;
    }

    const answer =
      candidate &&
      candidate.content &&
      Array.isArray(candidate.content.parts) &&
      candidate.content.parts.map((p) => p.text || "").join("").trim();

    // 본문이 비었는데 사유가 MAX_TOKENS 이면 자료가 없어서가 아니라 생성 예산이 모자란 것이다.
    // 이걸 "자료에 없음"으로 뭉치면 생성 설정이 잘못됐다는 신호가 그대로 묻힌다.
    if (!answer && finishReason === "MAX_TOKENS") {
      console.error(`[chat] 토큰 한도로 본문 없음 place=${place.name} — 생성 설정을 확인할 것`);
      sendJson(res, 200, {
        answer: fallbackText("too_long", place, language),
        reason: "too_long",
        grounded: false,
        source,
      });
      return;
    }

    if (!answer) {
      console.warn(`[chat] 빈 응답 place=${place.name} finishReason=${finishReason}`);
      sendJson(res, 200, { answer: notFound, reason: "not_found", grounded: false, source });
      return;
    }

    const refused = isRefusal(answer, notFound);
    if (refused) console.log(`[chat] 자료 부족으로 거절 place=${place.name} — 해설사 연결로 넘김`);

    sendJson(res, 200, {
      answer,
      grounded: !refused,
      reason: refused ? "not_found" : undefined,
      truncated: finishReason === "MAX_TOKENS",
      source,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("[chat] 업스트림 타임아웃");
      sendJson(res, 504, { error: "AI 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요." });
      return;
    }
    console.error("[chat] 예외", err);
    sendJson(res, 500, { error: "서버에서 문제가 발생했습니다." });
  } finally {
    clearTimeout(timer);
  }
};
