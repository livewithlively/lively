// 리브가 사람에게 자격을 받는 자리의 **순수 판정**(#1631) — 어디에 넣어도 되는가, 아직 물어야 하는가.
//
//  왜 떼어냈나: 이 두 판정이 **안전 경계**다. 겨눌 수 있는 자리를 잘못 열면 리브가 아무 수집기에나 값을
//   흘려보낼 수 있고, 죽은 요청을 계속 띄우면 사람은 이미 끝난 일을 붙들고 앉는다. DB·HTTP 에 묻어 두면
//   그 두 가지를 눈으로 확인할 방법이 없다.
//
//  ⚠ **값은 이 모듈을 지나가지 않는다.** 여기 있는 건 "무엇을 어디에" 뿐이다.
//
//  넣을 자리는 둘이다 — 수집기의 시크릿 칸(collector_id·field)과 요청자 **본인 금고** 칸(vault_kind·vault_scope).
//   본인 금고 쪽 규칙은 me_credential_set 과 같은 판정(member-secret-rules.ts)을 쓴다 — 입구가 달라도 경계는 하나다.
//   다만 리브 입력칸에만 붙는 규칙이 둘 있다 — 칸을 고른 것은 리브(AI)인데 값을 치는 것은 사람이라서다:
//   ① scope 가 접속 호스트인 kind 는 이미 등록된 호스트로만 받는다(vaultScopeVerdict) ② 저장 위치를 서버가 문장으로 만들어
//   카드에 따로 보인다(vaultAskDest). me_credential_set 은 값을 넣는 쪽이 칸도 고르므로 둘 다 필요 없다.
import { selfCredentialTargetVerdict, HOST_SCOPED_KINDS } from "../credentials/member-secret-rules.js";

/** 판정에 필요한 만큼의 수집기(CollectorView 의 부분집합). */
export interface AskTargetCollector {
  id: number;
  secretsSet: Record<string, boolean>;
  fields: Array<{ key: string; secret?: boolean }>;
  secrets_enabled: boolean;
}

export type AskTargetVerdict =
  | { ok: true }
  | { ok: false; reason: "no-collector" | "not-a-secret-field" | "no-master-key" };

/**
 * 리브가 이 자리에 자격을 요청해도 되는가.
 *
 * - 수집기가 없으면 안 된다(존재하지 않는 대상).
 * - **그 프리셋이 시크릿이라고 선언한 필드**여야 한다 — 아무 설정 칸이나 겨누면 평문 설정에 자격이 박힌다.
 * - 마스터키가 없으면 안 된다. 받아 봐야 안전하게 못 넣는데 사람에게 시키면 그게 거짓말이다.
 */
export function askTargetVerdict(c: AskTargetCollector | null | undefined, field: string): AskTargetVerdict {
  if (!c) return { ok: false, reason: "no-collector" };
  const f = (c.fields ?? []).find((x) => x.key === field);
  if (!f?.secret) return { ok: false, reason: "not-a-secret-field" };
  if (!c.secrets_enabled) return { ok: false, reason: "no-master-key" };
  return { ok: true };
}

/** 요청 하나가 겨누는 자리. 값은 담지 않는다. */
export type LivAskTarget =
  | { target: "collector"; collector_id: number; field: string }
  | { target: "vault"; vault_kind: string; vault_scope: string };

/** 저장된 요청의 모양(LivSecretAsk 의 판정에 필요한 부분). */
export interface LivAskLike {
  kind?: string; at?: string; target?: string;
  collector_id?: number; field?: string; vault_kind?: string; vault_scope?: string;
}

const present = (v: unknown): boolean => v !== undefined && v !== null && String(v).trim() !== "";

/**
 * 요청 입력이 어느 쪽을 겨누나 — **정확히 하나**여야 한다.
 *  둘 다 오면 어디에 넣을지 서버가 고르게 되는데, 그 선택이 틀리면 값이 엉뚱한 칸에 들어간다. 그래서 고르지 않고 거절한다.
 */
export function askTargetChoice(input: Record<string, unknown>):
  { ok: true; target: "collector" | "vault" } | { ok: false; reason: "both" | "none" } {
  const col = present(input.collector_id) || present(input.field);
  const vault = present(input.vault_kind) || present(input.vault_scope);
  if (col && vault) return { ok: false, reason: "both" };
  if (!col && !vault) return { ok: false, reason: "none" };
  return { ok: true, target: col ? "collector" : "vault" };
}

export type VaultAskVerdict =
  | { ok: true; vault_kind: string; vault_scope: string }
  | { ok: false; reason: "no-kind" | "bad-kind" | "bad-scope" | "admin-only" | "no-master-key" };

