// attach 클라이언트 지문(#3521)의 계약 — 사양: 스크래치패드 spec.md 의 엣지 표 14행.
//
// 이 축이 있는 이유: `ws attach 허가` 의 클라이언트 축이 `ua` 하나였고 그게 빈 문자열이라
//  «브라우저가 아니다» 에서 멈췄다. 지문은 그 다음 한 걸음(«무엇인가»)을 위한 것이다.
//
// ★ 단언의 무게중심은 «값이 새지 않는다» 에 있다. 지문은 쓸모 있으려면 풍부해야 하는데,
//  풍부해질수록 자격증명을 흘릴 위험이 커진다. 그 둘을 가르는 선이 «이름만» 이다.
import { strict as assert } from "node:assert";
import { clientFingerprint } from "./attach-client-id.js";

// 실제 크롬 탭이 보내는 모양 — 순서까지 실물 그대로(Host 가 먼저).
const BROWSER = {
  rawHeaders: [
    "Host", "lively-46e3.app.lvly.io",
    "Connection", "Upgrade",
    "Pragma", "no-cache",
    "User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
    "Upgrade", "websocket",
    "Origin", "https://lively-46e3.app.lvly.io",
    "Sec-WebSocket-Version", "13",
    "Cookie", "lvly_sess=SECRET-SESSION; lvly_tty=SECRET-TICKET; theme=dark",
    "Sec-WebSocket-Key", "NOT-A-REAL-WS-KEY-BROWSER",
    "X-Forwarded-For", "203.0.113.9, 10.0.0.1",
  ],
  headers: {
    host: "lively-46e3.app.lvly.io",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
    origin: "https://lively-46e3.app.lvly.io",
    cookie: "lvly_sess=SECRET-SESSION; lvly_tty=SECRET-TICKET; theme=dark",
    "x-forwarded-for": "203.0.113.9, 10.0.0.1",
  },
  socket: { remoteAddress: "127.0.0.1", remotePort: 51234 },
};

// Node `ws` 패키지 기본값 — UA 도 Origin 도 없고, 헤더 순서가 브라우저와 다르다.
const NODE_WS = {
  rawHeaders: [
    "Sec-WebSocket-Version", "13",
    "Sec-WebSocket-Key", "NOT-A-REAL-WS-KEY-NODEWS",
    "Connection", "Upgrade",
    "Upgrade", "websocket",
    "Host", "lively-46e3.app.lvly.io",
    "Cookie", "lvly_tty=SECRET-TICKET",
  ],
  headers: { host: "lively-46e3.app.lvly.io", cookie: "lvly_tty=SECRET-TICKET" },
  socket: { remoteAddress: "10.0.5.7", remotePort: 44002 },
};

// ── ①② 헤더는 이름만·순서 그대로, 그리고 두 클라이언트를 **가른다** ──────────
//  순서를 남기는 이유: 헤더 집합이 같아도 순서가 라이브러리를 가른다. 위 둘이 그 대조군이다.
{
  const b = clientFingerprint(BROWSER);
  const n = clientFingerprint(NODE_WS);
  assert.equal(b.hdrs.split(",")[0], "host");
  assert.equal(n.hdrs.split(",")[0], "sec-websocket-version");
  assert.notEqual(b.hdrs, n.hdrs, "브라우저와 Node ws 가 같은 지문으로 접혔다 — 가르지 못한다");
  // 이름은 전부 남아야 한다(순서 보존 = 원본 순서 그대로의 목록).
  assert.equal(b.hdrs, "host,connection,pragma,user-agent,upgrade,origin,sec-websocket-version,cookie,sec-websocket-key,x-forwarded-for");
}

// ── ③ 값은 **한 글자도** 안 나간다 ───────────────────────────────────────────
{
  for (const [who, f] of [["브라우저", clientFingerprint(BROWSER)], ["node-ws", clientFingerprint(NODE_WS)]] as const) {
    const dump = JSON.stringify(f);
    for (const secret of ["SECRET-TICKET", "SECRET-SESSION", "NOT-A-REAL-WS-KEY"]) {
      assert.ok(!dump.includes(secret), `${who}: 헤더/쿠키 값이 샜다(${secret}): ${dump}`);
    }
  }
}

