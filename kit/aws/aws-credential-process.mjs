#!/usr/bin/env node
// AWS credential_process 헬퍼(#746 커넥터 파도2) — 멤버 세션의 aws cli/SDK/terraform 이 게이트웨이에서
//  단기 AWS 자격을 받는다. 게이트웨이가 조직 IAM role 을 '나' 귀속(RoleSessionName)으로 가정해 15분 자격 발급.
//
// 설치·사용 (~/.aws/config):
//   [profile lively]
//   credential_process = node <경로>/aws-credential-process.mjs [scope_key]
//   그리고: aws --profile lively sts get-caller-identity  /  AWS_PROFILE=lively terraform plan
//
// 계약: AWS 는 이 명령의 stdout 에서 {"Version":1,"AccessKeyId":...,"SecretAccessKey":...,"SessionToken":...,"Expiration":...}
//  JSON 만 읽는다. 그래서 성공 시 credential_process_json 을 그대로 출력하고, 그 외 진단은 전부 stderr 로만 낸다.
//  자격(LIVELY_TOKEN)은 env 또는 ~/.lively/token 에서 읽고 절대 stdout/인자로 노출하지 않는다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entrypointHostEffects } from "../setup/host-effects.mjs";

const hostEffects = entrypointHostEffects();
const fetch = (...args) => hostEffects.fetch(...args);

const scopeKey = (process.argv[2] || "").trim(); // 선택: 여러 role 등록 시 대상 구분
const HOME = process.env.LIVELY_HOME || os.homedir();
const readLocal = (rel) => { try { return fs.readFileSync(path.join(HOME, ".lively", rel), "utf8").trim() || null; } catch { return null; } };
const token = (process.env.LIVELY_TOKEN || "").trim() || readLocal("token");
let base = (process.env.LIVELY_GATEWAY_URL || "").trim() || readLocal("gateway-url") || "http://localhost:8080";
base = base.replace(/\/+$/, "");

const die = (msg) => { process.stderr.write(`aws-credential-process: ${msg}\n`); process.exit(1); };
if (!token) die("LIVELY_TOKEN 미설정(또는 ~/.lively/token 없음) — 게이트웨이 인증 불가");

const ctl = new AbortController();
const timer = setTimeout(() => ctl.abort(), 12000); // AssumeRole + 왕복 여유
try {
  const res = await fetch(`${base}/api/ui/me/aws-credentials`, {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify(scopeKey ? { scope_key: scopeKey } : {}),
    signal: ctl.signal,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch { /* 평문 그대로 */ }
    die(`게이트웨이 ${res.status} — ${String(msg).slice(0, 300)}`);
  }
  let j;
  try { j = JSON.parse(text); } catch { die("게이트웨이 응답 파싱 실패"); }
  const cp = j.credential_process_json;
  if (!cp) die("응답에 credential_process_json 없음");
  // AWS 계약: stdout 은 credential_process JSON '만'. 검증 후 그대로 출력(개행 없이도 되나 관례상 추가).
  process.stdout.write(typeof cp === "string" ? cp : JSON.stringify(cp));
  process.stdout.write("\n");
} catch (e) {
  die(e && e.name === "AbortError" ? "게이트웨이 타임아웃" : `요청 실패: ${e && e.message ? e.message : e}`);
} finally {
  clearTimeout(timer);
}
