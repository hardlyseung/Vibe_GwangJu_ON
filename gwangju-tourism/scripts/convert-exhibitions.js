// 광주광역시관광공사_주관전시회 개최 현황 CSV -> data/exhibitions.json 변환기 (Node 18+)
//
//   node scripts/convert-exhibitions.js <내려받은_CSV_경로>
//
// 공공데이터포털 CSV는 EUC-KR(CP949)로 내려오는 경우가 많고, 컬럼명도 배포 시기마다 조금씩 다르다.
// 그래서 인코딩을 자동 판별하고, 컬럼은 별칭 목록으로 찾는다. 매칭 결과는 실행 후 화면에 보고한다.

const fs = require("fs");
const path = require("path");

const OUT_PATH = path.join(__dirname, "..", "data", "exhibitions.json");

// 컬럼 별칭. 왼쪽이 우리가 쓰는 이름, 오른쪽이 원본에서 나타날 수 있는 표기들.
const COLUMN_ALIASES = {
  name: ["전시회명", "전시명", "행사명", "명칭", "전시회이름"],
  start_date: ["전시시작일", "시작일", "시작일자", "개최시작일", "행사시작일"],
  end_date: ["전시종료일", "종료일", "종료일자", "개최종료일", "행사종료일"],
  venue: ["장소", "전시장소", "개최장소", "행사장소"],
  companies: ["참여업체", "참여업체수", "참가업체", "참가업체수"],
  booths: ["부스", "부스수", "부스규모", "참여부스"],
  items: ["전시품목", "품목", "전시분야"],
  host: ["주최", "주최기관"],
  organizer: ["주관", "주관기관"],
  phone: ["연락처", "전화번호", "문의처", "문의"],
  website: ["웹사이트", "홈페이지", "url", "website", "누리집"],
};

const DISTRICTS = ["동구", "서구", "남구", "북구", "광산구"];

// 자치구가 주소에 안 적힌 대표 시설 보정
const VENUE_DISTRICTS = {
  김대중컨벤션센터: "서구",
};

/* ---------- 인코딩 ---------- */

function readCsvText(filePath) {
  const buf = fs.readFileSync(filePath);

  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.slice(3).toString("utf-8"), encoding: "UTF-8 (BOM)" };
  }

  // 엄격 모드로 UTF-8 시도. 실패하면 EUC-KR로 본다.
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { text, encoding: "UTF-8" };
  } catch (err) {
    try {
      return { text: new TextDecoder("euc-kr").decode(buf), encoding: "EUC-KR (CP949)" };
    } catch (err2) {
      throw new Error("UTF-8도 EUC-KR도 아닌 인코딩입니다. 엑셀에서 'CSV UTF-8'로 저장한 뒤 다시 시도하세요.");
    }
  }
}

/* ---------- CSV 파싱 ---------- */

// 따옴표 안의 쉼표·줄바꿈을 지키는 최소 파서. split(",")로는 실제 데이터에서 깨진다.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/* ---------- 정규화 ---------- */

function normalizeHeader(name) {
  return String(name).replace(/^﻿/, "").replace(/[\s()[\]]/g, "").toLowerCase();
}

function buildColumnMap(headerRow) {
  const normalized = headerRow.map(normalizeHeader);
  const map = {};
  const report = {};

  Object.keys(COLUMN_ALIASES).forEach((key) => {
    const idx = normalized.findIndex((h) =>
      COLUMN_ALIASES[key].some((alias) => h === normalizeHeader(alias) || h.includes(normalizeHeader(alias)))
    );
    if (idx !== -1) {
      map[key] = idx;
      report[key] = headerRow[idx].trim();
    }
  });

  return { map, report };
}

function toIsoDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  // 연·월·일이 모두 있어야 인정한다. 구분자를 필수로 두지 않으면 "2024-11" 같은 값이
  // 역추적으로 월=1, 일=1 로 매칭돼 2024-01-01 이라는 없는 날짜가 조용히 만들어진다.
  let m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) m = raw.match(/^(\d{4})\s*[-.\/년]\s*(\d{1,2})\s*[-.\/월]\s*(\d{1,2})/);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function toNumber(value) {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  return digits ? Number(digits) : null;
}

