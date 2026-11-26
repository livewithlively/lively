// 서술 형식 위반 중 «글에 없는 사실이 있어야 고칠 수 있다» 던 규칙을 사람 없이 풀기 위한 결정적 정리.
//
// local_path 는 홈 디렉터리 접두를 $HOME 으로 바꾸면 가리키는 곳은 같고 개인 계정 이름만 빠진다 — 결정적이라 서버가 한다.
// 순수 함수다(DB 없음).
import { MAC_HOME_SRC, WIN_HOME_SRC } from "./writing-lint.js";

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
