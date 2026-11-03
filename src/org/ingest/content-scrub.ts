// 수집 가림(#5308) — 커넥터가 모은 글을 **저장하기 전에** 연락처와 비밀번호 값을 가린다. 수집기마다 켠다(org_collector.pii_scrub).
//
//  왜 필요한가: 지금까지 문서를 숨기는 방법은 통째로 빼는 것뿐이었다(수집 제외·검색 제외·공개범위 잠금). 그러면 같은 문서의
//   업무 내용까지 사라진다(검색 시험에서 숨긴 문서 때문에 문항이 틀렸다). 원하는 것은 «페이지는 모두 가져오되 계정 정보와
//   고객 연락처만 가려서 적재» 다.
//
//  무엇을 가리나 — 가린 자리에는 종류를 남긴다(«[가림: 메일]»). AI 는 연락처·비밀번호가 **있었다는 사실**은 알고 값은 모른다.
//   · 연락처: 메일 · 전화(휴대폰 · 지역번호 · 070 · 안심번호 · +82 · 국제) · 주민등록번호(외국인등록번호) · 카드번호
//   · 비밀번호 · 비밀값: «키: 값» · «KEY=값» · JSON/YAML/XML · 접속 문자열(scheme://user:비번@host) · CLI 플래그
//     (--password · mysql -p · sshpass -p · curl -u) · Authorization: Basic · 표의 «비밀번호» 칸 · «계정: 아이디 / 비번»
//  무엇을 가리지 않나 — 이름 · 주소 · 사업자등록번호(공개 정보) · 계좌번호(형식이 은행마다 달라 오탐이 크다).
//
//  설계 원칙
//   · 오탐이 싸지 않다 — 가린 글은 원본을 다시 받기 전까지 되돌릴 수 없다. 그래서 **형식이 강한 것**만 문맥 없이 가리고
//     (하이픈 주민번호 · Luhn 카드 · 01X 휴대폰 · 메일), 약한 것은 **키가 붙어 있을 때만** 가린다(비밀번호 값 · 이상한 모양의
//     전화). 값처럼 안 보이는 것(한글 설명 · 자리표시자 · 환경변수 참조 · true/string 같은 낱말)은 남긴다.
//   · 위치 기반 — 모든 탐지기가 **원문 위치(span)** 를 모으고, 겹치면 먼저 잡은 쪽이 이긴다. 그리고 한 번에 바꾼다.
//     그래서 탐지기끼리 서로의 결과를 다시 읽지 않고, 같은 글을 두 번 돌려도 결과가 같다(가림 표시는 어떤 탐지기에도 안 걸린다).
//   · 링크 안의 숫자는 식별자다 — 슬랙 permalink 의 16자리 ts 가 카드로 가려져 링크가 깨진 사고가 있었다(#1301, ee pii-scrub).
//     URL 안에서는 전화·카드·주민번호를 찾지 않는다. 메일과 «token=값» 은 URL 안에서도 가린다(쿼리에 실린 것도 같은 값이다).
//   · 구조값(fields·raw)은 **키를 본다** — 노션 DB 의 «비밀번호» 칸, 전화번호 속성(type=phone_number)처럼 키가 종류를 말하면
//     형식과 무관하게 가린다. id·type·시각 같은 뼈대 키는 건드리지 않는다(노션 원장이 last_edited_time 으로 변경을 가른다).
//
//  ⚠ 코어(AGPL)에 둔다 — ee/ingest/pii-scrub.ts(프록시 응답 스크럽, EE)와 별개다. 판정(지식 ee-boundary-criteria-and-candidates):
//   포함 4조건 중 «조직이 구성원을 통제»(이건 데이터 정리 — 강제의 대상이 사람이 아니다)와 «소팀 가치 0»(다섯 명 팀도 노션의
//   DB 비밀번호가 AI 검색에 실리는 걸 원치 않는다)이 탈락한다. 비밀번호 가림은 redact.ts(절대 코어 목록)와 같은 결이다.
//  ⚠ 이 파일은 순수 함수만 둔다(import 없음) — 미러·소급 스윕·미리보기·시험이 같은 규칙을 쓴다.

/** 규칙 판. 규칙을 고치면 올린다 — 이 판과 다르게 표시된 행은 소급 스윕이 다시 가린다(fields._pii_scrub). */
export const CONTENT_SCRUB_VERSION = 1;

export type ScrubKind = "email" | "phone" | "rrn" | "card" | "password" | "secret";

export const SCRUB_LABELS: Readonly<Record<ScrubKind, string>> = {
  email: "[가림: 메일]",
  phone: "[가림: 전화]",
  rrn: "[가림: 주민번호]",
  card: "[가림: 카드번호]",
  password: "[가림: 비밀번호]",
  secret: "[가림: 비밀값]",
};

export type ScrubCounts = Record<ScrubKind, number>;

export function emptyScrubCounts(): ScrubCounts {
  return { email: 0, phone: 0, rrn: 0, card: 0, password: 0, secret: 0 };
}

export function addScrubCounts(into: ScrubCounts, from: ScrubCounts): ScrubCounts {
  for (const k of Object.keys(into) as ScrubKind[]) into[k] += from[k];
  return into;
}

export function totalScrubCounts(c: ScrubCounts): number {
  return c.email + c.phone + c.rrn + c.card + c.password + c.secret;
}

// ════════════════════════════════════════════════════════════════════════════
// ── 키 분류 — «이 이름 뒤에 오는 값은 무엇인가» ──
// ════════════════════════════════════════════════════════════════════════════

/** 키가 말하는 값의 종류. account 는 «계정: 아이디 / 비번» 꼴에서 / 뒤만 가린다. */
export type KeyKind = "password" | "secret" | "phone" | "email" | "rrn" | "account";

