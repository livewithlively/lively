// 서술 형식 위반 중 «글에 없는 사실이 있어야 고칠 수 있다» 던 규칙을 사람 없이 풀기 위한 사실 공급과 결정적 정리.
//
// relative_time·undated_status 는 «그 문장을 쓴 날» 이 있으면 고칠 수 있다. 그 날은 글이 아니라 저장 기록에 있다 —
//  이번 저장에서 처음 생긴 줄이면 오늘이고, 이미 있던 줄이면 그 줄이 처음 들어간 판의 저장 시각이다(감사 기록에 판마다
//  본문 전문이 남는다). 서버가 그 날을 찾아 기준 날짜(anchor)로 주면 에이전트는 날짜를 지어내지 않고 고칠 수 있다.
//  local_path 는 홈 디렉터리 접두를 $HOME 으로 바꾸면 가리키는 곳은 같고 개인 계정 이름만 빠진다 — 결정적이라 서버가 한다.
// 순수 함수다(DB 없음). 처음 들어간 판을 찾는 조회는 호출자가 넘긴다.
import { INLINE_CODE_RE, MAC_HOME_SRC, RELATIVE_TIME_RE, UNDATED_STATUS_RE, WIN_HOME_SRC, isQuote, unquoted } from "./writing-lint.js";

// ── 홈 경로 ──
// 탐지(writing-lint LOCAL_PATH_RE)와 같은 식을 쓴다 — 앞에 글자·경로 문자가 붙은 «/Users/» 는 API·URL·저장소 경로다.
//  /home/<계정>/ 은 바꾸지 않는다: 서버의 서비스 계정 경로(/home/ec2-user/app)인 경우가 많고, 그때 계정 이름은 사실이다.
//  ~/ 도 바꾸지 않는다 — 탐지가 위반으로 보지 않는 관례 표기이고, ssh_config·gitconfig 처럼 셸 밖에서는 $HOME 과 같은 뜻이 아니다.
//  같은 까닭으로 코드 펜스 안과 URL 안은 바꾸지 않는다 — 로그·설정 파일(JSON·ssh_config)·PowerShell·주소는 $HOME·%USERPROFILE% 이
//  풀리지 않는 글자 그대로다. 그 경로는 탐지에 남아 사람 확인(ask_human)이 된다(writing-style serverResolves).
//  한 글 안에서 같은 계열(맥·윈도)의 계정이 둘 이상이면 그 계열은 바꾸지 않는다 — «/Users/alice/… 에서 /Users/bob/… 로» 가
//  «$HOME/… 에서 $HOME/… 로» 가 되면 다른 두 자리가 같은 자리로 읽힌다.
const MAC_HOME_RE = new RegExp(MAC_HOME_SRC, "g");
const WIN_HOME_RE = new RegExp(WIN_HOME_SRC, "g");
const HOME_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HOME_URL_RE = /https?:\/\/\S+/g;

type HomeFamily = "mac" | "win";
const FAMILIES: Array<{ fam: HomeFamily; re: RegExp; to: string }> = [
  { fam: "mac", re: MAC_HOME_RE, to: "$HOME" },
  { fam: "win", re: WIN_HOME_RE, to: "%USERPROFILE%" },
];

/** 펜스 밖이면서 고를 줄인지 — 줄마다 true/false. 펜스 여닫는 줄 자체도 펜스다. */
function eligibleLines(lines: string[], touch?: (i: number) => boolean): boolean[] {
  const out: boolean[] = [];
  let fence: string | null = null;
  lines.forEach((raw, i) => {
    const m = HOME_FENCE_RE.exec(raw);
    if (fence) {
      out.push(false);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !raw.trim().slice(m[1].length).trim()) fence = null;
      return;
    }
    if (m) { fence = m[1]; out.push(false); return; }
    out.push(touch ? touch(i) : true);
  });
  return out;
}

