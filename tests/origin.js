// /api/chat 출처 검증 — node tests/origin.js
//
// 이 엔드포인트는 인증이 없어서, 주소만 알면 누구나 우리 무료 할당량을 태울 수 있다.
// 그래서 출처를 본다. 다만 "막는 것"보다 "통과해야 할 것을 막지 않는 것"이 더 어렵다 —
// 여기서 틀리면 배포된 AI 가 통째로 죽는다. 통과 케이스를 먼저, 더 촘촘히 둔 이유다.
//
// 출처 검증. 잘못 막으면 배포된 AI 가 통째로 죽으므로 통과해야 할 경우를 특히 촘촘히 본다.
process.env.GEMINI_API_KEY = "k";
delete process.env.ALLOWED_ORIGINS;
const results = [];
const check = (n,p,d) => { results.push({n,p,d}); console.log(`${p?"PASS":"FAIL"}  ${n}${d?"  — "+d:""}`); };

function fresh() { delete require.cache[require.resolve("../api/chat.js")];
                   return require("../api/chat.js"); }
globalThis.fetch = async () => ({ ok: true, status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: "포충사는 사당입니다." }] }, finishReason: "STOP" }] }),
  text: async () => "" });

async function call(headers, body, handler) {
  const r = { status: (s)=> (r.statusCode=s, r), json: (p)=> (r.payload=p, r) };
  await (handler || fresh())({ method: "POST",
    headers: { host: "vibe-gwang-ju-on.vercel.app", "x-forwarded-for": String(Math.random()), ...headers },
    body: body || { placeId: 1, question: "여기는?", language: "ko" } }, r);
  return r;
}

(async () => {
  const H = fresh();

  /* ── 반드시 통과해야 하는 경우 (여기서 틀리면 배포가 죽는다) ── */
  let r = await call({ origin: "https://vibe-gwang-ju-on.vercel.app" }, null, H);
  check("동일 출처 Origin → 통과", r.statusCode === 200, `${r.statusCode}`);

  r = await call({ origin: "https://vibe-gwang-ju-on.vercel.app", referer: "https://vibe-gwang-ju-on.vercel.app/?place=3" }, null, H);
  check("Origin+Referer 둘 다 있어도 통과", r.statusCode === 200, `${r.statusCode}`);

  // Origin 을 안 보내는 환경(구형 브라우저·프라이버시 확장) 대비
  r = await call({ referer: "https://vibe-gwang-ju-on.vercel.app/index.html" }, null, H);
  check("Origin 없고 Referer 만 있어도 통과", r.statusCode === 200, `${r.statusCode}`);

  // Vercel 프리뷰 배포 (호스트가 매번 바뀐다)
  r = await call({ host: "vibe-gwang-ju-on-git-abc123.vercel.app",
                   origin: "https://vibe-gwang-ju-on-git-abc123.vercel.app" }, null, H);
  check("프리뷰 배포(호스트 상이)도 자기 자신이면 통과", r.statusCode === 200, `${r.statusCode}`);

  // 로컬 개발
  r = await call({ host: "localhost:3000", origin: "http://localhost:3000" }, null, H);
  check("로컬 개발(localhost:3000) 통과", r.statusCode === 200, `${r.statusCode}`);

  // discover 모드도 통과해야 한다
  globalThis.fetch = async () => ({ ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ids":[1,2],"reason":"두 곳"}' }] }, finishReason: "STOP" }] }),
    text: async () => "" });
  r = await call({ origin: "https://vibe-gwang-ju-on.vercel.app" }, { mode: "discover", query: "아이와 함께" }, H);
  check("discover 모드도 동일 출처면 통과", r.statusCode === 200 && r.payload.ids.length === 2, `${r.statusCode}`);

  /* ── 막아야 하는 경우 ── */
  r = await call({ origin: "https://evil.example.com" }, null, H);
  check("남의 사이트 Origin → 403", r.statusCode === 403, `${r.statusCode} ${r.payload.error||""}`);

  r = await call({ referer: "https://evil.example.com/steal.html" }, null, H);
  check("남의 사이트 Referer → 403", r.statusCode === 403, `${r.statusCode}`);

  r = await call({}, null, H);
  check("Origin·Referer 둘 다 없음(curl) → 403", r.statusCode === 403, `${r.statusCode}`);

  r = await call({ origin: "not a url" }, null, H);
  check("깨진 Origin → 403", r.statusCode === 403, `${r.statusCode}`);

  r = await call({ origin: "https://vibe-gwang-ju-on.vercel.app.evil.com" }, null, H);
  check("접두사만 같은 사칭 도메인 → 403", r.statusCode === 403, `${r.statusCode}`);

  r = await call({ origin: "https://vibe-gwang-ju-on.vercel.app" , host: "other.vercel.app"}, null, H);
  check("호스트와 Origin 불일치 → 403", r.statusCode === 403, `${r.statusCode}`);

  /* ── ALLOWED_ORIGINS 를 지정한 경우 (커스텀 도메인) ── */
  process.env.ALLOWED_ORIGINS = "gwangju-onair.kr, https://www.gwangju-onair.kr";
  const H2 = fresh();
  globalThis.fetch = async () => ({ ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: "답변" }] }, finishReason: "STOP" }] }),
    text: async () => "" });

  r = await call({ host: "gwangju-onair.kr", origin: "https://gwangju-onair.kr" }, null, H2);
  check("허용목록: 스킴 없이 적어도 통과", r.statusCode === 200, `${r.statusCode}`);

  r = await call({ host: "gwangju-onair.kr", origin: "https://www.gwangju-onair.kr" }, null, H2);
  check("허용목록: www 도 통과", r.statusCode === 200, `${r.statusCode}`);

  // 허용목록을 지정하면 그것만 — 배포 호스트라도 목록에 없으면 막는다
  r = await call({ host: "vibe-gwang-ju-on.vercel.app", origin: "https://vibe-gwang-ju-on.vercel.app" }, null, H2);
  check("허용목록 지정 시 목록 밖은 차단", r.statusCode === 403, `${r.statusCode}`);
  delete process.env.ALLOWED_ORIGINS;

  const bad = results.filter((x) => !x.p);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  if (bad.length) process.exit(1);
})();