//  영문 키는 식별자 끝에 와야 한다(DB_PASSWORD · spring.datasource.password · userPassword · x-api-key).
//   낱말 안에서는 시작하지 않는다(bypass · compass · passport · tokenizer 는 키가 아니다). 비교는 카멜·하이픈을 밑줄로 푼 소문자에 한다.
const KEY_PASSWORD_EN = /(?:^|[^a-z0-9])(?:password|passwd|passwort|pwd|pw|pass|passphrase|passcode|pin|pincode)$/;
const KEY_SECRET_EN = /(?:^|[^a-z0-9])(?:secret|client_?secret|api_?key|apikey|api_?secret|access_?key|secret_?key|secret_?access_?key|private_?key|signing_?key|encryption_?key|master_?key|app_?secret|webhook_?secret|token|access_?token|refresh_?token|auth_?token|id_?token|session_?token|bearer_?token|bot_?token|credentials?)$/;
const KEY_PHONE_EN = /(?:^|[^a-z0-9])(?:phone|phone_?number|phone_?no|mobile|mobile_?phone|cellphone|cell_?phone|tel|telephone|fax)$/;
const KEY_EMAIL_EN = /(?:^|[^a-z0-9])(?:e_?mail|email_?address|mail_?address)$/;
const KEY_RRN_EN = /(?:^|[^a-z0-9])(?:rrn|ssn|resident_?(?:registration_?)?(?:number|no))$/;
//  한국어 키는 복합어 끝에 오면 된다(계정비밀번호 · DB비밀번호 · 담당자연락처). 공백은 빼고 비교한다.
//   «암호화» · «비밀번호변경» · «연락여부» 는 끝이 다르므로 걸리지 않는다.
const KEY_PASSWORD_KO = /(?:비밀번호|비번|패스워드|암호|핀번호|pin번호)$/;
const KEY_IDPW = /(?:id|아이디|계정)[/&](?:pw|pwd|pass|password|비번|비밀번호|패스워드)$/;
const KEY_SECRET_KO = /(?:시크릿|시크릿키|토큰|인증키|비밀키|액세스키|api키|암호키|개인키|앱시크릿)$/;
const KEY_PHONE_KO = /(?:전화|전화번호|휴대폰|휴대폰번호|핸드폰|핸드폰번호|휴대전화|휴대전화번호|폰번호|연락처|연락번호|팩스|팩스번호|대표번호)$/;
const KEY_EMAIL_KO = /(?:메일|이메일|메일주소|이메일주소|전자우편)$/;
const KEY_RRN_KO = /(?:주민번호|주민등록번호|외국인등록번호|외국인번호)$/;
//  «계정» 은 한국어 이름일 때만 — 영문 API 키 이름(account · login)은 계정 «짝» 이 아니라 식별자를 담는다.
const KEY_ACCOUNT_KO = /^(?:계정|계정정보|로그인정보|접속정보|접속계정|로그인계정|공용계정)$/;

