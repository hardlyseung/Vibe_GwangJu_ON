// Vercel 서버리스 함수 (Node.js runtime). 프레임워크 없이 /api/chat.js 하나로 동작합니다.
// 배포 시 Vercel 프로젝트 환경변수에 GEMINI_API_KEY를 등록하세요 (절대 코드/레포에 직접 넣지 말 것).
// GEMINI_API_KEY는 ai.google.com/aistudio 의 진짜 무료 티어 키를 사용하세요.
// (GCP 체험판 크레딧에 연결된 키는 크레딧 소진/만료 시 서비스가 끊기므로 사용 금지 — 2027.3.31까지 운영 조건 위반 위험)

const fs = require("fs");
const path = require("path");

const PERSONA_INSTRUCTIONS = {
  general: "친절하고 깔끔하게 3줄 이내로 핵심 관전 포인트를 설명하세요.",
  family: "초등학생에게 이야기책을 읽어주듯 쉽고 흥미진진하게 존댓말로 설명하세요.",
  history: "역사적 연도, 인물, 사료적 가치를 바탕으로 도슨트처럼 깊이 있게 설명하세요.",
};

function loadPlaces() {
  const filePath = path.join(process.cwd(), "data", "places.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw).spots;
}

function buildSystemPrompt(place, persona) {
  const personaLine = PERSONA_INSTRUCTIONS[persona] || PERSONA_INSTRUCTIONS.general;
  return `당신은 "광주 ON AIR"의 공인 AI 문화관광해설사입니다.
현재 관광객은 [${place.name}]에 머무르며 해설을 듣고 있습니다.

[해설 톤]
${personaLine}

[엄격한 제약조건 (환각 방지)]
1. 반드시 아래 [공식 관광 자료]에 적힌 내용만을 근거로 답변하세요.
2. [공식 관광 자료]에 없는 정보나 추측성 정보는 절대로 지어내지 마세요.
3. 자료에 없는 질문을 받으면 다음과 같이만 답하세요:
   "해당 내용은 공식 관광 자료에 명시되어 있지 않습니다. 현장 문의(${place.phone})로 확인해 주세요."
4. 광주 관광과 무관한 질문에는 답변하지 말고 3번과 동일하게 안내하세요.

[공식 관광 자료]
- 장소명: ${place.name} (${place.district})
- 주소: ${place.address}
- 관리기관: ${place.organization} (문의: ${place.phone})
- 요약: ${place.summary}
- 상세: ${place.history_details}
- 관람 팁: ${place.visit_tips}
- 이용정보: 운영시간 ${place.operating_hours} / 입장료 ${place.admission} / 주차 ${place.parking}
- 출처: ${place.source_name} (기준일: ${place.source_date})`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST 요청만 지원합니다." });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "서버에 GEMINI_API_KEY가 설정되지 않았습니다." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    body = JSON.parse(body || "{}");
  }
  const { placeId, persona, question } = body || {};

  if (!placeId || !question) {
    res.status(400).json({ error: "placeId와 question은 필수입니다." });
    return;
  }

  const places = loadPlaces();
  const place = places.find((p) => p.id === placeId);
  if (!place) {
    res.status(404).json({ error: "존재하지 않는 장소입니다." });
    return;
  }

  const systemPrompt = buildSystemPrompt(place, persona);

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: question }] }],
          systemInstruction: { parts: [{ text: systemPrompt }] },
        }),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      res.status(502).json({ error: "AI 응답 생성 실패", detail: errText });
      return;
    }

    const data = await geminiRes.json();
    const answer =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "답변을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.";

    res.status(200).json({
      answer,
      source: { name: place.source_name, date: place.source_date },
    });
  } catch (err) {
    res.status(500).json({ error: "서버 오류가 발생했습니다.", detail: String(err) });
  }
};
