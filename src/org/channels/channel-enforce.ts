// 채널별 개인 열람/발송 정책의 **집행 배선**(#1226 · #1262 · #1881) — 호출 경로가 둘이라 한 자리에 모았다.
//
//  왜 별도 모듈인가: 정책 집행은 원래 `mcp-proxy.callUpstream`(A 어댑터) 한 자리에만 있었다. 슬랙 도구 면을
//  Web API(http_proxy, B 어댑터)로 내리면서(#1881) 같은 정책이 `dynamic-tools.runHttpProxyTool` 에도 걸려야
//  한다 — 안 걸면 **A 에선 막히던 대화가 B 에선 그대로 열린다.** 두 자리가 각자 복사본을 들고 있으면 한쪽만
//  고쳐지는 날이 온다(그게 #1226 이 남긴 "우회로가 없는 유일한 자리" 원칙의 붕괴다). 그래서 사전 게이트와
//  사후 필터를 여기서 한 번 정의하고 두 경로가 같은 함수를 부른다.
//
//  순수 판정(channel-guard)·종류 해소(channel-resolver)는 그대로 두고, 이 파일은 그 둘을 **호출 순서대로 잇는
//  조율**만 한다. 규칙 자체는 여기 없다.
import { openChannelGate, type ChannelGate } from "./channel-resolver.js";
import {
  checkChannelCall, filterChannelContent, channelToolKind, extractChannelTargets, extractResponseTargets,
  type ChannelToolKind,
} from "./channel-guard.js";
import type { ChannelSystem } from "./channel-policy-store.js";
import { logger } from "../../log.js";

// 이 도구/프록시가 '대화 시스템'인가 — 집행 대상 판별. 서버·도구 이름은 운영자가 바꿀 수 있으므로
//  자격 종류(auth_kind)를 1차로, 상류 호스트를 2차로 본다(둘 중 하나만 맞아도 슬랙).
//  B 어댑터의 슬랙 도구는 auth_kind=slack_oauth + url 호스트 slack.com 이라 양쪽 다 걸린다.
export function channelSystemOf(server: { auth_kind?: string | null; url?: string | null }): ChannelSystem | null {
  if ((server.auth_kind ?? "").toLowerCase().startsWith("slack")) return "slack";
  try { if (server.url && /(^|\.)slack\.com$/i.test(new URL(server.url).hostname)) return "slack"; } catch { /* url 파싱 실패 = 판별 불가 */ }
  return null;
}

export interface ChannelEnforcement {
  gate: ChannelGate | null;      // null = 집행 대상 아님(대화 시스템이 아니거나 신원 없음, 또는 meta 도구)
  toolKind: ChannelToolKind;
  argTargets: Set<string>;       // 호출이 지목한 대화(좁은 축) — 응답 필터의 모드(allowOnly)를 정한다
}

export type PreCheck = { ok: true; enf: ChannelEnforcement } | { ok: false; reason: string };

// ① 인자 게이트 — 상류로 보내기 전. 슬랙엔 채널 단위 OAuth 권한이 없어 여기서만 거를 수 있다.
//  #1262 부터 **비공개 채널·그룹DM·DM 은 사람이 켜기 전까지 기본 거부**라 '정책 행이 없으면 통과' 지름길은 없다 —
//  대화 종류를 알아야 판정할 수 있고, 채널 id 로는 종류를 알 수 없어(비공개도 C 로 시작) 게이트가 캐시·슬랙 조회로
//  해소한다. 조회 실패는 fail-closed — '못 읽었으니 일단 보여준다' 는 이 기능의 목적을 정면으로 배신한다.
//  meta(채널·사용자 목록/검색)는 대화 내용이 아니라 정책 대상 밖 — 가드도 응답 필터도 태우지 않는다(#1226 실박스).
export async function channelPreCheck(opts: {
  callerId: string | null | undefined;
  system: ChannelSystem | null;
  toolName: string;
  level: "L0" | "L1" | "L2" | null | undefined;
  args: Record<string, unknown> | undefined;
  /** 테스트 주입 — 기본은 실제 게이트(DB·슬랙 조회). */
  openGate?: (memberId: string, system: ChannelSystem) => Promise<ChannelGate>;
}): Promise<PreCheck> {
  const none: ChannelEnforcement = { gate: null, toolKind: "read", argTargets: new Set() };
  if (!opts.system || !opts.callerId) return { ok: true, enf: none };
  const toolKind = channelToolKind(opts.toolName, opts.level);
  if (toolKind === "meta") return { ok: true, enf: { ...none, toolKind } };
  let gate: ChannelGate;
  try { gate = await (opts.openGate ?? openChannelGate)(opts.callerId, opts.system); }
  catch (err) { return { ok: false, reason: `채널 허용 설정을 확인하지 못해 호출을 중단했습니다(${(err as Error).message}).` }; }
  const argTargets = extractChannelTargets(opts.args ?? {});
  const policy = await gate.resolve(argTargets);
  const verdict = checkChannelCall(opts.toolName, opts.args ?? {}, policy, toolKind);
  if (!verdict.allowed) return { ok: false, reason: verdict.reason ?? "허용되지 않은 대화입니다" };
  return { ok: true, enf: { gate, toolKind, argTargets } };
}

// ② 응답 필터 — 열람이 허용되지 않은 대화의 항목을 도려낸다. **PII 스크럽·자격 스크럽보다 먼저** 불러야 한다 —
//  저들이 텍스트를 고치면 JSON 구조가 깨져 항목 단위로 못 도려낸다. 발송(write)은 인자 게이트에서 이미 판정됐고,
//  여기서 또 거르면 '보내긴 했는데 결과를 못 보는' 꼴이 되므로 read 만 태운다.
//  판정 기준은 호출이 대화를 지목했는지로 갈린다(#1262): 지목함=차단된 것만 제거 / 안 지목함(전역 검색)=허용
//  확인된 항목만 남긴다(귀속을 못 읽는 항목은 뺀다 — 기본이 '거부'인 이상 그 구멍으로 비공개가 샌다).
export async function channelPostFilter(enf: ChannelEnforcement, toolName: string, content: unknown[]): Promise<unknown[]> {
  if (!enf.gate || enf.toolKind !== "read") return content;
  const allowOnly = enf.argTargets.size === 0;
  const policy = await enf.gate.resolve(extractResponseTargets(content));
  const f = filterChannelContent(content, policy, allowOnly);
  if (f.removed || f.blocked) logger.info({ tool: toolName, removed: f.removed, blocked: f.blocked, allowOnly }, "채널 정책 — 응답에서 비허용 대화 제거");
  return f.content;
}