/**
 * 리브가 요청자 본인 금고의 이 칸을 요청해도 되는가 — me_credential_set 이 거절할 칸은 여기서도 거절한다.
 *  마스터키 확인은 형식 검사 **다음**이다(틀린 kind 는 어느 배포에서든 틀렸다 — me_credential_set 과 같은 순서).
 */
export function vaultAskVerdict(kind: unknown, scope: unknown, secretsEnabled: boolean): VaultAskVerdict {
  const v = selfCredentialTargetVerdict(kind, scope);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (!secretsEnabled) return { ok: false, reason: "no-master-key" };
  return { ok: true, vault_kind: v.kind, vault_scope: v.scope_key };
}

/** 금고 칸의 기본 이름 — 리브가 label 을 안 줬을 때 사람이 무슨 칸인지는 알게. */
export function vaultAskLabel(kind: string, scope: string): string {
  return scope ? `${kind} (${scope})` : kind;
}

export type VaultScopeVerdict =
  | { ok: true; vault_scope: string }
  | { ok: false; reason: "unknown-host" };

/**
 * 리브가 고른 scope 로 받아도 되는가 — **scope 가 접속 호스트인 kind**(HOST_SCOPED_KINDS)만 따진다.
 *  왜: 리브가 gitlab_pat 칸을 evil.example.com 으로 요청하면 사람이 친 진짜 토큰이 수집·레포 목록 조회 때 그 호스트로 나간다.
 *   사람은 입력칸에 값만 친다 — 호스트를 고른 것은 사람이 아니다.
 *  받는 scope: (a) 요청자가 이미 가진 같은 kind 칸의 scope · (b) 조직이 같은 kind 로 등록한 칸의 scope(관리자 통합 자격) ·
 *   (c) 빈 scope — 그 kind 에 기본 칸이 있을 때만.
 *  호스트라 대소문자를 가리지 않고, 맞으면 **이미 있는 칸의 표기**를 돌려준다 — 금고 키는 대소문자를 지켜서 다른 표기로 넣으면
 *   칸이 하나 더 생기고, 기존 칸은 그대로 남는다(사람은 바꿨다고 믿는다).
 *  ⚠ (a) 는 «사람이 그 호스트를 정했다» 의 증거가 아니다 — me_credential_set(MCP)으로 칸을 먼저 만들 수 있다.
 *   그때 남는 방어선은 카드의 저장 위치 문장(vaultAskDest — 호스트와 «이미 저장된 값을 바꿉니다» 가 보인다)이다.
 */
export function vaultScopeVerdict(
  kind: string, scope: string,
  mine: ReadonlyArray<Pick<VaultSlot, "kind" | "scope_key">>, orgScopes: ReadonlyArray<string> = [],
): VaultScopeVerdict {
  const host = HOST_SCOPED_KINDS.get(kind);
  if (!host) return { ok: true, vault_scope: scope };
  const lc = scope.toLowerCase();
  const pick = (xs: ReadonlyArray<string>): string | undefined => xs.find((x) => x === scope) ?? xs.find((x) => x.toLowerCase() === lc);
  const own = pick(mine.filter((r) => r.kind === kind).map((r) => r.scope_key));
  if (own !== undefined) return { ok: true, vault_scope: own };
  if (!scope) return host.emptyOk ? { ok: true, vault_scope: "" } : { ok: false, reason: "unknown-host" };
  const org = pick(orgScopes);
  return org !== undefined ? { ok: true, vault_scope: org } : { ok: false, reason: "unknown-host" };
}

/**
 * 금고 kind 의 사람이 읽는 이름 — 웹 [자격] 목록(web/admin-credentials.ts CRED_KINDS)의 이름과 맞춘다.
 *  모르는 kind 는 kind 그대로 보인다(모양은 판정이 이미 소문자·숫자·_ 로 걸렀다). Map 인 이유: 객체면 `constructor` 같은 kind 가
 *   원형의 속성을 집어 온다.
 */
const VAULT_KIND_NAMES: ReadonlyMap<string, string> = new Map([
  ["gitlab_pat", "GitLab 개인 토큰"],
  ["github_pat", "GitHub 토큰"],
  ["slack_user_token", "Slack 사용자 토큰"],
  ["clickup_token", "ClickUp 토큰"],
  ["notion_token", "Notion 토큰"],
  ["figma_token", "Figma 토큰"],
  ["zotero_token", "Zotero API 키"],
  ["prometheus_bearer", "Prometheus Bearer 토큰"],
  ["claude_setup_token", "Claude 헤드리스 토큰"],
  ["codex_auth_json", "Codex 로그인 파일(auth.json)"],
  ["anthropic_api_key", "Anthropic API 키"],
  ["lively_workspace", "팀 워크스페이스 토큰"],
]);
export function vaultKindName(kind: string): string {
  return VAULT_KIND_NAMES.get(kind) ?? kind;
}

