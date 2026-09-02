// #2544 (2단계) — «세션 목록의 정본은 DB, tmux 는 관측» 의 **배선**을 지킨다.
//
// 왜 소스 텍스트를 보나: 이 변경의 실패 모양은 판정 함수가 틀리는 것이 아니라 **아무도 그 판정을 부르지 않는 것**이다
//  (#1820 의 회귀와 같은 부류 — 순수 시험은 전부 초록인데 기능만 죽어 있었다). 그래서 '누가 누구를 어느 분기에서
//  부르는가' 를 여기서 못 박는다. 순수 판정 자체는 src/terminal/session-unobserved.test.ts · session-ledger.test.ts 가 잰다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

// ── ① collectSessions — tmux 를 «못 봤을 때» 빈 목록이 아니라 desired 폴백으로 간다 ────────────
{
  const src = read("src/terminal/sessions.ts");
  const i = src.indexOf("async function collectSessions(");
  assert.ok(i > 0, "collectSessions 를 찾지 못했습니다");
  const blk = src.slice(i, src.indexOf("\n}\n", i));
  const catchAt = blk.indexOf("catch (e)");
  const strictThrow = blk.indexOf("if (strict && !isNoTmuxServer(e)) throw e;", catchAt);
  const fallback = blk.indexOf("shouldFallbackToDesired(", catchAt);
  const call = blk.indexOf("desiredFallbackSessions(", catchAt);
  ok(strictThrow > 0, "①-a strict 호출은 종전 그대로 던진다(«없음» 으로 오해하지 않는다)");
  ok(fallback > strictThrow, "①-b strict 가 아니면 shouldFallbackToDesired 로 «못 봤다 vs 없다» 를 가른다 — strict throw 뒤에");
  ok(call > fallback, "①-c 폴백이면 desiredFallbackSessions(DB desired 행) 로 간다");
  ok(/shouldFallbackToDesired\(e,\s*tmuxRelayManaged\(\)\)/.test(blk), "①-d 폴백 여부는 매니지드 중계일 때만(tmuxRelayManaged) — 셀프호스팅은 종전 그대로 빈 목록");
  // 폴백 행은 관측이 아니다 — 회수·복원 판정이 이 행을 «살아 있다» 로 읽으면 안 되므로 observed:false 를 싣는다.
  const uo = read("src/terminal/session-unobserved.ts");
  ok(/observed:\s*false/.test(uo), "①-e 폴백 행은 observed:false 다");
  ok(!/restorable:\s*true/.test(uo), "①-f 폴백 행은 restorable 을 약속하지 않는다(열기=복원 #1820 이 잘못 발동하면 안 된다)");
}

// ── ② 장부 라우트 — 등록됐고, tmux 는 strict 로 읽어 «못 봤다» 를 observed:false 로 옮긴다 ─────────
{
  const routes = read("src/terminal/routes.ts");
  const reg = routes.indexOf("export function registerTerminal(");
  const blk = routes.slice(reg, routes.indexOf("\n}\n", reg));
  ok(blk.includes("registerSessionLedgerRoute(app)"), "②-a registerTerminal 이 장부 라우트를 등록한다");
  const ledger = read("src/terminal/session-ledger.ts");
  ok(ledger.includes('"/api/ui/terminal/session-ledger"'), "②-b 경로는 /api/ui/terminal/session-ledger (브로커 fetchSessionLedger 와 같은 문자열)");
  ok(/listLiveSessionIds\(\{\s*strict:\s*true\s*\}\)/.test(ledger), "②-c 라이브는 strict 로 읽는다 — 못 봤으면 throw → observed:false");
  ok(/ledgerAccess\(/.test(ledger), "②-d 접근 판정(ledgerAccess)을 라우트가 실제로 부른다");
  // ⚠ 사용자 인증(auth) 을 붙이지 않는다 — 기계(브로커)는 사람 세션이 없다. 대신 테넌트 비밀로 문을 연다.
  const routeAt = ledger.indexOf('app.get("/api/ui/terminal/session-ledger"');
  ok(routeAt > 0 && !/app\.get\("\/api\/ui\/terminal\/session-ledger",\s*auth/.test(ledger), "②-e 라우트는 사용자 auth 없이(테넌트 비밀 게이트로) 열린다");
  //  ★ auth 가 없으니 테넌트 헤더만으론 부족하다 — 라우터가 그 헤더를 인터넷 요청에도 붙인다. 서명(HMAC)을 요구해야 한다.
  ok(/timingSafeEqual/.test(ledger) && /ledgerAuthToken\(secret, r\.tenant\.slug\)/.test(ledger), "②-f 접근 판정이 slug 에 묶인 HMAC 서명을 상수시간 비교로 요구한다");
}

console.log(`\n${pass} assertions passed`);
