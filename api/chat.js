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

const MODEL = "gemini-2.5-flash";
const MAX_QUESTION_LENGTH = 200;
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
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: question }] }],
          systemInstruction: {
            parts: [{ text: buildSystemPrompt(place, persona, grounding, language) }],
          },
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1200,
          },
        }),
        signal: controller.signal,
      }
    );

    if (!upstream.ok) {
      // 업스트림 원문에는 키·할당량 정보가 섞일 수 있으므로 로그에만 남기고 클라이언트에는 요약만 준다.
      const detail = await upstream.text().catch(() => "");
      console.error(`[chat] Gemini ${upstream.status}: ${detail.slice(0, 500)}`);

      if (upstream.status === 429) {
        sendJson(res, 429, { error: "AI 이용량 한도에 도달했습니다. 잠시 후 다시 시도해 주세요." });
      } else if (upstream.status === 400 || upstream.status === 401 || upstream.status === 403) {
        sendJson(res, 500, { error: "AI 키 설정에 문제가 있습니다. 키 값과 재배포 여부를 확인해 주세요." });
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

    sendJson(res, 200, {
      answer,
      grounded: true,
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
