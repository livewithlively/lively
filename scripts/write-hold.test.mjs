// #3870 — 방금 치운 · 휴지통으로 보낸 세션 줄을 떠 있던 읽기가 되세우지 않는다(lib/write-hold) · 셸이 그걸 쓴다.
//
//  원준 2026-10-04 신고: "기록만 남은 세션이에요 — 대화는 그대로 이어받을 수 있어요. 이어서 대화하기 이 상태인 세션을 홈의
//   사이드바에서 삭제할때 한 번에 삭제가 안되고 버버벅 거리면서 깜빡 거리면서 좀 기다려야 삭제될 때가 있음 뭔가 어색하미."
//  매니지드 실측(쓰기 차단 헤드리스 — 줄의 있고 없음을 프레임마다 적음, 왕복 지연 250ms 를 얹음):
//   ① 줄 넷을 0.6초 간격으로 × → 사라진 줄이 2번 다시 섰다(화면 전이 8번, 깔끔하면 4번). 폴링이 출발한 직후에 × → 없음 → 있음 → 없음.
//   ② 우클릭 「휴지통으로 보내기」 → 줄이 0.6~1.2초 그대로 서 있다(서버 답 + 목록 한 판을 다 기다린다).
//   ③ 한 번 열어 본 세션(보고 있거나, 열었다가 홈으로 돌아옴)을 휴지통으로 → 30초 뒤에도 줄이 있다(안 보이는 창이 줄을 세운다).
//   ④ 기록 축의 최근 200건 밖에 있는 기록만 남은 세션을 휴지통으로 → 25초 뒤에도 줄이 있다(깊은 판 5분 주기를 기다린다.
//      얕은 판 응답을 5건으로 줄여 재현).
//
// 사양(엣지 표 — 행마다 단언 하나 이상)
//  A. 읽기 순서
//   O1 출발 번호는 부를 때마다 커진다
//   O2 처음 도착한 답은 적는다
//   O3 먼저 출발한 읽기가 나중에 도착하면 그 축엔 안 적는다 — 축마다 따로(다른 축은 적는다)
//   O4 같은 판을 두 번 물으면 둘 다 적는다(인스턴스 축은 한 판에 두 번 적힌다)
//  B. 붙들기
//   H1 붙들면 곧바로 values() 에 있다 · 붙든 순서대로
//   H2 서버 답(ack) 전에는 어떤 읽기도 못 놓는다(몇 판이 와도)
//   H3 ack **전에 출발한** 읽기는 ack 뒤에 도착해도 못 놓는다
//   H4 ack **뒤에 출발한** 읽기가 그 축을 적으면 놓는다(경계 — ack 바로 다음 번호)
//   H5 축이 둘이면 둘 다 새 답으로 적혀야 놓는다 — 한 축만으로는 못 놓고, 서로 다른 판이 채워도 된다
//   H6 그 축을 못 적은 판(요청 실패 — take 를 안 부름)은 못 놓는다
//   H7 fail 은 곧바로 놓는다 · 그 뒤의 ack 는 아무 일도 안 한다
//   H8 ack 를 두 번 불러도 처음 것만 센다(두 ack 사이에 출발한 읽기가 놓는다)
//   H9 붙든 것이 여럿이면 따로 놓인다(먼저 답받은 것만)
//   H10 걸린 축이 없는 쓰기는 ack 때 놓인다(새로 들인 axes 가 빈 경우)
//   H11 버려진 옛 답(take 가 false)은 아무것도 못 놓는다
//   H12 붙든 것이 하나도 없을 때 values() 는 빈 배열 · take 는 그대로 돈다(새로 들인 것이 빈 경우)
//  C. 실측한 경합을 작은 모형으로(서버 한 값 · 읽기 답은 출발 시점의 서버 값 · 화면 = 마지막에 적힌 답 + 붙든 것)
//   S1 폴링이 출발한 직후에 치운다 → 그 답이 와도 줄이 다시 안 선다
//   S1′ 치우기 전에 출발한 답이 서버 답 **뒤에** 도착한다(느린 폴링) → 줄이 다시 안 선다
//   S2 연달아 둘을 치운다(첫째의 다시 읽기가 둘째의 서버 답보다 먼저 출발) → 둘째 줄이 다시 안 선다
//   S3 먼저 출발한 폴링이 맨 나중에 도착한다 → 새 답을 덮지 않는다(붙든 것을 놓은 뒤에도)
//   S4 서버가 거절하면 줄이 돌아온다
//   S5 붙든 것을 놓은 뒤엔 서버가 정본이다 — 다른 자리에서 되돌린 줄은 다음 읽기에 다시 선다(붙든 것이 영영 가리지 않는다)
//  T. 휴지통 표식을 목록 재료에 비추기(v2/trash-hold — 순수)
//   T1 표식은 그 세션의 어느 이름(박스 id · 대화 uuid · 접힌 옛 박스 id)으로든 붙는다 · 이름이 안 맞는 세션엔 안 붙는다
//   T2 이미 표식이 있는 세션(서버가 먼저 말했다)은 덮지 않는다
//   T3 떼기는 내가 붙인 표식만 — 서버가 붙인 표식 · 다른 쓰기의 표식은 그대로
//   T4 서버가 이름 일부만 받았다 — 건너뛴 이름으로만 붙었던 세션은 떼고 다시 덧씌우면 풀리고, 받은 이름의 세션은 남는다
//   T5 받아 둔 답에 표식 — 라이브 행은 id 또는 대화 uuid 로, 기록 행은 session_id 로 · 이미 있는 표식 · 무관한 행은 그대로
//   T6 닫을 창 — 그 세션의 모든 이름으로 · 서버의 표식이 먼저 붙은 세션도 이름으로 고른다 · 표식 없는 세션은 안 닫는다
//   T7 받은 이름이 하나도 없으면(빈 집합) 표식도 닫을 창도 없다(새로 들인 got 이 빈 경우)
//  D. 배선
//   W1 loadData 는 출발 번호를 받고, 세 축(인스턴스 두 자리 · 라이브 · 기록)을 take 로 묻고 적는다
//   W2 인스턴스 · 치움을 take 없이 적는 줄이 없다 · 치움은 그 판과 한 왕복에 온 것만 쓴다
//   W3 × (치우기)는 서버에 보내기 전에 붙들고, 답을 받으면 ack, 실패하면 fail 하고 되돌린다
//   W3′ 옛 치움 맵을 옮긴 것도 붙든다(옮기는 동안 떠 있던 읽기가 되세우지 않게)
//   W4 loadData 가 세션을 합친 뒤 붙든 휴지통 표식을 덧씌운다
//   W5 휴지통 보내기를 셸이 지켜본다 — 두 축에 붙들고, ack 때 받아 둔 답(라이브 · 기록)에 표식을 적고 그 세션의 창을 닫는다, fail 때 표식을 뗀다
//   W5′ 되돌리기 · 완전 삭제 · 비우기가 끝나면 다음 기록 읽기를 깊게 받는다(얕은 판 밖 줄의 옛 표식)
//   W6 열린 창이 줄을 세울 때 휴지통에 있는 세션은 «없는 대상» 이다
//   W7 sessionTrashOp 은 지켜보는 쪽을 부른다 — 보내기는 받은 것이 있으면 ack(받은 이름), 없거나 던지면 fail · 그 밖의 조작은 답이 오면 ack
//   W8 치운 세션 id 는 그 판의 배열에 묶어 돌려준다 — 서버가 실어 보낸 판에서만
//   W9 한 줄의 창 닫기는 키 여럿을 받는다(세션의 이름이 여럿이다) · 보던 창은 맨 나중에
//
// fail-first(2026-10-04, 종료코드 확인):
//  · 고치기 전 main.ts · session-actions.ts · app-instance.ts(MAIN_SRC · ACTIONS_SRC · INST_SRC 로 origin/main 판을 물림) → W1~W9 열한 건 빨강.
//  · lib 변이 아홉(WRITE_HOLD_SRC) 전부 빨강 — 순서 검사 제거(O3 · H11 · S3) · ack 전에 출발한 읽기도 놓음(H3 · H9 · S1′) ·
//    ack 없이도 놓음(H2 · H7 · H11 · S1 · S2) · 한 축만으로 놓음(H5 · H6) · fail 이 안 놓음(H7 · S4) · 같은 판 재질문 거절(O4) ·
//    두 번째 ack 가 번호를 밂(H8) · 축 없는 쓰기를 안 놓음(H10) · 버려진 옛 답이 놓음(O3 · H11 · S3).
//  · 표식 변이 여덟(TRASH_HOLD_SRC) 전부 빨강 — 옛 박스 id 를 안 봄(T1) · 대화 uuid 를 안 봄(T1 · T6) · 있던 표식을 덮음(T2) · 남의 표식까지 뗌(T3 · T4) ·
//    라이브 행을 id 로만(T5) · 기록 행의 있던 표식을 덮음(T5) · 표식 없는 세션의 창도 닫음(T6) · 창을 id 하나로만(T6).
//  · 리뷰 전 배선도 빨강 — 닫을 창을 내 표식 값으로 고름(W5: 서버 답보다 먼저 온 읽기가 서버 표식을 실어 오면 창이 안 닫힌다) ·
//    되돌리기 뒤 깊은 판을 안 받음(W5′).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "write-hold-"));
const LIB = process.env.WRITE_HOLD_SRC || path.join(root, "web/lib/write-hold.ts");
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [LIB, "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { createWriteHolds } = await import(path.join(out, path.basename(LIB).replace(/\.ts$/, ".js")));

let pass = 0, fail = 0;
const ok = (cond, n, why = "기대와 다르다") => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${why}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ───────────────────────── A. 읽기 순서
{
  const w = createWriteHolds();
  const a = w.readStart(), b = w.readStart(), c = w.readStart();
  ok(a < b && b < c, "O1 출발 번호는 부를 때마다 커진다", `${a} ${b} ${c}`);
}
{
  const w = createWriteHolds();
  const a = w.readStart();
  ok(w.take("live", a) === true, "O2 처음 도착한 답은 적는다");
}
{
  const w = createWriteHolds();
  const old = w.readStart(), fresh = w.readStart();
  const t1 = w.take("live", fresh), t2 = w.take("live", old), t3 = w.take("logs", old);
  ok(t1 === true && t2 === false && t3 === true, "O3 먼저 출발한 읽기가 나중에 도착하면 그 축엔 안 적는다 — 다른 축은 적는다", `${t1} ${t2} ${t3}`);
}
{
  const w = createWriteHolds();
  const a = w.readStart();
  ok(w.take("instances", a) === true && w.take("instances", a) === true, "O4 같은 판을 두 번 물으면 둘 다 적는다");
}

// ───────────────────────── B. 붙들기
{
  const w = createWriteHolds();
  w.hold("x", ["instances"]); w.hold("y", ["instances"]);
  ok(same(w.values(), ["x", "y"]), "H1 붙들면 곧바로 values() 에 있다 · 붙든 순서대로", JSON.stringify(w.values()));
}
{
  const w = createWriteHolds();
  w.hold("x", ["instances"]);
  for (let i = 0; i < 4; i++) w.take("instances", w.readStart());
  ok(same(w.values(), ["x"]), "H2 서버 답(ack) 전에는 어떤 읽기도 못 놓는다", JSON.stringify(w.values()));
}
{
  const w = createWriteHolds();
  const h = w.hold("x", ["instances"]);
  const before = w.readStart();
  h.ack();
  w.take("instances", before);
  ok(same(w.values(), ["x"]), "H3 ack 전에 출발한 읽기는 ack 뒤에 도착해도 못 놓는다", JSON.stringify(w.values()));
}
{
  const w = createWriteHolds();
  const h = w.hold("x", ["instances"]);
  h.ack();
  const after = w.readStart();      // 경계 — ack 바로 다음 번호
  const held0 = w.values().length;
  w.take("instances", after);
  ok(held0 === 1 && w.values().length === 0, "H4 ack 뒤에 출발한 읽기가 그 축을 적으면 놓는다", JSON.stringify(w.values()));
}
{
  const w = createWriteHolds();
  const h = w.hold("t", ["live", "logs"]);
  h.ack();
  const r1 = w.readStart();
  w.take("live", r1);
  const afterOne = w.values().length;
  w.take("live", w.readStart());   // 같은 축만 또 와도 못 놓는다
  const afterSame = w.values().length;
  w.take("logs", w.readStart());   // 다른 판이 남은 축을 채운다
  ok(afterOne === 1 && afterSame === 1 && w.values().length === 0, "H5 축이 둘이면 둘 다 새 답으로 적혀야 놓는다 — 서로 다른 판이 채워도 된다", `${afterOne} ${afterSame} ${w.values().length}`);
}
{
  const w = createWriteHolds();
  const h = w.hold("t", ["live", "logs"]);
  h.ack();
  const r = w.readStart();
  w.take("live", r);               // 기록 요청은 실패했다(take 안 부름)
  w.take("instances", r);          // 걸리지 않은 축
  ok(same(w.values(), ["t"]), "H6 그 축을 못 적은 판은 못 놓는다", JSON.stringify(w.values()));
}
{
  const w = createWriteHolds();
  const h = w.hold("x", ["instances"]), k = w.hold("y", ["instances"]);
  h.fail();
  const gone = same(w.values(), ["y"]);
  h.ack();                          // 이미 놓았다 — 아무 일도 없다
  w.take("instances", w.readStart());
  ok(gone && same(w.values(), ["y"]), "H7 fail 은 곧바로 놓는다 · 그 뒤의 ack 는 아무 일도 안 한다", JSON.stringify(w.values()));
  k.fail();
}
{
  const w = createWriteHolds();
  const h = w.hold("x", ["instances"]);
  h.ack();
  const mid = w.readStart();
  h.ack();                          // 두 번째 ack 가 번호를 뒤로 밀면 mid 가 «ack 전 읽기» 가 돼 못 놓는다
  w.take("instances", mid);
  ok(w.values().length === 0, "H8 ack 를 두 번 불러도 처음 것만 센다", JSON.stringify(w.values()));
}
{
  const w = createWriteHolds();
  const a = w.hold("a", ["instances"]), b = w.hold("b", ["instances"]);
  a.ack();
  const r = w.readStart();          // a 의 답 뒤 · b 의 답 앞에 출발
  b.ack();
  w.take("instances", r);
  ok(same(w.values(), ["b"]), "H9 붙든 것이 여럿이면 따로 놓인다(먼저 답받은 것만)", JSON.stringify(w.values()));
}
{
  const w = createWriteHolds();
  const h = w.hold("x", []);
  const before = w.values().length;
  h.ack();
  ok(before === 1 && w.values().length === 0, "H10 걸린 축이 없는 쓰기는 ack 때 놓인다");
}
{
  const w = createWriteHolds();
  const stale = w.readStart();
  const h = w.hold("x", ["instances"]);
  h.ack();
  const fresh = w.readStart();
  const h2 = w.hold("y", ["instances"]);
  w.take("instances", fresh);       // x 를 놓는다
  h2.ack();
  const t = w.take("instances", stale);
  ok(t === false && same(w.values(), ["y"]), "H11 버려진 옛 답은 아무것도 못 놓는다", `${t} ${JSON.stringify(w.values())}`);
}
{
  const w = createWriteHolds();
  const empty = same(w.values(), []);
  const r = w.readStart();
  ok(empty && w.take("live", r) === true && same(w.values(), []), "H12 붙든 것이 없으면 values() 는 빈 배열 · take 는 그대로 돈다");
}

// ───────────────────────── C. 실측한 경합을 작은 모형으로
//  서버: 치운 줄의 집합. 읽기: 출발할 때의 서버 값을 들고 온다(도착은 부르는 쪽이 정한다). 화면: 마지막에 적힌 답 − 붙든 것.
function model() {
  const w = createWriteHolds();
  const server = new Set();           // 서버가 받은 치움
  let shown = new Set();              // 마지막에 적힌 답(치워진 줄)
  const rows = ["A", "B"];
  const screen = () => rows.filter((r) => !shown.has(r) && !w.values().includes(r)).join("");
  const read = () => { const seq = w.readStart(), snap = new Set(server); return { land: () => { if (w.take("instances", seq)) shown = snap; return screen(); } }; };
  const dismiss = (r) => { const h = w.hold(r, ["instances"]); return { screen: screen(), commit: () => { server.add(r); }, ack: () => h.ack(), fail: () => h.fail() }; };
  return { read, dismiss, screen, server };
}
{
  const m = model();
  const poll = m.read();                       // 8초 폴링이 출발
  const d = m.dismiss("A");                    // 그 직후에 ×
  const s0 = d.screen;
  const s1 = poll.land();                      // 치우기 전 사실이 도착
  d.commit(); d.ack();
  const s2 = m.read().land();                  // 답 뒤에 출발한 읽기
  ok(s0 === "B" && s1 === "B" && s2 === "B", "S1 폴링이 출발한 직후에 치워도 그 답이 줄을 되세우지 않는다", `${s0} ${s1} ${s2}`);
}
{
  const m = model();
  const poll = m.read();                       // 폴링이 출발(느린 응답)
  const d = m.dismiss("A"); d.commit(); d.ack();
  const s1 = poll.land();                      // 서버 답 **뒤에** 도착하지만 출발은 그 전 — 치우기 전 사실이다
  const s2 = m.read().land();
  ok(s1 === "B" && s2 === "B", "S1′ 치우기 전에 출발한 답이 서버 답 뒤에 도착해도 줄을 되세우지 않는다", `${s1} ${s2}`);
}
{
  const m = model();
  const d1 = m.dismiss("A"); d1.commit(); d1.ack();
  const r1 = m.read();                         // 첫째의 다시 읽기(둘째를 모르는 채 출발)
  const d2 = m.dismiss("B");
  const s1 = r1.land();                        // 둘째의 서버 답 전에 도착 — A 만 치워진 사실
  d2.commit(); d2.ack();
  const s2 = m.read().land();
  ok(d2.screen === "" && s1 === "" && s2 === "", "S2 연달아 둘을 치우면 둘째 줄이 다시 서지 않는다", `[${d2.screen}] [${s1}] [${s2}]`);
}
{
  const m = model();
  const slow = m.read();                       // 먼저 출발한 폴링(느린 응답)
  const d = m.dismiss("A"); d.commit(); d.ack();
  const s1 = m.read().land();                  // 답 뒤에 출발한 읽기가 먼저 도착 — 붙든 것을 놓는다
  const s2 = slow.land();                      // 옛 답이 맨 나중에 도착
  ok(s1 === "B" && s2 === "B", "S3 먼저 출발한 폴링이 맨 나중에 도착해도 새 답을 덮지 않는다", `${s1} ${s2}`);
}
{
  const m = model();
  const d = m.dismiss("A");
  d.fail();
  ok(d.screen === "B" && m.screen() === "AB" && m.read().land() === "AB", "S4 서버가 거절하면 줄이 돌아온다", `${d.screen} ${m.screen()}`);
}
{
  const m = model();
  const d = m.dismiss("A"); d.commit(); d.ack();
  const s1 = m.read().land();                  // 놓는다
  m.server.delete("A");                        // 다른 기기에서 되돌렸다
  const s2 = m.read().land();
  ok(s1 === "B" && s2 === "AB", "S5 붙든 것을 놓은 뒤엔 서버가 정본이다 — 되돌린 줄은 다시 선다", `${s1} ${s2}`);
}

// ───────────────────────── T. 휴지통 표식(v2/trash-hold)
{
  const TH = process.env.TRASH_HOLD_SRC || path.join(root, "web/v2/trash-hold.ts");
  execFileSync(path.join(root, "node_modules/.bin/tsc"), [TH, "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"], { stdio: "inherit" });
  const { markTrashed, unmarkTrashed, stampTrashedRows, trashedTabKeys } = await import(path.join(out, path.basename(TH).replace(/\.ts$/, ".js")));
  const AT = "2026-10-04T12:00:00.000Z", SRV = "2026-10-04T11:59:59.500Z";
  const mk = () => [
    { id: "box-a", logId: "uuid-a", altIds: ["box-a-old"] },
    { id: "uuid-b" },                              // 기록만 남은 세션
    { id: "box-c", logId: "uuid-c" },
    { id: "box-d", trashedAt: SRV },               // 서버가 먼저 표식을 줬다
  ];
  const marks = (ss) => ss.map((x) => x.trashedAt || "-").join(" ");
  {
    const byId = mk(), byLog = mk(), byAlt = mk();
    markTrashed(byId, new Set(["box-a"]), AT); markTrashed(byLog, new Set(["uuid-a"]), AT); markTrashed(byAlt, new Set(["box-a-old"]), AT);
    const one = `${AT} - - ${SRV}`;
    ok(marks(byId) === one && marks(byLog) === one && marks(byAlt) === one, "T1 표식은 그 세션의 어느 이름으로든 붙는다 · 이름이 안 맞는 세션엔 안 붙는다", [marks(byId), marks(byLog), marks(byAlt)].join(" | "));
  }
  {
    const ss = mk();
    markTrashed(ss, new Set(["box-d", "uuid-b"]), AT);
    ok(ss[3].trashedAt === SRV && ss[1].trashedAt === AT, "T2 이미 표식이 있는 세션은 덮지 않는다", marks(ss));
  }
  {
    const ss = mk(), OTHER = "2026-10-04T12:00:01.000Z";
    markTrashed(ss, new Set(["box-a"]), AT); markTrashed(ss, new Set(["box-c"]), OTHER);
    unmarkTrashed(ss, AT);
    ok(marks(ss) === `- - ${OTHER} ${SRV}`, "T3 떼기는 내가 붙인 표식만 — 서버 · 다른 쓰기의 표식은 그대로", marks(ss));
  }
  {
    const ss = mk();
    markTrashed(ss, new Set(["box-a", "uuid-a", "uuid-b"]), AT);          // 보낸 이름 셋
    const before = marks(ss);
    unmarkTrashed(ss, AT); markTrashed(ss, new Set(["box-a"]), AT);      // 서버는 box-a 만 받았다
    ok(before === `${AT} ${AT} - ${SRV}` && marks(ss) === `${AT} - - ${SRV}`, "T4 서버가 이름 일부만 받으면 건너뛴 이름의 세션은 풀리고 받은 이름의 세션은 남는다", `${before} → ${marks(ss)}`);
  }
  {
    const live = [{ id: "box-a", claudeSessionId: "uuid-a" }, { id: "box-c", claudeSessionId: "uuid-c" }, { id: "box-d", trashedAt: SRV }, { id: "box-e" }];
    const logs = [{ session_id: "uuid-a" }, { session_id: "uuid-b" }, { session_id: "uuid-c", trashed_at: SRV }, { session_id: "uuid-z" }];
    stampTrashedRows(live, logs, new Set(["box-a", "uuid-c", "uuid-b", "box-d"]), AT);
    ok(live.map((r) => r.trashedAt || "-").join(" ") === `${AT} ${AT} ${SRV} -` && logs.map((r) => r.trashed_at || "-").join(" ") === `- ${AT} ${SRV} -`,
      "T5 받아 둔 답에 표식 — 라이브는 id 또는 대화 uuid · 기록은 session_id · 있던 표식과 무관한 행은 그대로",
      live.map((r) => r.trashedAt || "-").join(" ") + " | " + logs.map((r) => r.trashed_at || "-").join(" "));
  }
  {
    const ss = mk();
    markTrashed(ss, new Set(["uuid-a"]), AT);
    const keys = trashedTabKeys(ss, new Set(["uuid-a", "box-d", "box-c"])).sort();   // box-c 는 이름은 맞지만 표식이 없다
    ok(same(keys, ["sess:box-a", "sess:box-a-old", "sess:box-d", "sess:uuid-a"]), "T6 닫을 창 — 그 세션의 모든 이름으로 · 서버 표식이 붙은 세션도 이름으로 고른다 · 표식 없는 세션은 안 닫는다", JSON.stringify(keys));
  }
  {
    const ss = mk(), live = [{ id: "box-a" }], logs = [{ session_id: "uuid-b" }];
    markTrashed(ss, new Set(), AT); stampTrashedRows(live, logs, new Set(), AT);
    ok(marks(ss) === `- - - ${SRV}` && !live[0].trashedAt && !logs[0].trashed_at && same(trashedTabKeys(ss, new Set()), []), "T7 받은 이름이 없으면 표식도 닫을 창도 없다", marks(ss));
  }
}

// ───────────────────────── D. 배선(소스 — 주석을 걷고 본다: 설명 주석의 낱말이 거짓 초록을 만든다)
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s+\/\/ [^\n]*$/gm, "");
const read = (p, env) => code(readFileSync(process.env[env] || path.join(root, p), "utf8"));
const MAIN = read("web/v2/main.ts", "MAIN_SRC");
const ACT = read("web/session-actions.ts", "ACTIONS_SRC");
const INST = read("web/v2/app-instance.ts", "INST_SRC");
const cut = (src, from, to) => { const a = src.indexOf(from); if (a < 0) return ""; const b = src.indexOf(to, a + from.length); return b > a ? src.slice(a, b) : ""; };