// ── ④⑤ 쿠키도 이름만 ────────────────────────────────────────────────────────
{
  assert.equal(clientFingerprint(BROWSER).ck, "lvly_sess,lvly_tty,theme");
  assert.equal(clientFingerprint(NODE_WS).ck, "lvly_tty");
  // 쿠키 헤더 부재 = 쿠키 0개와 같은 모양(둘 다 «이름 없음»이다).
  assert.equal(clientFingerprint({ rawHeaders: [], headers: {}, socket: null }).ck, "");
}

// ── ⑥⑦ XFF — 다중 홉에선 첫 홉(원 클라이언트), 없으면 지어내지 않는다 ────────
//  remote 만으로는 라우터 경유 시 라우터가 찍히고, xff 만으로는 내부 직결 시 빈다 → 둘 다 남긴다.
{
  assert.equal(clientFingerprint(BROWSER).xff, "203.0.113.9", "다중 홉 XFF 에서 원 클라이언트를 못 집었다");
  assert.equal(clientFingerprint(NODE_WS).xff, "", "XFF 가 없는데 무언가를 지어냈다");
}

// ── ⑧⑨⑩ 원격 주소 — 정상·부재·포트 없음 ────────────────────────────────────
//  ⑨ 는 이 헬퍼를 도입하며 **새로 생긴** 엣지다: 소켓이 이미 죽은 뒤에도 불릴 수 있는데,
//   여기서 던지면 로그 한 줄 때문에 attach 가 죽는다.
{
  assert.equal(clientFingerprint(BROWSER).remote, "127.0.0.1:51234");
  assert.equal(clientFingerprint(NODE_WS).remote, "10.0.5.7:44002");
  assert.equal(clientFingerprint({ rawHeaders: [], headers: {}, socket: null }).remote, "");
  assert.equal(clientFingerprint({}).remote, "", "인자가 비어도 던지지 않고 빈 지문을 준다");
  assert.equal(clientFingerprint({ socket: { remoteAddress: "1.2.3.4" } }).remote, "1.2.3.4",
    "포트가 없으면 매달린 콜론을 남기지 않는다");
}

// ── ⑪ 상한 — 로그 한 줄이 폭주하지 않는다 ───────────────────────────────────
//  헤더는 클라이언트가 마음대로 넣는다. 상한이 없으면 «로그를 채워 다른 줄을 밀어내는» 값싼 수단이 된다.
{
  const many: string[] = [];
  for (let i = 0; i < 200; i++) many.push(`X-Pad-${i}`, "v");
  const f = clientFingerprint({ rawHeaders: many, headers: {}, socket: null });
  assert.ok(f.hdrs.length <= 400, `헤더 지문이 상한을 넘었다: ${f.hdrs.length}`);
  assert.ok(f.hdrs.endsWith("…"), "잘렸다는 표시가 없다 — 자른 것과 원래 짧은 것이 구별되지 않는다");
  // 상한 이하는 자르지 않는다(표시도 없다).
  assert.ok(!clientFingerprint(BROWSER).hdrs.endsWith("…"), "짧은데 잘림 표시가 붙었다");
}

// ── ⑫ rawHeaders 부재 → headers 키로 대신(순서는 잃지만 침묵하지 않는다) ─────
{
  const f = clientFingerprint({ headers: { host: "h", cookie: "a=1" }, socket: null });
  assert.equal(f.hdrs, "host,cookie");
  assert.equal(f.ck, "a");
}

// ── ⑬⑭ UA·Origin — 부재는 빈 문자열, 긴 값은 상한에서 자른다 ────────────────
//  Origin 을 싣는 이유: 브라우저는 반드시 보내고 스크립트 클라는 보통 안 보낸다 —
//  UA 와 독립된 두 번째 «브라우저인가» 축이라, 하나가 없어도 다른 하나가 답한다.
{
  assert.ok(clientFingerprint(BROWSER).ua.startsWith("Mozilla/5.0"));
  assert.equal(clientFingerprint(BROWSER).origin, "https://lively-46e3.app.lvly.io");
  assert.equal(clientFingerprint(NODE_WS).ua, "");
  assert.equal(clientFingerprint(NODE_WS).origin, "");
  const long = clientFingerprint({ headers: { "user-agent": "U".repeat(500) } });
  assert.ok(long.ua.length <= 80, `UA 상한을 넘었다: ${long.ua.length}`);
  assert.ok(long.ua.endsWith("…"), "긴 UA 가 잘렸다는 표시가 없다");
}