/**
 * 카드에 보일 **저장 위치** — 서버가 만들어 요청에 싣는다(리브가 준 label·why·hint 와 따로). 사람은 리브의 말이 아니라 이
 *  문장으로 값이 갈 곳을 안다: 내 개인 금고 · 어느 자격 칸 · 호스트 kind 면 어느 호스트에 쓰이는지 · 이미 있던 값을 바꾸는지.
 *  ⚠ 화면 문구라 끝맺는 문장이다(명사 종결 금지 — 이 조직의 UI 문구 규칙).
 */
export function vaultAskDest(kind: string, scope: string, replaces: boolean): string {
  const name = `«${vaultKindName(kind)}»`;
  const host = HOST_SCOPED_KINDS.get(kind);
  const where = !scope
    ? `이 값은 내 개인 금고의 ${name} ${host?.emptyOk ? "기본 " : ""}칸에 저장됩니다.`
    : host
      ? `이 값은 내 개인 금고의 ${name} 칸에 저장되고, ${scope} 에 접속할 때 쓰입니다.`
      : `이 값은 내 개인 금고의 ${name} 칸(구분값 ${scope})에 저장됩니다.`;
  return replaces ? `${where} 이미 저장된 값을 바꿉니다.` : where;
}

/**
 * 저장된 요청이 겨누는 자리. 자격 요청이 아니거나 모양이 깨졌으면 null.
 *  ⚠ target 이 없는 요청은 **수집기**로 읽는다 — 금고 대상이 생기기 전에 저장된 요청이 그 모양이다.
 */
export function askTargetOf(ask: LivAskLike | null | undefined): LivAskTarget | null {
  if (!ask || (ask.kind && ask.kind !== "secret")) return null;
  if (ask.target === "vault") {
    return ask.vault_kind ? { target: "vault", vault_kind: ask.vault_kind, vault_scope: ask.vault_scope ?? "" } : null;
  }
  if (ask.target && ask.target !== "collector") return null;
  return Number.isInteger(ask.collector_id) && ask.field
    ? { target: "collector", collector_id: ask.collector_id as number, field: ask.field } : null;
}

/** 수집기 칸 값의 상한 — 금고 칸은 금고 쪽 검사(validateMemberSecret)가 상한을 정한다. */
export const COLLECTOR_SECRET_MAX = 8192;

/**
 * 화면이 값을 보냈을 때 어디에 넣나. **대상은 저장된 요청에서만** — 입력에서는 value 하나만 읽는다.
 *  브라우저가 collector_id·vault_kind 를 실어 보내도 보지 않는다(다른 칸으로 새는 것을 막는 경계).
 */
export function livSecretPutPlan(ask: LivAskLike | null | undefined, input: Record<string, unknown>):
  { ok: true; target: LivAskTarget } | { ok: false; reason: "no-ask" | "empty" | "too-long" } {
  const target = askTargetOf(ask);
  if (!target) return { ok: false, reason: "no-ask" };
  const value = String(input.value ?? "");
  if (!value.trim()) return { ok: false, reason: "empty" };
  if (target.target === "collector" && value.length > COLLECTOR_SECRET_MAX) return { ok: false, reason: "too-long" };
  return { ok: true, target };
}

/** 집계 입력 — 사람마다 남긴 답들(누구인지는 쓰지 않는다). */
export interface AnswerRow { key: string; choices?: string[]; other?: string; question?: string; by?: "self" | "liv" }

export interface AnswerStat {
  key: string; question: string | null; responders: number; by_self: number; by_liv: number;
  choices: Array<{ id: string; n: number }>; others: Array<{ text: string; n: number }>;
}

/**
 * 답들을 **개선점을 찾을 수 있는 모양**으로 접는다.
 *
 * 두 가지가 핵심이다:
 * - **`others` 를 버리지 않는다.** 목록에 없어 직접 적어낸 이름(카카오톡·에버노트·에어테이블…)이
 *   곧 다음에 만들 커넥터 후보다. 실측에서 가장 값진 정보가 정확히 거기 있었다.
 * - **`by` 로 나눠 센다.** 사람이 버튼을 누른 것(self)과 리브가 채팅을 옮겨 적은 것(liv)을 섞으면,
 *   리브가 잘못 옮긴 것과 사람이 직접 고른 것을 구분할 수 없어 통계를 믿을 수 없게 된다.
 */