const LOAD = cut(MAIN, "async function loadData(", "\nconst findSess");
ok(/const seq = sideWrites\.readStart\(\);/.test(LOAD)
  && /if \(!takeInstances\(rows, seq\)\) return;/.test(LOAD) && /takeInstances\(insts0, seq\)/.test(LOAD)
  && /if \(sideWrites\.take\('live', seq\)\) lastLive = /.test(LOAD)
  && /if \(sideWrites\.take\('logs', seq\)\) \{\s*if \(wantDeepLogs\) \{ lastLogs = logs[^\n]*\}\s*else lastLogs = mergeLogRows\(lastLogs, logs/.test(LOAD),
  "W1 loadData 는 출발 번호를 받고 세 축을 take 로 묻고 적는다");
const TAKE = cut(MAIN, "function takeInstances(", "\nfunction overlayDismissHolds");
ok((MAIN.match(/appInstances = (rows|insts0)\b/g) || []).length === 1 && /if \(!sideWrites\.take\('instances', seq\)\) return false;\s*appInstances = rows;/.test(TAKE)
  && !/dismissedSessionRefs/.test(MAIN) && /const gone = dismissedRefsOf\(rows\);\s*if \(gone\) dismissedSess = new Set\(gone\);\s*overlayDismissHolds\(\);/.test(TAKE)
  && (MAIN.match(/dismissedSess = new Set\(/g) || []).length === 1,
  "W2 인스턴스 · 치움을 take 없이 적는 줄이 없다 · 치움은 그 판과 한 왕복에 온 것만 쓴다");
const DIS = cut(MAIN, "async function dismissSessionRow(", "\nfunction closeRowTabs");
const holdAt = DIS.indexOf("const hold = sideWrites.hold({ kind: 'dismiss', ids, at: '' }, ['instances']);");
const sendAt = DIS.indexOf("await dismissSessions(ids); hold.ack();");
const failAt = DIS.indexOf("hold.fail();");
ok(holdAt > 0 && sendAt > holdAt && failAt > sendAt && /overlayDismissHolds\(\);\s*closeRowTabs\(key\);\s*drawSide\(\);/.test(DIS.slice(holdAt, sendAt))
  && /for \(const x of ids\) dismissedSess\.delete\(x\);/.test(DIS.slice(failAt)),
  "W3 × 는 보내기 전에 붙들고, 답을 받으면 ack, 실패하면 fail 하고 되돌린다");
ok(/sideWrites\.hold\(\{ kind: 'dismiss', ids: plan\.sessionIds, at: '' \}, \['instances'\]\)\.ack\(\);/.test(cut(MAIN, "async function migrateSessionDismissals(", "\nfunction dismissKey")),
  "W3′ 옛 치움 맵을 옮긴 것도 붙든다");
ok(/const sessions = mergeSessions\(lastLive, lastLogs\);[\s\S]{0,200}overlayTrashHolds\(sessions\);/.test(LOAD),
  "W4 loadData 가 세션을 합친 뒤 붙든 휴지통 표식을 덧씌운다");
const WATCH = cut(MAIN, "watchSessionTrash((op, ids) => {", "\nasync function loadData(");
const ackAt = WATCH.indexOf("hold.ack();");
ok(/sideWrites\.hold\(w, \['live', 'logs'\]\)/.test(WATCH) && ackAt > 0
  && /unmarkTrashed\(data\.sessions, w\.at\);\s*w\.ids = \[\.\.\.got\];\s*overlayTrashHolds\(data\.sessions\);\s*stampTrashedRows\(lastLive, lastLogs, got, w\.at\);/.test(WATCH.slice(0, ackAt))
  && /closeRowTabs\(trashedTabKeys\(data\.sessions, got\)\)/.test(WATCH.slice(ackAt))
  && /fail: \(\) => \{ hold\.fail\(\); unmarkTrashed\(data\.sessions, w\.at\);/.test(WATCH)
  && /markTrashed\(sessions, new Set\(w\.ids\), w\.at\)/.test(cut(MAIN, "function overlayTrashHolds(", "\nfunction ")),
  "W5 휴지통 보내기를 셸이 지켜본다 — 두 축에 붙들고, ack 때 받아 둔 답에 표식을 적고 창을 닫고, fail 때 표식을 뗀다");
ok(/if \(op !== 'trash'\) return \{ ack: \(\) => \{ logsDeepAt = 0; \}/.test(WATCH),
  "W5′ 되돌리기 · 완전 삭제 · 비우기가 끝나면 다음 기록 읽기를 깊게 받는다");
ok(/if \(k\.startsWith\('s:'\)\) \{ const s = findSess\(k\.slice\(2\)\); return !sessTruthSeen \|\| \(!!s && !isTrashedSess\(s\)\); \}/.test(cut(MAIN, "function tabTargetAlive(", "\nfunction homeVisFacts")),
  "W6 열린 창이 줄을 세울 때 휴지통에 있는 세션은 없는 대상이다");
const OP = cut(ACT, "export async function sessionTrashOp(", "\nexport const sessionNames");
ok(/const held = trashWatch && \(op !== 'trash' \|\| ids\.length\) \? trashWatch\(op, ids\) : null;/.test(OP)
  && /catch \(e\) \{ if \(held\) held\.fail\(\); throw e; \}/.test(OP)
  && /if \(held\) \{ if \(out\.done\.length \|\| op !== 'trash'\) held\.ack\(out\.done\); else held\.fail\(\); \}/.test(OP)
  && /export function watchSessionTrash\(/.test(OP),
  "W7 sessionTrashOp 은 지켜보는 쪽을 부른다 — 보내기는 받은 것이 있으면 ack, 없거나 던지면 fail · 그 밖은 답이 오면 ack");
ok(/if \(Array\.isArray\(out\?\.dismissed_sessions\)\) dismissedOf\.set\(rows, /.test(INST) && /export function dismissedRefsOf\(rows: AppInstanceRecord\[\]\): string\[\] \| null/.test(INST),
  "W8 치운 세션 id 는 그 판의 배열에 묶어 돌려준다 — 서버가 실어 보낸 판에서만");
const CRT = cut(MAIN, "function closeRowTabs(", "\nfunction refreshSideNow");
ok(/function closeRowTabs\(key: string \| string\[\]\)/.test(CRT) && /keys\.has\(sideRowKey\(t\.route\)\)/.test(CRT) && /Number\(a === cur\)\s*-\s*Number\(b === cur\)/.test(CRT),
  "W9 한 줄의 창 닫기는 키 여럿을 받는다 · 보던 창은 맨 나중에");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