/** 키 문자열(표 머리 칸 · 속성 이름 · JSON 키)을 종류로. 모르면 null. */
export function classifyKey(raw: string): KeyKind | null {
  if (!raw) return null;
  const decamel = raw.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
  const k = decamel.replace(/[*`~\\"']/g, "").replace(/\s+/g, "").toLowerCase().replace(/-/g, "_").replace(/[:：=]+$/, "");
  if (!k || k.length > 60) return null;
  if (KEY_IDPW.test(k)) return "password";
  if (KEY_PASSWORD_KO.test(k) || KEY_PASSWORD_EN.test(k)) return "password";
  if (KEY_SECRET_KO.test(k) || KEY_SECRET_EN.test(k)) return "secret";
  if (KEY_RRN_KO.test(k) || KEY_RRN_EN.test(k)) return "rrn";
  if (KEY_PHONE_KO.test(k) || KEY_PHONE_EN.test(k)) return "phone";
  if (KEY_EMAIL_KO.test(k) || KEY_EMAIL_EN.test(k)) return "email";
  if (KEY_ACCOUNT_KO.test(k)) return "account";
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// ── 값 판정 — «이건 비밀번호 값인가, 설명인가» ──
// ════════════════════════════════════════════════════════════════════════════

const HANGUL = /[\uAC00-\uD7A3\u3131-\u318E]/;
const HANGUL_CH = (c: string | undefined): boolean => !!c && HANGUL.test(c);
//  값 자리에 흔히 오지만 비밀이 아닌 낱말 — 스키마 설명(password: string)·상태(token: none)·시험 결과(Pass: OK)·표의 빈칸 표시.
const NOT_SECRET = new Set([
  "true", "false", "null", "none", "nil", "undefined", "yes", "no", "on", "off", "y", "n", "o", "x", "ok", "ng",
  "required", "optional", "string", "str", "text", "number", "int", "integer", "bool", "boolean", "varchar", "char",
  "any", "object", "array", "hidden", "masked", "empty", "blank", "n/a", "na", "tbd", "todo", "same", "unknown",
  "example", "sample", "dummy", "changeme", "default", "secret", "password", "token", "redacted",
  "pass", "passed", "fail", "failed", "done", "skip", "skipped",
]);
//  자리표시자·환경변수 참조 — 값이 아니라 «어디서 읽는다» 는 말이다(개발 문서의 정보라 남긴다).
const PLACEHOLDER = /^(?:<[^<>]*>|\{\{[\s\S]*\}\}|\$\{[\s\S]*\}|\$\([\s\S]*\)|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%?|\{[A-Za-z_][A-Za-z0-9_.]*\})$/;
const ENV_REF = /^(?:process\.env|os\.environ|os\.getenv|getenv\(|env\(|env\.|system\.getenv|env\[|secrets\.|vars\.|settings\.|config\.)/i;
const ALREADY_MASKED = /^(?:\[(?:가림|REDACTED)|[*xX•●·.\-_~=#…]+$)/;

/** 키 뒤의 값 하나(공백 없는 낱말 또는 따옴표 안)가 가릴 값인가. loose = 키와 값 사이에 구분자 없이 띄어 쓴 꼴(«비번 1234»). */
function qualifies(raw: string, kind: "password" | "secret", loose = false): boolean {
  const v = raw.trim();
  if (!v || v.length > 200) return false;
  if (HANGUL.test(v)) return false;                       // 한글이 섞이면 설명이다(«8자 이상», «변경 필요», «대표님께 문의»)
  if (ALREADY_MASKED.test(v)) return false;
  if (NOT_SECRET.has(v.toLowerCase())) return false;
  if (PLACEHOLDER.test(v) || ENV_REF.test(v)) return false;
  if (/^https?:\/\//i.test(v)) return false;
  if (kind === "secret") return v.length >= 8;            // 토큰·키는 짧지 않다(«token: 4096» 은 수다)
  if (/^\d+$/.test(v)) return v.length >= 4;              // 숫자만이면 PIN 길이부터(«Pass: 12» 는 통과 수다)
  if (loose) return v.length >= 4 && /[\d\W_]/.test(v);   // 구분자 없는 꼴은 숫자·기호가 섞여야(«비밀번호 reset» 은 낱말)
  return v.length >= 2;
}

function digitCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 48 && c <= 57) n++; }
  return n;
}

/** 전화로 볼 만한 값인가 — 키가 전화라고 말할 때만 쓴다(형식이 제멋대로여도: «010 1234 5678», «02)123-4567», «+82 10…»). */
function phoneLike(s: string): boolean {
  const d = digitCount(s);
  return d >= 7 && d <= 40;
}

// ════════════════════════════════════════════════════════════════════════════
// ── 위치 모음 ──
// ════════════════════════════════════════════════════════════════════════════

interface Span { s: number; e: number; k: ScrubKind }

/** 시작 위치로 정렬된 채 유지되는 겹치지 않는 구간 모음 — 겹침 판정·포함 판정을 이분 탐색으로(메일 수만 개 든 내보내기도 n·log n). */
class Spans {
  readonly list: Span[] = [];
  /** s 보다 시작이 큰 첫 구간의 자리. */
  private upper(pos: number): number {
    let lo = 0, hi = this.list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.list[mid].s <= pos) lo = mid + 1; else hi = mid; }
    return lo;
  }
  add(s: number, e: number, k: ScrubKind): boolean {
    if (!(e > s)) return false;
    const i = this.upper(s);                                  // 먼저 잡은 쪽이 이긴다 — 앞·뒤 이웃과만 겹칠 수 있다
    if (i > 0 && this.list[i - 1].e > s) return false;
    if (i < this.list.length && this.list[i].s < e) return false;
    this.list.splice(i, 0, { s, e, k });
    return true;
  }
  covers(pos: number): boolean {
    const i = this.upper(pos);
    return i > 0 && this.list[i - 1].e > pos;
  }
  apply(text: string, counts?: ScrubCounts): string {
    if (!this.list.length) return text;
    let out = "", at = 0;
    for (const sp of this.list) {
      out += text.slice(at, sp.s) + SCRUB_LABELS[sp.k];
      at = sp.e;
      if (counts) counts[sp.k]++;
    }
    return out + text.slice(at);
  }
}

/** pos 가 [a,b) 구간들(시작 순·겹침 없음 — URL 은 앞에서부터 찾으므로 그렇다) 안에 있나 — 이분 탐색. */
function inRanges(pos: number, ranges: Array<[number, number]>): boolean {
  let lo = 0, hi = ranges.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ranges[mid][0] <= pos) lo = mid + 1; else hi = mid; }
  return lo > 0 && ranges[lo - 1][1] > pos;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`\])|]+/gi;
function urlRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(URL_RE)) if (m.index !== undefined) out.push([m.index, m.index + m[0].length]);
  return out;
}

