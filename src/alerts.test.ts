// 경보 알림 테스트 (#813).
//
//  회귀 대상:
//   ① **웹훅 URL 유출** — URL 자체가 시크릿이다(그 URL만 알면 누구나 그 채널에 글을 쓴다). 페이로드·에러메시지·
//      로그 어디에도 나오면 안 된다. redactDeep 은 URL 패턴을 안 잡으므로 여기서 막지 못하면 그대로 샌다.
//   ② **min_severity 게이트** — '위험만' 으로 설정했는데 경고까지 오면 사람이 채널을 음소거한다(늑대소년).
//   ③ **페이로드 호환** — 슬랙(text)·디스코드(content)를 한 페이로드로 커버해야 채널마다 코드가 갈리지 않는다.
import assert from "node:assert/strict";
import { shouldSend, alertPayload, webhookReason, ALERT_KIND, ALERT_SCOPE } from "./alerts.js";
import type { BoxAlert } from "./box-watch.js";

const alert = (severity: BoxAlert["severity"]): BoxAlert => ({
  severity,
  title: `제목-${severity}`,
  text: "본문",
  detail: { usedPct: 97 },
});

// ── min_severity 게이트 ──
{
  // 기본(warn): 경고도 알린다.
  assert.equal(shouldSend("warn", "warn"), true);
  assert.equal(shouldSend("critical", "warn"), true);

  // '위험만': 경고는 **보내지 않는다**(늑대소년 방지 — 사람이 음소거하면 진짜 장애를 놓친다).
  assert.equal(shouldSend("warn", "critical"), false, "위험만 설정인데 경고가 가면 안 된다");
  assert.equal(shouldSend("critical", "critical"), true, "위험은 어떤 설정에서도 간다");

  // 해제(ok)의 발송 여부는 여기서 정하지 않는다 — box-watch 가 '알린 문제'에만 해제를 보낸다.
  assert.equal(shouldSend("ok", "critical"), true);
}

// ── 페이로드: 슬랙 + 디스코드 + 범용을 한 번에 ──
{
  const p = alertPayload(alert("critical"));
  assert.equal(typeof p.text, "string", "슬랙 incoming webhook 은 text 를 읽는다");
  assert.equal(typeof p.content, "string", "디스코드는 content 를 읽는다");
  assert.equal(p.text, p.content, "같은 내용이어야 채널마다 다르게 보이지 않는다");
  assert.match(String(p.text), /제목-critical/);
  assert.match(String(p.text), /🔴/, "위험은 한눈에 구분되어야");
  assert.equal(p.severity, "critical");
  assert.deepEqual(p.detail, { usedPct: 97 }, "범용 웹훅용 구조화 필드");

  assert.match(String(alertPayload(alert("warn")).text), /🟡/);
  assert.match(String(alertPayload(alert("ok")).text), /🟢/);
}

// ── ⚠ URL 유출 금지: 페이로드 어디에도 웹훅 주소가 실려선 안 된다 ──
//  (페이로드는 그 웹훅으로 가는 것이니 URL 을 담을 이유가 없다. 담으면 로그·에러·미러링으로 새어나간다.)
{
  const p = alertPayload(alert("critical"));
  const flat = JSON.stringify(p);
  assert.ok(!/hooks\.slack\.com|discord\.com\/api\/webhooks|https?:\/\//.test(flat),
    `페이로드에 URL 이 들어있다 — 웹훅 주소는 시크릿이다: ${flat}`);
}

// ── 좌표 상수 — member_secret(owner=gateway) 에 org_credential 과 같은 테이블을 쓴다(스키마 변경 없음) ──
{
  assert.match(ALERT_KIND, /^[a-z0-9_]{1,40}$/, "member_secret kind 형식(소문자·숫자·_)을 지켜야 저장이 거부되지 않는다");
  assert.ok(ALERT_SCOPE.length > 0);
}

// ── 실패 사유는 '이 화면의 말'이어야 하고, **URL 을 되돌려주면 안 된다** ──
//  SSRF 가드는 MCP 프록시와 코드를 공유해 메시지가 그 맥락으로 쓰여 있다 — 웹훅 관리자에겐 무슨 소린지 모른다.
{
  const scheme = webhookReason("허용되지 않은 scheme: http: — 원격 MCP 는 https 전용(내부 http 는 allowed_internal_hosts 등록 필요)");
  assert.ok(!/MCP/.test(scheme), "'원격 MCP' 같은 남의 맥락 용어가 관리자에게 보이면 안 된다");
  assert.match(scheme, /https/, "무엇이 문제인지");
  assert.match(scheme, /내부 host/, "사내 주소는 어떻게 쓰는지");

  const priv = webhookReason("차단된 host(사설/메타데이터 IP): 10.0.0.5");
  assert.match(priv, /10\.0\.0\.5/, "어느 host 가 막혔는지는 알려줘야 고칠 수 있다");
  assert.match(priv, /허용 내부 host/, "어떻게 해결하는지");

  assert.match(webhookReason("게이트웨이 자기 자신 프록시 금지(confused-deputy): gw.example.com"), /자기 자신/);

  // ⚠ 알 수 없는 실패는 원문을 그대로 주지 않는다 — URL·토큰이 섞여 나올 여지를 남기지 않는다.
  const unknown = webhookReason("connect ETIMEDOUT https://hooks.slack.com/services/T0/B0/SUPERSECRET");
  assert.ok(!/SUPERSECRET/.test(unknown), "알 수 없는 에러의 원문을 그대로 주면 웹훅 토큰이 샌다");
  assert.ok(!/https?:\/\//.test(unknown), "실패 사유에 URL 이 들어가면 안 된다");
}

console.log("alerts.test.ts ok — min_severity 게이트 · 슬랙/디스코드 동시 호환 페이로드 · 웹훅 URL 미노출 · 실패사유 번역+무유출");