export function foldAnswerStats(rows: ReadonlyArray<ReadonlyArray<AnswerRow>>): AnswerStat[] {
  const byKey = new Map<string, {
    question: string | null; responders: number; self: number; liv: number;
    c: Map<string, number>; o: Map<string, number>;
  }>();
  for (const perPerson of rows) {
    for (const a of perPerson ?? []) {
      if (!a?.key) continue;
      let e = byKey.get(a.key);
      if (!e) { e = { question: a.question ?? null, responders: 0, self: 0, liv: 0, c: new Map(), o: new Map() }; byKey.set(a.key, e); }
      e.responders++;
      if (a.by === "liv") e.liv++; else e.self++;   // by 미표기(옛 레코드)는 사람 답으로 본다
      if (a.question && !e.question) e.question = a.question;
      for (const c of a.choices ?? []) e.c.set(c, (e.c.get(c) ?? 0) + 1);
      if (a.other) e.o.set(a.other, (e.o.get(a.other) ?? 0) + 1);
    }
  }
  const sort = <T extends { n: number }>(xs: T[]): T[] => xs.sort((x, y) => y.n - x.n);
  return [...byKey.entries()].map(([key, e]) => ({
    key, question: e.question, responders: e.responders, by_self: e.self, by_liv: e.liv,
    choices: sort([...e.c].map(([id, n]) => ({ id, n }))),
    others: sort([...e.o].map(([text, n]) => ({ text, n }))),
  }));
}

/**
 * 같은 key 는 **갈아끼운다** — 다시 물어 다시 답했으면 최신 하나만 의미가 있다.
 *
 * ⚠ 두 줄이 남으면 `responders` 가 사람 수보다 커진다. 통계가 조용히 틀어지는 가장 흔한 경로다.
 */
export function mergeAnswer(cur: ReadonlyArray<AnswerRow>, next: AnswerRow, cap = 50): AnswerRow[] {
  return [...(cur ?? []).filter((a) => a.key !== next.key), next].slice(-cap);
}

/** 본인 금고 칸 하나의 공개 정보(MemberSecretPublic 의 부분집합 — 값 없음). */
export interface VaultSlot { kind: string; scope_key: string; has_secret: boolean; updated_at?: string | Date | null }

/**
 * 화면에 그 요청을 아직 띄워야 하는가.
 *
 * **이미 채워졌거나 대상이 사라졌으면 띄우지 않는다.** 다른 경로로 값이 들어왔을 수 있고(관리탭에서 직접
 * 입력, 다른 기기의 리브), 그때도 칸이 남아 있으면 사람은 "아직 안 됐나" 하고 같은 일을 또 한다.
 */
export function askStillOpen(
  ask: LivAskLike | null | undefined,
  collectors: ReadonlyArray<Pick<AskTargetCollector, "id" | "secretsSet">>,
  vault: ReadonlyArray<VaultSlot> = [],
): boolean {
  const target = askTargetOf(ask);
  if (!target) return false;
  if (target.target === "vault") {
    const row = vault.find((r) => r.kind === target.vault_kind && r.scope_key === target.vault_scope);
    if (!row?.has_secret) return true;
    //  이미 차 있던 칸을 다시 묻는 건 **교체** 요청이다(토큰 재발급). 값이 있다는 것만으로 닫으면 그 칸은 영영 안 뜬다 —
    //   요청 뒤에 채워졌을 때만 끝난 일로 본다. 시각을 모르면 종전처럼 «차 있으면 끝» 으로 읽는다.
    //   updated_at 은 DB 드라이버가 Date 로 줄 수 있다 — 문자열로 바꿔 파싱하면 밀리초가 잘려 같은 초의 저장을 놓친다.
    //   ask.at 은 앱 시계, updated_at 은 DB 시계다. DB 시계가 뒤처지면 요청 직후 다른 경로로 채운 값이 «요청 전» 으로 읽혀 칸이 남는다
    //   — 리브 입력칸으로 넣으면 put 이 요청을 직접 지우므로 주 흐름은 영향이 없다.
    const ms = (v: unknown): number => (v == null || v === "" ? NaN : new Date(v as string).getTime());
    const asked = ms(ask?.at), filled = ms(row.updated_at);
    return Number.isFinite(asked) && Number.isFinite(filled) ? filled < asked : false;
  }
  const c = collectors.find((x) => x.id === target.collector_id);
  if (!c) return false;                        // 수집기가 지워졌다 — 죽은 요청
  return !c.secretsSet?.[target.field];        // 이미 채워졌으면 끝난 일
}