const CLOSER_OF: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{", ">": "<", "」": "「", "』": "『" };
function countCh(s: string, ch: string): number { let n = 0; for (const c of s) if (c === ch) n++; return n; }

/** 값 하나의 핵심 구간 — 끝의 문장부호·여는 괄호는 값이 아니고, 감싼 마크다운(**·__·`)은 벗긴다. «!» «?» 는 비밀번호에 흔해 둔다.
 *  닫는 괄호는 **짝이 안 맞을 때만** 뗀다 — «${DB_PASSWORD}» 의 «}» 를 떼면 자리표시자로 못 알아본다. */
function coreRange(text: string, s: number, e: number): [number, number] {
  while (e > s) {
    const ch = text[e - 1];
    if (",.;:([{<".includes(ch)) { e--; continue; }
    const open = CLOSER_OF[ch];
    if (open) { const seg = text.slice(s, e); if (countCh(seg, ch) > countCh(seg, open)) { e--; continue; } }
    break;
  }
  while (s < e && (text[s] === "*" || text[s] === "_")) s++;
  while (e > s && (text[e - 1] === "*" || text[e - 1] === "_")) e--;
  if (e - s >= 2 && text[s] === "`" && text[e - 1] === "`") { s++; e--; }
  return [s, e];
}

/** 키 뒤 p 에서 값 하나를 읽는다 — 따옴표·역따옴표 안 전체, 아니면 공백·한글(조사·어미) 전까지. */
function readValue(text: string, p: number, inUrl: boolean): [number, number] | null {
  const c = text[p];
  if (c === '"' || c === "'" || c === "`") {
    const close = text.indexOf(c, p + 1);
    if (close < 0 || close - p > 201) return null;
    if (text.slice(p + 1, close).includes("\n")) return null;
    return close > p + 1 ? [p + 1, close] : null;
  }
  let q = p;
  while (q < text.length && q - p <= 200) {
    const ch = text[q];
    if (/\s/.test(ch) || ch === '"' || ch === "'" || ch === "<" || ch === ">" || ch === "|") break;
    if (HANGUL_CH(ch)) break;                             // «qwer1234입니다» · «abc123으로» — 값 뒤에 붙은 조사·어미
    if (inUrl && ch === "&") break;                       // 쿼리 문자열의 다음 매개변수
    q++;
  }
  if (q === p) return null;
  const [s, e] = coreRange(text, p, q);
  return e > s ? [s, e] : null;
}

// ════════════════════════════════════════════════════════════════════════════
// ── 탐지기 ──
// ════════════════════════════════════════════════════════════════════════════

/** [s,e) 안의 낱말(공백·«/»·«,»·한글로 나뉜)마다 비밀번호·비밀값이면 가린다(표 칸 · 키가 말한 구조값). */
function maskTokens(text: string, s: number, e: number, kind: "password" | "secret", spans: Spans): void {
  const seg = text.slice(s, e);
  for (const m of seg.matchAll(/[^\s/,\uAC00-\uD7A3\u3131-\u318E]+/g)) {
    if (m.index === undefined) continue;
    const [a, b] = coreRange(text, s + m.index, s + m.index + m[0].length);
    if (b > a && qualifies(text.slice(a, b), kind)) spans.add(a, b, kind);
  }
}

/** «아이디 / 비번» 꼴이면 / 뒤를 비밀번호로 가린다(«team@example.com / qwer1234»). 앞쪽 메일은 메일 탐지가 가린다. */
function maskAccountPair(text: string, s: number, e: number, spans: Spans): void {
  const seg = text.slice(s, e);
  const m = /^\s*(\S+?)\s*\/\s*(\S+)\s*$/.exec(seg);
  if (!m) return;
  const end = s + seg.trimEnd().length;
  const [a, b] = coreRange(text, end - m[2].length, end);
  if (b > a && qualifies(text.slice(a, b), "password")) spans.add(a, b, "password");
}

/** 한 칸을 그 종류로 가린다. */
function maskCell(text: string, s: number, e: number, kind: KeyKind, spans: Spans): void {
  if (e <= s) return;
  const v = text.slice(s, e);
  if (kind === "phone") { if (phoneLike(v) && !v.includes("@")) spans.add(s, e, "phone"); return; }
  if (kind === "rrn") { if (digitCount(v) >= 6) spans.add(s, e, "rrn"); return; }
  if (kind === "email") return;                           // 메일은 형식이 강하다 — 아래 메일 탐지가 칸 안의 메일만 가린다
  if (kind === "account") { maskAccountPair(text, s, e, spans); return; }
  maskTokens(text, s, e, kind, spans);
}

// ── ① 마크다운 표 — 머리 칸이 종류를 말하면 그 열을, 첫 칸이 종류를 말하면 그 행을 가린다. ──
//  노션 DB 행은 본문 첫머리에 «| 속성 | 값 |» 표로 들어온다(notion-md propertiesTableMd) — «| 비밀번호 | qwer1234 |» 가 여기서 잡힌다.
//  «| 서비스 | 아이디 | 비밀번호 |» 같은 계정 표는 머리 칸으로 잡힌다.
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

interface Cell { s: number; e: number }

function cellsOf(line: string, base: number): Cell[] {
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i++) if (line[i] === "|" && line[i - 1] !== "\\") pipes.push(i);
  const cells: Cell[] = [];
  for (let j = 0; j + 1 < pipes.length; j++) {
    let s = pipes[j] + 1, e = pipes[j + 1];
    while (s < e && /\s/.test(line[s])) s++;
    while (e > s && /\s/.test(line[e - 1])) e--;
    cells.push({ s: base + s, e: base + e });
  }
  return cells;
}

function detectTables(text: string, spans: Spans): void {
  if (!text.includes("|")) return;
  const lines: Array<{ s: number; t: string }> = [];
  let pos = 0;
  for (const t of text.split("\n")) { lines.push({ s: pos, t }); pos += t.length + 1; }
  for (let i = 0; i < lines.length;) {
    if (!TABLE_ROW.test(lines[i].t)) { i++; continue; }
    let j = i;
    while (j < lines.length && TABLE_ROW.test(lines[j].t)) j++;
    const block = lines.slice(i, j);
    const sepAt = block.findIndex((l) => TABLE_SEP.test(l.t));
    const colKinds: Array<KeyKind | null> = [];
    if (sepAt > 0) for (const c of cellsOf(block[sepAt - 1].t, block[sepAt - 1].s)) colKinds.push(classifyKey(text.slice(c.s, c.e)));
    block.forEach((row, ri) => {
      if (ri === sepAt || (sepAt > 0 && ri === sepAt - 1)) return;   // 머리 줄·구분 줄은 값이 아니다
      const cells = cellsOf(row.t, row.s);
      const rowKind = cells.length >= 2 ? classifyKey(text.slice(cells[0].s, cells[0].e)) : null;
      cells.forEach((c, ci) => {
        const kind = rowKind && ci >= 1 ? rowKind : colKinds[ci];
        if (kind) maskCell(text, c.s, c.e, kind, spans);
      });
    });
    i = j;
  }
}

