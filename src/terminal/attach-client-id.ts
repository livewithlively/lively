// attach 클라이언트 **지문** (#3521) — 「누가 8~25초마다 붙나」를 로그 한 줄로 귀속시키는 축.
//
// 계기(실측 2026-09-04, 매니지드 gw-central): 아무도 안 여는 세션 하나에 attach 가 14회, 6~8초 간격으로
//  반복됐다. #2625 가 넣은 `ws attach 허가` 의 클라이언트 축은 `ua` 하나뿐이었고 그게 **빈 문자열**이다.
//  체인 어디서도 UA 가 지워지지 않는 것까지 확인했으므로(Caddy 는 헤더를 통과시키고, 라우터
//  `proxyUpgrade` 는 rawHeaders 를 그대로 되쓴다) «브라우저가 아니다» 까지는 근거가 있다. 그런데
//  코어·클라우드 어느 레포에도 `/terminal/ws` 를 여는 Node 클라이언트가 **없다** — 그래서 «무엇인가» 는
//  코드를 읽어서는 답이 안 나온다. 관측으로만 닫힌다.
//
// ★ 설계의 핵심은 «값을 싣지 않는다» 이다. 귀속에 필요한 것은 **어떤 클라이언트 라이브러리인가** 이고
//  그건 헤더 이름의 구성·순서가 답한다. 값에는 티켓 쿠키·Authorization 이 들어 있고 이 로그는 진단용이라
//  오래 남는다 — 로그는 새는 표면이다. 그래서 헤더도 쿠키도 **이름만** 남긴다.

/** 지문을 뽑는 데 필요한 최소 모양 — `http.IncomingMessage` 가 구조적으로 만족한다.
 *  시험이 평범한 객체를 넘길 수 있도록 전부 선택적이다(그 자체가 엣지 ⑨ 이기도 하다). */
export type FingerprintInput = {
  rawHeaders?: string[];
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null; remotePort?: number | null } | null;
};

export type ClientFingerprint = {
  /** 소켓 대향 끝 `addr:port`. 라우터 경유면 **라우터**가 찍힌다 — 그래도 «어느 홉에서 왔나» 를 가른다. */
  remote: string;
  /** 엣지가 적어 준 원 클라이언트(XFF 첫 홉). 내부 직결이면 빈 문자열. */
  xff: string;
  ua: string;
  /** 브라우저는 반드시 보낸다 — UA 와 **독립된** 두 번째 «브라우저인가» 축. */
  origin: string;
  /** 헤더 **이름만**, 받은 순서대로. 상한 초과면 끝에 `…`. */
  hdrs: string;
  /** 쿠키 **이름만**. */
  ck: string;
};

const UA_MAX = 80;      // 종전 `ua` 축과 같은 상한 — 로그 폭 유지
const HDRS_MAX = 400;   // 헤더는 클라이언트가 마음대로 넣는다 → 한 줄이 로그를 밀어내지 못하게
const CK_MAX = 200;

/** 상한을 넘으면 자르고 **잘렸다는 표시**를 남긴다 — 자른 것과 원래 짧은 것이 구별되어야 한다. */
function cap(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
}

/** 업그레이드 요청 하나에서 클라이언트 지문을 뽑는다 — **순수**하고, **절대 던지지 않는다**.
 *  던지면 로그 한 줄 때문에 attach 가 죽는다(진단 장치가 진단 대상을 망가뜨리는 자리). */
export function clientFingerprint(req: FingerprintInput): ClientFingerprint {
  const h = req.headers ?? {};

  // 헤더 이름 — rawHeaders 의 짝수 인덱스가 이름이다. 순서가 곧 지문이므로 정렬하지 않는다.
  //  rawHeaders 가 없으면(시험·중계) headers 키로 대신한다 — 순서 정보는 잃지만 침묵하진 않는다.
  const raw = req.rawHeaders;
  const names = raw && raw.length
    ? raw.filter((_, i) => i % 2 === 0).map((n) => String(n).toLowerCase())
    : Object.keys(h).map((n) => n.toLowerCase());

  // 쿠키 **이름만** — `a=1; b=2` 에서 `=` 앞만 취한다. 값은 자격증명이다.
  const cookieNames = first(h.cookie)
    .split(";")
    .map((p) => p.split("=")[0].trim())
    .filter(Boolean);

  const addr = req.socket?.remoteAddress ?? "";
  const port = req.socket?.remotePort;

  return {
    remote: addr ? (port ? `${addr}:${port}` : String(addr)) : "",
    // XFF 는 `client, proxy1, proxy2` 순이라 **첫 홉**이 원 클라이언트다.
    xff: first(h["x-forwarded-for"]).split(",")[0].trim(),
    ua: cap(first(h["user-agent"]), UA_MAX),
    origin: cap(first(h.origin), UA_MAX),
    hdrs: cap(names.join(","), HDRS_MAX),
    ck: cap(cookieNames.join(","), CK_MAX),
  };
}
