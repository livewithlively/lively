// 시험 러너의 차례 — 어떤 파일을 언제 띄우나(#5029). run-tests.mjs 가 쓰고, test-runner-schedule.test.mjs 가 규칙과
//  실제 러너의 동작을 함께 잰다(자식 env 경계는 test-runner-env.mjs — 다른 관심사라 따로 둔다).
//
// 혼자 도는 시험 — 벽시계 마감을 단언하는 시험(훅이 1.2초 안에 답을 못 받으면 끊는다 · 1.5초 예산의 70% 지점에서 멈춘다 …)은
//  다른 시험과 CPU 를 나눠 쓰면 시험 프로세스 안의 가짜 게이트웨이가 제때 못 답해 흔들린다. 2코어 중앙 박스(gVisor)는 기본 -j 2 에서
//  그런 넷이 빨갰고 혼자 돌리면 초록이었다(4코어 CI 는 여유가 있어 덜 드러났다 — 그래도 project-sync-ledger 는 10-21~22 에 네 번
//  빨갰다). 그런 파일은 머리에 `// @lively-test exclusive` 를 달고, 러너는 병렬 묶음을 다 돌린 뒤 하나씩 혼자 돌린다.
//  ⚠ 상한을 늘려 흔들림을 덮는 것과 다르다 — 그 시험이 재는 것이 제품의 마감 동작 자체라, 상한을 바꾸면 사양이 바뀐다.
import { openSync, readSync, closeSync } from "node:fs";

/** 표식을 찾는 머리 — 앞 4KB(바이트). 러너도 시험도 이 함수 하나로 읽는다(창이 둘이면 «시험은 봤는데 러너는 못 본» 표식이 생긴다).
 *  통째로 안 읽는 까닭: 시험 파일 1천여 개를 다 읽으면 9p 공유 폴더(중앙 박스)에서 그것만으로 느려진다. */
export const HEAD_BYTES = 4096;
export function readHead(file) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, HEAD_BYTES, 0));
  } finally { closeSync(fd); }
}

const SOLO_MARK = /^\s*\/\/\s*@lively-test\s+exclusive\b/m;
/** 글에 표식 줄이 있나 — 러너는 readHead() 의 머리에만 묻는다. 시험 쪽 린트는 파일 전체에도 묻는다(창 밖 표식 찾기). */
export const isSoloTest = (text) => SOLO_MARK.test(String(text ?? ""));
/** 혼자 도는 것을 맨 뒤로 — 각 묶음 안의 순서는 그대로 둔다. */
export const soloLast = (files, solo) => [...files.filter((f) => !solo.has(f)), ...files.filter((f) => solo.has(f))];
/** 다음 파일을 지금 띄워도 되나 — 혼자 도는 파일은 아무것도 안 돌 때만, 그 밖의 파일은 동시 실행수 안에서.
 *  혼자 도는 파일이 맨 뒤에 모여 있으니(soloLast) 그것이 도는 동안 보통 파일이 끼어들 일은 없다. */
export const mayStart = (nextIsSolo, running, jobs) => (nextIsSolo ? running === 0 : running < jobs);

// ── 브라우저 시험 — 헤드리스 크롬을 띄우는 시험은 러너가 크롬을 예열한 뒤에 띄운다 ─────────────────────────────────
//  갓 뜬 CI 러너에서 처음 띄우는 크롬 몇 개는 크롬을 디스크에서 처음 읽느라 첫 출력까지만 10~25초 막혀 시험의 30초 상한을 넘겼다
//  («크롬이 30초 안에 결과를 안 냈다» — 2026-11-19~26 유닛 1,536잡 중 21잡 · 전부 그 잡의 1~4번째 크롬. 근거는 headless-chrome.mjs warmChrome).
//  러너는 브라우저 시험이 하나라도 있으면 시작하자마자 크롬을 한 번 띄워 두고, 그 예열이 끝날 때까지 **브라우저 시험만** 안 띄운다.
//  크롬을 띄우는 길은 둘뿐이다 — scripts/headless-chrome.mjs(dumpDom · findChrome)와 직접 띄우는 CDP 시험(--remote-debugging-port).
//  ⚠ 앞 4KB(readHead)로는 모자란다 — 가져오기 줄이 11.7KB 에 있는 시험이 있다. 그래서 파일 전체를 보되 후보를 BROWSER_DIR 로 좁힌다
//   (브라우저 시험은 전부 거기 산다 — test-runner-schedule.test.mjs S10 이 지킨다. 밖에 생기면 예열을 안 기다릴 뿐 빠지지는 않는다).
const BROWSER_MARK = /["'](?:[^"'\n]*\/)?headless-chrome\.mjs["']|\bfindChrome\s*\(|--remote-debugging-port/;
export const BROWSER_DIR = "scripts/";
/** 글이 헤드리스 크롬을 띄우는 시험인가. */
export const usesBrowser = (text) => BROWSER_MARK.test(String(text ?? ""));

// ── 조각(shard) — 한 벌의 시험을 여러 CI 잡이 나눠 돈다 ─────────────────────────────────────────
//  CI 벽시계를 잡던 것은 시험의 수가 아니라 **한 잡이 전부를 혼자 돈다**는 것이었다(실측 2026-11-18: 유닛 1211 파일 · CPU 합 1749초를
//  4코어 한 대가 511초에, 그 뒤 PG 통합 106건을 같은 잡에서 하나씩 429초). 조각은 같은 체크아웃에서 `--shard=i/N` 을 N 번 부르면
//  **모든 파일이 정확히 한 조각에 드는** 나눔이다 — 무엇을 몇 번 부르든 합집합은 전체고 서로 겹치지 않는다(S7 이 그 성질을 잰다).

/** `--shard=i/N` 읽기 — 1 ≤ i ≤ N 인 정수 둘. 그 밖은 null(호출자가 죽인다 — 오타난 조각이 0건 초록이 되면 안 된다). */
export function parseShard(text) {
  const m = /^(\d+)\/(\d+)$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const index = Number(m[1]), total = Number(m[2]);
  return index >= 1 && total >= 1 && index <= total ? { index, total } : null;
}

/**
 * 파일을 total 개 조각으로 나눈다 — 무거운 것부터 그때 가장 가벼운 조각에 얹는다(같으면 번호가 앞선 조각).
 *  costOf 는 파일의 예상 비용(초). 모르는 파일은 호출자가 기본값을 준다 — 비용이 틀려도 **들어갈 조각이 달라질 뿐 빠지는 파일은 없다**.
 *  조각 안의 순서는 받은 순서 그대로다(혼자 도는 시험을 맨 뒤로 모으는 soloLast 가 조각 안에서도 그대로 선다).
 *  ⚠ 결정적이어야 한다 — 잡마다 따로 계산하므로 같은 입력이면 같은 나눔이 나와야 합집합이 전체다. 그래서 정렬의 동률을 경로로 푼다.
 */
export function shardFiles(files, total, costOf = () => 1) {
  const cost = new Map(files.map((f) => [f, Math.max(0, Number(costOf(f)) || 0)]));
  const order = [...files].sort((a, b) => cost.get(b) - cost.get(a) || (a < b ? -1 : a > b ? 1 : 0));
  const load = new Array(total).fill(0);
  const where = new Map();
  for (const f of order) {
    let at = 0;
    for (let i = 1; i < total; i++) if (load[i] < load[at]) at = i;
    load[at] += cost.get(f);
    where.set(f, at);
  }
  return Array.from({ length: total }, (_, i) => files.filter((f) => where.get(f) === i));
}
