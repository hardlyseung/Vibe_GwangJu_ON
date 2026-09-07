// Vercel 서버리스 함수 (Node.js). 프레임워크 없이 이 파일 하나로 /api/chat 이 된다.
//
// 환경변수 GEMINI_API_KEY 는 ai.google.com/aistudio 의 상시 무료 티어 키를 쓴다.
// GCP 체험판 크레딧에 연결된 키는 크레딧 만료 시 서비스가 끊겨 공모전 운영 조건(2027-03-31까지 공개)을 위반한다.

const fs = require("fs");
const path = require("path");

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

let placesCache = null;

function loadPlaces() {
  if (placesCache) return placesCache;
  const filePath = path.join(process.cwd(), "data", "places.json");
  placesCache = JSON.parse(fs.readFileSync(filePath, "utf-8")).spots;
  return placesCache;
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

function buildSystemPrompt(place, persona, grounding) {
  const personaLine = PERSONA_INSTRUCTIONS[persona] || PERSONA_INSTRUCTIONS.general;
  const refusal = `해당 내용은 공식 관광 자료에서 확인되지 않았습니다. 현장 문의(${place.phone})로 확인해 주세요.`;

  return `당신은 "광주 ON AIR"의 AI 문화관광해설사입니다.
관광객은 지금 [${place.name}]에 대해 묻고 있습니다.

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

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST 요청만 지원합니다." });
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
  const persona = typeof body.persona === "string" ? body.persona : "general";

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
  const refusal = `해당 내용은 공식 관광 자료에서 확인되지 않았습니다. 현장 문의(${place.phone})로 확인해 주세요.`;
  const grounding = buildGroundingBlock(place);

  // 근거 자료가 이름·주소 수준뿐이면 모델을 부를 필요도 없다. 할당량도 아끼고 환각 여지도 없앤다.
  if (!isFilled(place.summary) && !isFilled(place.history_details) && !isFilled(place.visit_tips)) {
    sendJson(res, 200, { answer: refusal, grounded: false, source });
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
          systemInstruction: { parts: [{ text: buildSystemPrompt(place, persona, grounding) }] },
          generationConfig: { temperature: 0.2, maxOutputTokens: 700 },
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
        sendJson(res, 502, { error: "AI 응답을 생성하지 못했습니다." });
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
        answer: `이 질문에는 자동 해설을 제공하기 어렵습니다. ${refusal}`,
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

    if (!answer) {
      console.warn(`[chat] 빈 응답 place=${place.name} finishReason=${finishReason}`);
      sendJson(res, 200, { answer: refusal, grounded: false, source });
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
