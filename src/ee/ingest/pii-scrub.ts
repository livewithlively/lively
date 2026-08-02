// 비정형 PII 탐지·마스킹(P3, #746) — 슬랙 메시지·드라이브 문서·로그·능동 read 응답처럼 정규화되지 않은
//  텍스트에 섞인 한국 금융 개인정보를 탐지해 가린다. redact.ts(시크릿=토큰/키)와 직교 — 여기는 PII(사람 식별정보).
//  db/mask.ts(구조화 DB 컬럼, 결정론)와도 다르다: 비정형은 '탐지 기반'이라 결정론 보장이 안 됨 → 등급 판정에서
//  '완전 비식별'로 쓰지 않고 부분마스킹으로 취급한다(프로젝트 #746 등급선).
//
//  오탐(정상 텍스트를 PII로 오인) 비용이 크므로 **체크섬/포맷이 강한 것 위주**로 탐지한다:
//   - 주민등록번호(RRN): 13자리 + 월/일 + mod-11 체크섬
//   - 사업자등록번호: 10자리 + 가중치 체크섬
//   - 카드번호: 13~19자리 + Luhn
//   - 휴대전화: 01[016789]-XXXX-XXXX 포맷
//   - 이메일
//  계좌번호는 은행별 편차가 커 포맷만으로 신뢰 탐지가 어렵다(오탐↑) → 비정형에선 미탐지(한계 명시), 구조화 DB 는
//  기존 컬럼 마스킹(#186)이 담당. 랜덤 숫자열이 우연히 체크섬을 통과할 수 있으나(저확률) fail 방향이 '가림'이라 안전측.

// 타입 계약은 코어 소유(src/org/ingest/pii-scrub.ts) — EE 는 구현만 제공한다.
import type { PiiType, PiiHit, PiiScrubResult } from "../../org/ingest/pii-scrub.js";

// ── 체크섬 검증(오탐 억제) ──
function digits(s: string): number[] { return s.replace(/\D/g, "").split("").map(Number); }

function validRrn(raw: string): boolean {
  const d = digits(raw);
  if (d.length !== 13) return false;
  const mm = d[2] * 10 + d[3];
  const dd = d[4] * 10 + d[5];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  if (d[6] < 1 || d[6] > 8) return false; // 성별/세기 코드 1~8
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += d[i] * w[i];
  const check = (11 - (sum % 11)) % 10;
  return check === d[12];
}

function validBiznum(raw: string): boolean {
  const d = digits(raw);
  if (d.length !== 10) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += d[i] * w[i];
  sum += Math.floor((d[8] * 5) / 10);
  const check = (10 - (sum % 10)) % 10;
  return check === d[9];
}