/** 줄 안의 URL 구간 — 그 안에서 시작하는 홈 경로는 바꾸지 않는다. */
function urlRanges(line: string): Array<[number, number]> {
  return [...line.matchAll(HOME_URL_RE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}
const inRanges = (at: number, rs: Array<[number, number]>): boolean => rs.some(([a, b]) => at >= a && at < b);

/**
 * 개인 홈 디렉터리 접두를 $HOME(Windows 는 %USERPROFILE%)으로 바꾼다. 멱등이다. 가리키는 경로는 그대로다.
 *  touch 를 주면 그 줄(0부터)만 바꾼다 — 저장이 «이번에 쓴 줄» 만 고르게(changedLineFilter). 펜스 안·URL 안·계정이 둘 이상인
 *  계열은 바꾸지 않는다(머리말). replaced 는 바꾼 자리 수다.
 */
export function normalizeHomePathsCounted(s: string, touch?: (i: number) => boolean): { text: string; replaced: number } {
  const lines = String(s ?? "").split("\n");
  const ok = eligibleLines(lines, touch);
  const ranges = lines.map((l, i) => (ok[i] ? urlRanges(l) : []));
  // 계열마다 바꿀 자리의 계정을 모은다 — 둘 이상이면 그 계열은 그대로 둔다.
  const accounts: Record<HomeFamily, Set<string>> = { mac: new Set(), win: new Set() };
  lines.forEach((l, i) => {
    if (!ok[i]) return;
    for (const { fam, re } of FAMILIES) {
      for (const m of l.matchAll(re)) if (!inRanges(m.index ?? 0, ranges[i])) accounts[fam].add(String(m[1]).toLowerCase());
    }
  });
  let replaced = 0;
  const out = lines.map((l, i) => {
    if (!ok[i]) return l;
    let line = l;
    for (const { fam, re, to } of FAMILIES) {
      if (accounts[fam].size !== 1) continue;
      // 앞 계열을 바꾼 뒤의 줄에서 URL 구간을 다시 잰다(바꾼 만큼 자리가 움직인다).
      const rs = fam === "mac" ? ranges[i] : urlRanges(line);
      line = line.replace(re, (all: string, ...rest: unknown[]) => {
        const at = rest[rest.length - 2] as number;
        if (inRanges(at, rs)) return all;
        replaced++;
        return to;
      });
    }
    return line;
  });
  return { text: out.join("\n"), replaced };
}

/** normalizeHomePathsCounted 의 글만. */
export function normalizeHomePaths(s: string, touch?: (i: number) => boolean): string {
  return normalizeHomePathsCounted(s, touch).text;
}

/** normalizeHomePaths 가 바꿀 자리 수. */
export function countHomePaths(s: string): number {
  return normalizeHomePathsCounted(s).replaced;
}

/**
 * 원문(before)에 없던 줄만 고르는 touch — 다중집합으로 센다(원문에 한 번 있던 줄을 두 번 쓰면 두 번째는 새 줄).
 *  replace·edit 저장이 «이번에 쓴 줄» 의 경로만 바꾸게 한다. 원문에 있던 줄(사람이 쓴 경로 포함)은 이번 저장이 쓴 글이 아니다.
 */
export function changedLineFilter(after: string, before: string): (i: number) => boolean {
  const left = new Map<string, number>();
  for (const l of String(before ?? "").split("\n")) left.set(l, (left.get(l) ?? 0) + 1);
  const changed = String(after ?? "").split("\n").map((l) => {
    const n = left.get(l) ?? 0;
    if (n > 0) { left.set(l, n - 1); return false; }
    return true;
  });
  return (i: number) => changed[i] === true;
}

/** 글에 든 개인 홈 경로의 계정(«mac:bob»·«win:john doe», 소문자) — 펜스·URL 안까지 원문 전체에서. 재작성 게이트가
 *  «원문에 없던 계정 경로가 생겼나» 를 볼 때 쓴다(정규화하면 /Users/alice/x 와 /Users/bob/x 가 같아 보인다). */
export function homeAccounts(s: string): Set<string> {
  const out = new Set<string>();
  for (const { fam, re } of FAMILIES) for (const m of String(s ?? "").matchAll(re)) out.add(`${fam}:${String(m[1]).toLowerCase()}`);
  return out;
}

// ── 시점 표현이 있는 줄 ──
export type TimeRule = "relative_time" | "undated_status";
export interface TimeRefLine { line: string; rules: TimeRule[] }

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const DATE_IN_LINE_RE = /\b20\d{2}-\d{2}(?:-\d{2})?\b/;
const RELATIVE_ONE_RE = new RegExp(RELATIVE_TIME_RE.source);

/**
 * lint 가 relative_time·undated_status 로 잡는 줄을 원문 그대로 돌려준다(코드 펜스 안은 보지 않는다). 판정은 lint 와 같다
 *  — 인라인 코드·URL·따옴표 속·인용줄을 빼고 보고, undated 는 같은 줄에 날짜가 있으면 잡지 않는다. 같은 줄은 한 번만 싣는다.
 */
export function timeReferenceLines(body: string): TimeRefLine[] {
  const out = new Map<string, TimeRule[]>();
  let fence: string | null = null;
  for (const raw of String(body ?? "").split("\n")) {
    const m = FENCE_RE.exec(raw);
    if (fence) { if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !raw.trim().slice(m[1].length).trim()) fence = null; continue; }
    if (m) { fence = m[1]; continue; }
    if (isQuote(raw) || raw.length > 2000) continue;
    const prose = unquoted(raw.replace(INLINE_CODE_RE, "").replace(/https?:\/\/\S+/g, ""));
    const rules: TimeRule[] = [];
    if (RELATIVE_ONE_RE.test(prose)) rules.push("relative_time");
    if (UNDATED_STATUS_RE.test(prose) && !DATE_IN_LINE_RE.test(raw)) rules.push("undated_status");
    if (!rules.length) continue;
    const key = raw.trim();
    if (!out.has(key)) out.set(key, rules);
  }
  return [...out].map(([line, rules]) => ({ line, rules }));
}

// ── 기준 날짜 ──
/** this_save: 이번 저장에서 생긴 줄(오늘) · first_version: 그 줄이 처음 들어간 판의 저장일 · no_later_than: 처음 판을 못 찾아
 *  마지막 저장일까지만 안다(그 날 «이전에» 쓴 줄이다). */
export type AnchorBasis = "this_save" | "first_version" | "no_later_than";
export interface TimeAnchor { line: string; rules: TimeRule[]; date: string; basis: AnchorBasis }

/** 시각을 시간대의 날짜(YYYY-MM-DD)로. 시간대 이름이 틀리면 UTC. */
export function dateIn(at: Date | string | number, tz: string): string {
  const d = new Date(at);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** YYYY-MM-DD 에 n 일을 더한다(달력 계산 — 시간대 무관). */
export function shiftDate(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 한 번에 찾는 줄 수 상한 — 줄마다 감사 기록을 한 번 조회한다. 넘는 줄은 no_later_than 로 둔다. */
export const ANCHOR_LOOKUP_MAX = 12;

export interface AnchorInput {
  body: string;
  /** 저장이면 고치기 전 본문(신규는 null). 읽기면 undefined — 모든 줄이 이미 있던 줄이다. */
  beforeBody?: string | null;
  /** 지금(저장 시각). */
  now: Date;
  /** 지식의 마지막 저장 시각 — 처음 판을 못 찾을 때의 상한. 없으면 now. */
  updatedAt?: Date | string | null;
  tz: string;
  /** 이 줄이 처음 들어간 판의 저장 시각. 모르면 null. 실패하면 던져도 된다(no_later_than 로 둔다). */
  firstSeen?: (line: string) => Promise<Date | string | null>;
}

export async function timeAnchors(o: AnchorInput): Promise<TimeAnchor[]> {
  const lines = timeReferenceLines(o.body);
  if (!lines.length) return [];
  const today = dateIn(o.now, o.tz);
  const upper = dateIn(o.updatedAt ?? o.now, o.tz);
  const beforeLines = o.beforeBody === undefined ? null : new Set(String(o.beforeBody ?? "").split("\n").map((l) => l.trim()));
  const out: TimeAnchor[] = [];
  let lookups = 0;
  for (const { line, rules } of lines) {
    if (beforeLines && !beforeLines.has(line)) { out.push({ line, rules, date: today, basis: "this_save" }); continue; }
    let seen: Date | string | null = null;
    if (o.firstSeen && lookups < ANCHOR_LOOKUP_MAX) {
      lookups++;
      try { seen = await o.firstSeen(line); } catch { seen = null; }
    }
    out.push(seen ? { line, rules, date: dateIn(seen, o.tz), basis: "first_version" } : { line, rules, date: upper, basis: "no_later_than" });
  }
  return out;
}

/** 형식 정리 저장에 새로 들어와도 되는 날짜 — 기준 날짜와, 상대시간(어제·그저께)을 풀어 쓴 날. 이 밖의 날짜는 여전히 사실 변경이다. */
export function allowedAnchorDates(anchors: TimeAnchor[]): Set<string> {
  const out = new Set<string>();
  for (const a of anchors) {
    out.add(a.date);
    if (a.rules.includes("relative_time") && a.basis !== "no_later_than") {
      for (const n of [-2, -1, 1]) out.add(shiftDate(a.date, n));
    }
  }
  return out;
}

/** 에이전트에게 주는 고치는 법 — 한 줄씩. 날짜는 위 기준 날짜만 쓴다. */
export function anchorHint(a: TimeAnchor): string {
  const when = a.basis === "this_save" ? `이번 저장에서 쓴 줄이라 기준 날짜는 ${a.date}다`
    : a.basis === "first_version" ? `이 줄이 처음 저장된 날은 ${a.date}다`
    : `이 줄을 처음 쓴 날은 기록에 없고 ${a.date} 이전에 쓴 줄이다`;
  const how = a.basis === "no_later_than"
    ? `상대시간은 「${a.date} 이전」처럼, 상태 서술은 「(${a.date} 이전 작성)」처럼 적는다`
    : `상대시간은 이 날을 기준으로 절대 날짜로 바꾸고(어제는 ${shiftDate(a.date, -1)}), 상태 서술은 같은 문장에 「(${a.date} 기준)」을 붙인다`;
  return `${when}. ${how}. 지난주·이번 주·다음 주·엊그제처럼 날 하나로 풀리지 않는 말은 「(${a.date} 기준 지난주)」처럼 기준 날짜만 덧붙인다. 그 낱말이 시점이 아니라 이름·화면 문구·상태값이면 그대로 둔다.`;
}