function findDistrict(venue) {
  const text = String(venue || "");
  const hit = DISTRICTS.find((d) => text.includes(d));
  if (hit) return hit;

  const known = Object.keys(VENUE_DISTRICTS).find((k) => text.replace(/\s/g, "").includes(k));
  return known ? VENUE_DISTRICTS[known] : null;
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "-") return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^www\./i.test(raw)) return `https://${raw}`;
  return "";
}

/* ---------- 실행 ---------- */

function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("사용법: node scripts/convert-exhibitions.js <내려받은_CSV_경로>");
    process.exit(1);
  }
  if (!fs.existsSync(input)) {
    console.error(`파일을 찾을 수 없습니다: ${input}`);
    process.exit(1);
  }

  let text;
  let encoding;
  try {
    ({ text, encoding } = readCsvText(input));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const rows = parseCsv(text);
  if (rows.length < 2) {
    console.error("데이터 행이 없습니다. 파일을 확인하세요.");
    process.exit(1);
  }

  const { map, report } = buildColumnMap(rows[0]);

  if (map.name === undefined) {
    console.error("\n전시회명 컬럼을 찾지 못했습니다. 원본 헤더:");
    console.error("  " + rows[0].join(" | "));
    console.error("\nscripts/convert-exhibitions.js 의 COLUMN_ALIASES.name 에 실제 헤더명을 추가하세요.");
    process.exit(1);
  }

  const pick = (row, key) => (map[key] === undefined ? "" : String(row[map[key]] || "").trim());

  const exhibitions = rows.slice(1).map((row, i) => {
    const venue = pick(row, "venue");
    return {
      id: i + 1,
      name: pick(row, "name"),
      start_date: toIsoDate(pick(row, "start_date")),
      end_date: toIsoDate(pick(row, "end_date")),
      venue,
      district: findDistrict(venue),
      companies: toNumber(pick(row, "companies")),
      booths: toNumber(pick(row, "booths")),
      items: pick(row, "items"),
      host: pick(row, "host"),
      organizer: pick(row, "organizer"),
      phone: pick(row, "phone"),
      website: normalizeUrl(pick(row, "website")),
    };
  }).filter((ex) => ex.name);

  const output = {
    _readme:
      "광주광역시관광공사_주관전시회 개최 현황 CSV를 scripts/convert-exhibitions.js 로 변환한 결과입니다. 원본이 갱신되면 스크립트를 다시 실행하세요.",
    source_name: "광주광역시관광공사_주관전시회 개최 현황",
    provider: "광주광역시관광공사",
    converted_at: new Date().toISOString().slice(0, 10),
    exhibitions,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");

  const missingDates = exhibitions.filter((e) => !e.start_date || !e.end_date).length;
  const noDistrict = exhibitions.filter((e) => !e.district).length;

  console.log("──────── 변환 결과 ────────");
  console.log(`인코딩       ${encoding}`);
  console.log(`전시회       ${exhibitions.length}건`);
  console.log("인식한 컬럼");
  Object.keys(report).forEach((k) => console.log(`  ${k.padEnd(12)} <- ${report[k]}`));

  const missed = Object.keys(COLUMN_ALIASES).filter((k) => map[k] === undefined);
  if (missed.length) console.log(`못 찾은 컬럼  ${missed.join(", ")} (없어도 동작하지만 화면에 표시되지 않음)`);
  if (missingDates) console.log(`날짜 누락     ${missingDates}건 — 기간 필터에서 제외됩니다`);
  if (noDistrict) console.log(`자치구 미상   ${noDistrict}건 — 근처 해설 거점 연결이 표시되지 않습니다`);

  console.log(`\ndata/exhibitions.json 을 저장했습니다.`);
}

main();