function luhn(raw: string): boolean {
  const d = digits(raw);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ── 마스킹 형태(부분 — 최소 식별성 남기고 가림) ──
function maskRrn(m: string): string { const d = m.replace(/\D/g, ""); return `${d.slice(0, 6)}-${d[6]}******`; }
function maskBiznum(): string { return "***-**-*****"; }
function maskCard(m: string): string { const d = m.replace(/\D/g, ""); return `****-****-****-${d.slice(-4)}`; }
function maskPhone(m: string): string { const d = m.replace(/\D/g, ""); return `${d.slice(0, 3)}-****-${d.slice(-4)}`; }
function maskEmail(m: string): string {
  const at = m.indexOf("@");
  if (at <= 0) return "***";
  return `${m[0]}***${m.slice(at)}`;
}

// 경계 — 숫자열이 더 긴 수의 일부가 아니도록(앞뒤가 숫자면 매치 취소). 하이픈/공백 구분자 허용.
const RRN_RE = /(?<![\d-])\d{6}[-\s]?\d{7}(?![\d-])/g;
// 카드 경계에는 **영문자도** 넣는다(#1301) — `p1785377560030869`·`txn4532…` 처럼 글자에 바로 붙은 숫자열은
//  카드번호가 아니라 **식별자**다. 진짜 카드번호는 공백·구분자·문장부호 뒤에 온다.
const CARD_RE = /(?<![\d\-A-Za-z])(?:\d[ -]?){13,19}(?![\d\-A-Za-z])/g;
// URL 안의 긴 숫자열도 카드가 아니다 — 링크의 경로·쿼리에 실린 식별자다.
//  실측(#1301): 슬랙 permalink `…/archives/C0BLJKT7534/p1785377560030869` 의 16자리 메시지 ts 가 Luhn 을
//  통과해 카드로 가려졌고 **링크가 깨져 원문을 못 열었다.** 16자리 임의 숫자가 Luhn 을 통과할 확률은 1/10 —
//  #746 이 "저확률 오탐은 수용" 이라 적어 둔 그 확률이 실제로는 **링크 10개 중 1개**였다. 같은 응답에서
//  어떤 링크는 멀쩡하고 어떤 건 깨지니 사람이 원인을 짚기도 어려웠다.
//  ⚠ 이 예외는 **카드에만** 적용한다. 주민번호는 체크섬(mod-11 + 날짜범위)이 훨씬 강해 우연 통과가 드물고,
//   이메일은 URL(mailto·쿼리)에 정상적으로 실린다 — 그것까지 풀면 진짜 PII 가 링크에 숨어 나간다.
//   결제 URL 에 카드번호를 싣는 건 그 자체로 사고이고, 그 드문 경우를 잡으려고 정상 링크를 상시로
//   깨뜨리는 건 비용이 맞지 않는다(오탐 억제가 이 컴포넌트의 설계 원칙이다).
const URL_RE = /\bhttps?:\/\/[^\s<>"'`\]),]+/gi;
const BIZ_RE = /(?<![\d-])\d{3}-\d{2}-\d{5}(?![\d-])/g; // 사업자번호는 통상 하이픈 표기 — 그때만(오탐 억제)
const PHONE_RE = /(?<![\d-])01[016789][-\s]?\d{3,4}[-\s]?\d{4}(?![\d-])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// 텍스트 안의 URL 구간 — [시작, 끝). 카드 탐지에서 이 구간을 건너뛰는 데 쓴다.
function urlSpans(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(URL_RE)) {
    if (m.index === undefined) continue;
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}
function inSpans(pos: number, spans: Array<[number, number]>): boolean {
  return spans.some(([a, b]) => pos >= a && pos < b);
}

// 텍스트 하나를 스크럽. 순서 주의: RRN/카드(강체크섬) → 사업자 → 전화 → 이메일. 이미 마스킹된 영역은 재매치 안 되게 각 단계가 자기 패턴만.
export function scrubPii(input: unknown): PiiScrubResult {
  if (typeof input !== "string" || input.length === 0) {
    return { text: typeof input === "string" ? input : String(input ?? ""), hits: [], total: 0 };
  }
  const counts: Record<PiiType, number> = { rrn: 0, biznum: 0, card: 0, phone: 0, email: 0 };
  let text = input;

  text = text.replace(RRN_RE, (m) => { if (validRrn(m)) { counts.rrn++; return maskRrn(m); } return m; });
  // 카드: Luhn 통과 + 13자리 이상. RRN(13자리)과 겹칠 수 있으나 RRN 이 먼저 가려져 남은 것만.
  //  URL 범위는 **이 시점 텍스트 기준**으로 잡는다 — 앞의 RRN 치환으로 길이가 달라졌을 수 있어서,
  //  미리 계산해 두면 offset 이 어긋나 엉뚱한 구간을 건너뛴다.
  const urls = urlSpans(text);
  text = text.replace(CARD_RE, (m, offset: number) => {
    if (inSpans(offset, urls)) return m;   // 링크 속 식별자 — 카드로 보지 않는다(#1301)
    if (luhn(m)) { counts.card++; return maskCard(m); }
    return m;
  });
  text = text.replace(BIZ_RE, (m) => { if (validBiznum(m)) { counts.biznum++; return maskBiznum(); } return m; });
  text = text.replace(PHONE_RE, (m) => { counts.phone++; return maskPhone(m); });
  text = text.replace(EMAIL_RE, (m) => { counts.email++; return maskEmail(m); });

  const hits: PiiHit[] = (Object.keys(counts) as PiiType[])
    .filter((t) => counts[t] > 0)
    .map((t) => ({ type: t, count: counts[t] }));
  const total = hits.reduce((a, h) => a + h.count, 0);
  return { text, hits, total };
}

// 탐지만(마스킹 안 함) — 게이팅/관측 결정용(예: '이 문서에 PII 있으니 human-confirm 큐로'). total>0 이면 PII 존재.
export function detectPii(input: unknown): PiiHit[] {
  return scrubPii(input).hits;
}

// 구조화 값 깊은 순회 — 문자열만 스크럽(redactDeep 미러). 능동 read 응답(JSON)·소스 페이로드에 적용.
//  누적 hits 를 함께 반환(감사/telemetry 용). 키 이름은 건드리지 않는다(값만).
export function scrubPiiDeep<T>(v: T): { value: T; hits: PiiHit[]; total: number } {
  const acc: Record<PiiType, number> = { rrn: 0, biznum: 0, card: 0, phone: 0, email: 0 };
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") {
      const r = scrubPii(x);
      for (const h of r.hits) acc[h.type] += h.count;
      return r.text;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x as Record<string, unknown>)) o[k] = walk(val);
      return o;
    }
    return x;
  };
  const value = walk(v) as T;
  const hits = (Object.keys(acc) as PiiType[]).filter((t) => acc[t] > 0).map((t) => ({ type: t, count: acc[t] }));
  return { value, hits, total: hits.reduce((a, h) => a + h.count, 0) };
}