// ── ② 접속 문자열 — scheme://user:비번@host (postgres · mysql · mongodb+srv · redis · amqp · ftp · https). ──
//  메일 탐지보다 먼저 — 안 그러면 «비번@host.com» 이 메일로 잡혀 엉뚱한 이름이 붙는다.
const URL_USERINFO = /\b[a-z][a-z0-9+.-]{1,20}:\/\/([^\s:/@?#]*):([^\s/@?#]+)@/gi;
function decodeSafe(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }
function detectUrlUserinfo(text: string, spans: Spans): void {
  for (const m of text.matchAll(URL_USERINFO)) {
    if (m.index === undefined) continue;
    const pw = m[2];
    const s = m.index + m[0].length - 1 - pw.length;
    if (qualifies(decodeSafe(pw), "password")) spans.add(s, s + pw.length, "password");
  }
}

// ── ③ «아이디/비번: a / b» · «계정: a / b» — 짝으로 적힌 계정. / 뒤를 비밀번호로. ──
const KV_IDPW = /(?<![A-Za-z0-9])(?:id|ID|Id|아이디|계정)[ \t]*[/&][ \t]*(?:pw|PW|Pw|pwd|PWD|pass|Pass|PASS|password|Password|PASSWORD|비번|비밀번호|패스워드)[ \t]*[:：=][ \t]*/g;
const KV_ACCOUNT = /(?<![A-Za-z0-9가-힣])(?:계정|계정[ \t]?정보|로그인[ \t]?정보|접속[ \t]?정보|접속[ \t]?계정|로그인[ \t]?계정|공용[ \t]?계정)[ \t]*[:：=][ \t]*/g;
function detectAccountPairs(text: string, spans: Spans, claimedKeys: Array<[number, number]>): void {
  for (const re of [KV_IDPW, KV_ACCOUNT]) {
    for (const m of text.matchAll(re)) {
      if (m.index === undefined) continue;
      const p = m.index + m[0].length;
      claimedKeys.push([m.index, p]);
      const lineEnd = text.indexOf("\n", p);
      const line = text.slice(p, Math.min(lineEnd < 0 ? text.length : lineEnd, p + 300));
      const mm = /^(\S+?)[ \t]*\/[ \t]*([^\s\uAC00-\uD7A3]+)/.exec(line);
      if (mm) {
        const end = p + mm[0].length;
        const [a, b] = coreRange(text, end - mm[2].length, end);
        if (b > a && qualifies(text.slice(a, b), "password")) spans.add(a, b, "password");
      } else if (re === KV_IDPW) {
        const r = readValue(text, p, false);              // «ID/PW: qwer1234» — 값 하나면 그게 비밀번호다
        if (r && qualifies(text.slice(r[0], r[1]), "password")) spans.add(r[0], r[1], "password");
      }
    }
  }
}

// ── ④ «키: 값» — 영문(식별자 끝)·카멜·한국어 키 + 구분자(: = => -> · 은/는/이/가) + 값. ──
//  ReDoS 방지: 식별자 앞꼬리는 6마디까지만 본다(긴 snake_case 사슬에서 시작 위치마다 끝까지 훑지 않게).
const EN_KEYS = "password|passwd|passwort|pwd|pw|pass|passphrase|passcode|pin|pincode|secret|client[_-]?secret|api[_-]?key|apikey|api[_-]?secret|access[_-]?key|secret[_-]?key|secret[_-]?access[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|master[_-]?key|app[_-]?secret|webhook[_-]?secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|session[_-]?token|bearer[_-]?token|bot[_-]?token|credentials?";
//  키 뒤 경계에 «_» «-» 도 넣는다 — 안 넣으면 SECRET_KEY 에서 짧은 «SECRET» 이 먼저 잡혀 «_KEY=» 를 구분자로 못 본다.
const KV_EN = new RegExp(String.raw`(?<![A-Za-z0-9])(?:[A-Za-z0-9]{1,40}[_.-]){0,6}(?:${EN_KEYS})(?![A-Za-z0-9_-])`, "gi");
const KV_CAMEL = /(?<![A-Za-z0-9])[a-z][a-zA-Z0-9]{0,40}(?:Password|Passwd|Pwd|Passphrase|Secret|ClientSecret|ApiKey|ApiSecret|AccessKey|SecretKey|PrivateKey|AccessToken|RefreshToken|AuthToken|IdToken|SessionToken|BotToken|Token|Credentials?)(?![a-z0-9])/g;
const KV_KO = /(?:비밀번호|비번|패스워드|암호|핀[ \t]?번호|PIN[ \t]?번호|시크릿[ \t]?키|시크릿|토큰|인증[ \t]?키|비밀[ \t]?키|액세스[ \t]?키|API[ \t]?키|api[ \t]?키|앱[ \t]?시크릿)/g;
//  키 바로 뒤 — 닫는 따옴표(JSON·YAML 키) 다음 구분자. 줄은 넘지 않는다(다음 줄 첫 낱말을 값으로 읽지 않게).
const KV_SEP = /^["'`]?[ \t]*(?:=>|->|[:：=])[ \t]*/;
const KV_SEP_PARTICLE = /^[ \t]*(?:은|는|이|가)[ \t]+/;
const KV_SEP_LOOSE = /^[ \t]+/;          // 한국어 비밀번호 키만 — «비번 1234», «비밀번호 qwer1234!»

function kindOfKeyText(key: string): "password" | "secret" | null {
  const k = classifyKey(key);
  return k === "password" || k === "secret" ? k : null;
}

function detectKeyValues(text: string, spans: Spans, urls: Array<[number, number]>, claimedKeys: Array<[number, number]>): void {
  const tryAt = (keyStart: number, keyEnd: number, kind: "password" | "secret", allowLoose: boolean): void => {
    if (inRanges(keyStart, claimedKeys) || spans.covers(keyStart)) return;
    const rest = text.slice(keyEnd, keyEnd + 40);
    let m = KV_SEP.exec(rest);
    let loose = false;
    if (!m) m = KV_SEP_PARTICLE.exec(rest);
    if (!m && allowLoose) { m = KV_SEP_LOOSE.exec(rest); loose = !!m; }
    if (!m) return;
    const p = keyEnd + m[0].length;
    if (p >= text.length) return;
    const r = readValue(text, p, inRanges(p, urls));
    if (r && qualifies(text.slice(r[0], r[1]), kind, loose)) spans.add(r[0], r[1], kind);
  };
  for (const re of [KV_EN, KV_CAMEL]) {
    for (const m of text.matchAll(re)) {
      if (m.index === undefined) continue;
      const kind = kindOfKeyText(m[0]);
      if (kind) tryAt(m.index, m.index + m[0].length, kind, false);
    }
  }
  for (const m of text.matchAll(KV_KO)) {
    if (m.index === undefined) continue;
    const kind = kindOfKeyText(m[0].replace(/[ \t]/g, ""));
    if (!kind) continue;
    // «암호화» · «비밀번호변경» · «토큰을» — 키 뒤에 한글이 바로 붙으면 다른 낱말이다(조사 은/는/이/가 + 띄어쓰기는 예외)
    const end = m.index + m[0].length;
    if (HANGUL_CH(text[end]) && !/^(?:은|는|이|가)[ \t]/.test(text.slice(end, end + 2))) continue;
    tryAt(m.index, end, kind, kind === "password");
  }
}

// ── ⑤ XML · CLI · 헤더 ──
const XML_SECRET = /<(password|passwd|pwd|secret|token|apiKey|api_key|accessKey|secretKey|clientSecret|client_secret)>([^<\n]{1,200})<\/\1>/gi;
const CLI_LONG = /(?<![A-Za-z0-9-])--(password|passwd|pass|db-password|token|api-key|apikey|secret|client-secret|auth-token)(?:=|[ \t]+)(["']?)([^\s"']+)\2/gi;
const CLI_MYSQL = /\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]*?[ \t]-p(?:(["'])([^"'\n]+)\1|([^\s"'-][^\s"']*))/g;
const CLI_SSHPASS = /\bsshpass[ \t]+-p[ \t]*(["']?)([^\s"']+)\1/g;
const CLI_CURL_U = /\bcurl\b[^\n]*?[ \t](?:-u|--user)[ \t]+(["']?)([^\s:"']+):([^\s"']+)\1/g;
const BASIC_AUTH = /Authorization["']?[ \t]*[:=][ \t]*["']?Basic[ \t]+([A-Za-z0-9+/]{8,}={0,2})/gi;

function detectCli(text: string, spans: Spans): void {
  const at = (s: number, v: string, kind: "password" | "secret", force = false): void => {
    if (force || qualifies(v, kind)) spans.add(s, s + v.length, kind);
  };
  for (const m of text.matchAll(XML_SECRET)) {
    if (m.index === undefined) continue;
    at(m.index + m[1].length + 2, m[2], kindOfKeyText(m[1]) ?? "secret");
  }
  for (const m of text.matchAll(CLI_LONG)) {
    if (m.index === undefined) continue;
    at(m.index + m[0].length - m[2].length - m[3].length, m[3], kindOfKeyText(m[1]) ?? "secret");
  }
  for (const m of text.matchAll(CLI_MYSQL)) {
    if (m.index === undefined) continue;
    const v = m[2] ?? m[3];
    at(m.index + m[0].length - v.length - (m[2] !== undefined ? 1 : 0), v, "password");
  }
  for (const m of text.matchAll(CLI_SSHPASS)) {
    if (m.index === undefined) continue;
    at(m.index + m[0].length - m[1].length - m[2].length, m[2], "password");
  }
  for (const m of text.matchAll(CLI_CURL_U)) {
    if (m.index === undefined) continue;
    at(m.index + m[0].length - m[1].length - m[3].length, m[3], "password");
  }
  for (const m of text.matchAll(BASIC_AUTH)) {
    if (m.index === undefined) continue;
    at(m.index + m[0].length - m[1].length, m[1], "secret", true);
  }
}

// ── ⑥ 키가 붙은 주민번호·전화(형식이 약해도) ──
const KV_RRN = /(?:주민[ \t]?(?:등록[ \t]?)?번호|외국인[ \t]?(?:등록[ \t]?)?번호)[ \t]*[:：=]?[ \t]*(\d{6}[ \t]?-?[ \t]?\d{7})(?!\d)/g;
const KV_PHONE = /(?:연락처|전화[ \t]?번호|전화|휴대[ \t]?(?:폰|전화)(?:[ \t]?번호)?|핸드폰(?:[ \t]?번호)?|대표[ \t]?번호|팩스|(?<![A-Za-z])(?:tel|Tel|TEL|phone|Phone|PHONE|mobile|Mobile|MOBILE|fax|Fax|FAX))\.?[ \t]*[:：=)]?[ \t]*([+(]?\d[\d \t.)+-]{5,22}\d)/g;
function detectKeyedContacts(text: string, spans: Spans, urls: Array<[number, number]>): void {
  for (const m of text.matchAll(KV_RRN)) {
    if (m.index === undefined) continue;
    const s = m.index + m[0].length - m[1].length;
    spans.add(s, s + m[1].length, "rrn");
  }
  for (const m of text.matchAll(KV_PHONE)) {
    if (m.index === undefined) continue;
    const v = m[1];
    const s = m.index + m[0].length - v.length;
    if (inRanges(s, urls)) continue;
    const d = digitCount(v);
    if (d >= 7 && d <= 15) spans.add(s, s + v.length, "phone");
  }
}

// ── ⑦ 형식이 강한 것 — 문맥 없이 가린다 ──
//  주민번호: 생년월일(월·일 범위) + 성별자리 1~8 + 하이픈. 2020-10 이후 번호는 끝자리 검증이 없어 체크섬은 보지 않는다.
//   하이픈 없는 13자리는 키가 붙을 때만(위 ⑥) — 밀리초 타임스탬프 13자리가 날짜 꼴을 우연히 통과한다.
const RRN_RE = /(?<![\dA-Za-z])(?<!\d-)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[ \t]?-[ \t]?[1-8]\d{6}(?![\dA-Za-z])(?!-\d)/g;
//  카드: 4자리 묶음을 구분자로 나눈 꼴만 + Luhn. 붙여 쓴 16자리는 식별자·타임스탬프와 구분이 안 된다.
const CARD_RE = /(?<![\dA-Za-z])(?<!\d[- ])(?:\d{4}([- ])\d{4}\1\d{4}\1\d{4}(?:\1\d{1,3})?|\d{4}([- ])\d{6}\2\d{5})(?![\dA-Za-z])(?![- ]\d)/g;
//  휴대폰: 01X(구분자 없어도) · +82 10 …. 지역번호·070·안심번호(050X)는 구분자가 있어야(붙여 쓴 숫자는 다른 번호일 수 있다).
const MOBILE_RE = /(?<![\dA-Za-z+])(?<!\d[-.])(?:(?:\+82|\(\+82\))[-. \t]?0?|0)1[016789](?:[-. \t)]{1,2}|)\d{3,4}[-. \t]?\d{4}(?![\dA-Za-z])(?![-.]\d)/g;
const LANDLINE_RE = /(?<![\dA-Za-z+])(?<!\d[-.])(?:(?:\+82|\(\+82\))[-. \t]?0?|0)(?:2|3[1-3]|4[1-4]|5[1-5]|6[1-4]|70|50[2-8])(?:\)[ \t]?|[-. \t])\d{3,4}[-. \t]\d{4}(?![\dA-Za-z])(?![-.]\d)/g;
const LANDLINE_PAREN_RE = /\(0(?:2|3[1-3]|4[1-4]|5[1-5]|6[1-4]|70|50[2-8])\)[ \t]?\d{3,4}[-. \t]\d{4}(?![\dA-Za-z])(?![-.]\d)/g;
const INTL_RE = /(?<![\dA-Za-z+])\+(?!82)\d{1,3}[-. \t]?(?:\(\d{1,4}\)[-. \t]?)?\d{1,4}(?:[-. \t]\d{2,4}){1,3}(?![\dA-Za-z])(?![-.]\d)/g;
//  메일: 앞이 메일 글자가 아닐 때만 시작(긴 문자열에서 시작 위치마다 훑지 않게). 이미지 이름(icon@2x.png)은 메일이 아니다.
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,6}\.([A-Za-z]{2,24})(?![A-Za-z0-9-])/g;
const FILE_TLD = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "pdf", "js", "mjs", "ts", "tsx", "jsx", "css", "scss", "html", "htm", "json", "md", "txt", "zip", "gz", "tar", "mp4", "mov", "mp3", "wav", "csv", "xlsx", "docx", "pptx", "yml", "yaml", "lock", "py", "rb", "go", "rs", "java", "kt", "swift", "sh"]);
const MD_CONTACT_LINK = /\[([^\]\n]{0,200})\]\((mailto|tel):[^)\s]{1,200}\)/gi;

function luhn(raw: string): boolean {
  const d = raw.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

function detectPatterns(text: string, spans: Spans, urls: Array<[number, number]>): void {
  for (const m of text.matchAll(MD_CONTACT_LINK)) {
    if (m.index === undefined) continue;
    spans.add(m.index, m.index + m[0].length, m[2].toLowerCase() === "tel" ? "phone" : "email");
  }
  const outsideUrl = (re: RegExp, kind: ScrubKind, ok?: (s: string) => boolean): void => {
    for (const m of text.matchAll(re)) {
      if (m.index === undefined || inRanges(m.index, urls)) continue;
      if (ok && !ok(m[0])) continue;
      spans.add(m.index, m.index + m[0].length, kind);
    }
  };
  outsideUrl(RRN_RE, "rrn");
  outsideUrl(CARD_RE, "card", luhn);
  outsideUrl(MOBILE_RE, "phone");
  outsideUrl(LANDLINE_PAREN_RE, "phone");
  outsideUrl(LANDLINE_RE, "phone");
  outsideUrl(INTL_RE, "phone", (s) => { const d = digitCount(s); return d >= 8 && d <= 15; });
  for (const m of text.matchAll(EMAIL_RE)) {
    if (m.index === undefined) continue;
    if (FILE_TLD.has(m[1].toLowerCase())) continue;
    if (/^\d+x\./i.test(m[0].slice(m[0].indexOf("@") + 1))) continue;   // icon@2x.retina
    spans.add(m.index, m.index + m[0].length, "email");
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ── 공개 표면 ──
// ════════════════════════════════════════════════════════════════════════════

/** 글 하나를 가린다. counts 를 주면 종류별 건수를 더한다. 같은 글을 다시 넣어도 결과가 같다. */
export function scrubText(input: string, counts?: ScrubCounts): string {
  if (typeof input !== "string" || input.length === 0) return input;
  const spans = new Spans();
  const urls = urlRanges(input);
  const claimedKeys: Array<[number, number]> = [];
  detectTables(input, spans);
  detectUrlUserinfo(input, spans);
  detectAccountPairs(input, spans, claimedKeys);
  claimedKeys.sort((a, b) => a[0] - b[0]);                 // 두 정규식이 따로 모았다 — 이분 탐색 전에 순서를 맞춘다
  detectCli(input, spans);
  detectKeyValues(input, spans, urls, claimedKeys);
  detectKeyedContacts(input, spans, urls);
  detectPatterns(input, spans, urls);
  return spans.apply(input, counts);
}

// ── 구조값(fields · raw) — 키를 보고 가린다 ──
//  뼈대 키(id · type · 시각)는 값이 아니다 — 노션 원장이 last_edited_time 으로 변경을 가르고, id 는 링크·부모 해소에 쓰인다.
const STRUCT_KEYS = new Set(["id", "ids", "object", "type", "color", "uuid", "_item_type", "_pii_scrub"]);
const STRUCT_KEY_RE = /(?:^|_)(?:id|ids)$|[a-z](?:Id|Ids)$|_time$|_at$|^ts$|_ts$|^timestamp$/;

function scrubLeaf(s: string, kind: KeyKind | null, counts?: ScrubCounts): string {
  if (!s) return s;
  switch (kind) {
    case "password": case "secret": {
      const spans = new Spans();
      maskTokens(s, 0, s.length, kind, spans);
      return scrubText(spans.apply(s, counts), counts);
    }
    case "phone":
      if (phoneLike(s) && !s.includes("@")) { if (counts) counts.phone++; return SCRUB_LABELS.phone; }
      return scrubText(s, counts);
    case "rrn":
      if (digitCount(s) >= 6) { if (counts) counts.rrn++; return SCRUB_LABELS.rrn; }
      return scrubText(s, counts);
    case "email":
      if (s.includes("@") && !/\s/.test(s.trim())) { if (counts) counts.email++; return SCRUB_LABELS.email; }
      return scrubText(s, counts);
    case "account": {
      const spans = new Spans();
      maskAccountPair(s, 0, s.length, spans);
      return scrubText(spans.apply(s, counts), counts);
    }
    default:
      return scrubText(s, counts);
  }
}

function walk(v: unknown, kind: KeyKind | null, counts?: ScrubCounts): unknown {
  if (typeof v === "string") return scrubLeaf(v, kind, counts);
  if (Array.isArray(v)) return v.map((x) => walk(x, kind, counts));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    //  노션 속성 객체는 type 이 종류를 말한다(phone_number · email) — 속성 이름이 «담당»이어도 값은 전화다.
    let objKind = kind;
    if (o.type === "phone_number") objKind = "phone";
    else if (o.type === "email" && !objKind) objKind = "email";
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
      if (STRUCT_KEYS.has(k) || STRUCT_KEY_RE.test(k)) { out[k] = val; continue; }
      out[k] = walk(val, classifyKey(k) ?? objKind, counts);
    }
    return out;
  }
  return v;
}

/** 구조값을 깊이 가린다(키 이름은 그대로, 값만). 입력은 건드리지 않는다. */
export function scrubDeep<T>(v: T, counts?: ScrubCounts): T {
  return walk(v, null, counts) as T;
}

// ── 원장(raw) 줄이기 — 본문·fields 가 이미 담고 있는 «내용 사본» 은 가림을 켜면 저장하지 않는다 ──
//  왜: 원장의 글은 조각으로 쪼개져 있다. 노션 rich_text 는 «PW: » 와 인라인 코드 «qwer1234» 가 다른 조각이고, 표는 칸마다
//   따로다(슬랙 blocks 도 같다). 글 단위 탐지로는 조각에 남은 값을 못 잡는다. 이 칸들은 커넥터가 «원장» 으로만 남기고 읽는 코드가
//   없다(노션 델타 원장이 읽는 것은 page/database 의 last_edited_time · data_sources 뿐 — notion-post.loadNotionLedger,
//   증류는 body_md 만 읽는다). 그래서 남기지 않는다. 같은 내용은 본문(body_md)과 정규화 속성(fields.notion.properties)에 가려진 채 있다.
//   지메일 원장의 payload 는 머리(보낸·받는 사람)와 본문을 base64 로 담는다 — 글 탐지가 못 읽는 인코딩이라 남기면 그대로 저장된다.
//   (첨부 원본 받기는 외부 id 로 다시 받는다 — 원장을 읽지 않는다.)
const RAW_CONTENT_PATHS: Readonly<Record<string, ReadonlyArray<readonly string[]>>> = {
  notion: [["blocks"], ["comments"], ["property_items"], ["page", "properties"]],
  slack: [["blocks"]],
  gmail: [["payload"]],
};

/** 가림을 켠 수집기의 원장에서 내용 사본을 뺀다(경로를 따라 얕은 복사 — 입력은 건드리지 않는다). */
export function minimizeRaw(system: string, raw: unknown): unknown {
  const paths = RAW_CONTENT_PATHS[system];
  if (!paths || !raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const root: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const path of paths) {
    let node: Record<string, unknown> | null = root;
    for (let i = 0; i < path.length - 1 && node; i++) {
      const next: unknown = node[path[i]];
      if (!next || typeof next !== "object" || Array.isArray(next)) { node = null; break; }
      const copy: Record<string, unknown> = { ...(next as Record<string, unknown>) };
      node[path[i]] = copy;
      node = copy;
    }
    if (node) delete node[path[path.length - 1]];
  }
  return root;
}

// ── 감사 스냅샷 — 변경 이력의 before/after 에 남은 본문도 같은 규칙으로 ──
//  이력(knowledge_history)은 옛 본문 전문을 보여 주고 되돌리기까지 한다. 본문만 가리면 이력에서 값이 그대로 보이고, 되돌리면 돌아온다.
const SNAPSHOT_TEXT_KEYS = ["title", "body_md", "description", "summary"] as const;

/** 스냅샷 하나(객체)의 글 칸을 가린다. 바뀐 게 없으면 changed=false(같은 객체). */
export function scrubSnapshot(v: unknown): { value: unknown; changed: boolean } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { value: v, changed: false };
  const o = v as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const k of SNAPSHOT_TEXT_KEYS) {
    const cur = o[k];
    if (typeof cur !== "string" || !cur) continue;
    const next = scrubText(cur);
    if (next !== cur) { out ??= { ...o }; out[k] = next; }
  }
  return out ? { value: out, changed: true } : { value: v, changed: false };
}
