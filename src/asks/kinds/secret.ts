// 세션 요청 ▸ 자격 입력칸(#1631 → #5713) — AI 는 «무엇이 필요한지» 만 말하고, **값은 화면이 받아 금고로 직행**한다.
//
//  왜 이게 필요한가(실측 2회): AI 는 두 번 다 시크릿을 **채팅에 붙여넣으라고** 했고, 사람이 겁먹고 되물은 뒤에야 화면으로 돌렸다.
//   화면으로 돌릴 때는 **없는 메뉴 경로를 지어냈다**. 안내를 다듬어 고칠 문제가 아니라 받을 자리가 없던 것이 원인이다.
//  계약:
//   - 값은 대화 · 트랜스크립트 · 모델 컨텍스트 어디에도 안 남는다(result · say 에도 없다).
//   - 넣을 자리는 **서버가 저장해 둔 요청**에서만 온다 — 브라우저가 대상을 바꿔 보낼 수 없다.
//   - 넣을 자리는 둘 중 하나 — 수집기의 시크릿 칸(collector_id + field) 또는 요청자 **본인 금고** 칸(vault_kind + vault_scope).
//  판정(어디에 넣어도 되나 · 아직 물어야 하나)은 순수 모듈 org/delivery/liv-secret.ts 가 한다 — 여기는 그 결과를 옮긴다.
//  종전(#1631)엔 리브 도구(me_liv_ask_secret · me_liv_put_secret)였다. 어느 세션이든 쓰게 풀면서(#5713) 이리로 옮겼다 — 판정은 그대로다.
import { z } from "zod";
import { HttpError } from "../../http-error.js";
import { logger } from "../../log.js";
import {
  askTargetVerdict, askStillOpen, askTargetChoice, vaultAskVerdict, vaultAskLabel, livSecretPutPlan,
  vaultScopeVerdict, vaultAskDest, vaultKindName, type VaultSlot, type LivAskLike,
} from "../../org/delivery/liv-secret.js";
import { HOST_SCOPED_KINDS } from "../../org/credentials/member-secret-rules.js";
import { clip, type AskKind } from "../kinds.js";

/** 저장되는 요청의 모양(payload) — 값은 없다. target 이 없으면 수집기다(옛 요청의 모양 — askTargetOf 가 가른다). */
export interface SecretAskPayload {
  at: string;
  kind?: "secret";
  target?: "collector" | "vault";
  collector_id?: number;
  field?: string;
  vault_kind?: string;
  vault_scope?: string;
  /** 사람에게 보일 것. label = 칸 이름, why = 왜 필요한지 한 줄, hint = 값이 어떻게 생겼는지. */
  label: string;
  why?: string;
  hint?: string;
  /** 저장 위치 — **서버가 만든 문장**(본인 금고 대상만 · vaultAskDest). AI 가 고른 칸을 AI 의 말로 설명하면 사람이 검증할 길이 없다. */
  dest?: string;
}

/** 본인 금고 자격 요청의 의존(시험 seam) — 실제 구현은 아래 realVaultAskDeps. */
export interface VaultAskDeps {
  secretsEnabled: () => Promise<boolean>;
  /** 요청자 본인 금고 칸 목록(값 없음) — 호스트 kind 의 (a) «이미 가진 호스트». */
  mine: (userId: string) => Promise<ReadonlyArray<Pick<VaultSlot, "kind" | "scope_key">>>;
  /** 그 칸 하나(목록이 숨기는 칸 포함) — 이미 값이 있으면 카드가 «바꿉니다» 를 말한다. 없으면 null. */
  slot: (userId: string, kind: string, scope: string) => Promise<{ has_secret: boolean } | null>;
  /** 조직이 그 kind 로 등록한 칸의 scope(관리자 통합 자격 — owner gateway) — 호스트 kind 의 (b). */
  orgScopes: (kind: string) => Promise<string[]>;
  /** 판정을 통과한 요청을 받는다(저장은 부르는 쪽 몫 — 세션 요청은 공통 저장소가 한다). */
  setAsk: (userId: string, ask: SecretAskPayload) => Promise<unknown>;
}

/**
 * 요청자 **본인 금고** 칸을 요청한다 — 판정 → 저장 위치 문장 → setAsk. 거절은 HttpError 로 던지고, 그때는 setAsk 를 부르지 않는다.
 *  판정 순서: 형식 · 관리자 전용 · 마스터키(DB 없이) → 호스트 kind 의 scope(이미 등록된 호스트만) → 이미 값이 있나(교체 표시).
 */
export async function vaultSecretAsk(userId: string, input: Record<string, unknown>, d: VaultAskDeps): Promise<SecretAskPayload> {
  const v = vaultAskVerdict(input.vault_kind, input.vault_scope, await d.secretsEnabled());
  if (!v.ok) {
    if (v.reason === "admin-only") throw new HttpError(403, "그 자격은 본인이 넣을 수 없습니다 — 관리자가 통합 자격으로만 넣습니다");
    if (v.reason === "no-master-key") throw new HttpError(409, "이 게이트웨이는 자격을 안전하게 보관할 수 없습니다(마스터키 미설정) — 운영자에게 알려주세요");
    throw new HttpError(400, v.reason === "no-kind" ? "vault_kind 가 필요합니다"
      : v.reason === "bad-kind" ? "vault_kind 형식 오류(소문자·숫자·_ 1~40자)" : "vault_scope 형식 오류(영숫자·._:- 120자 이내)");
  }
  //  scope 가 접속 호스트인 kind 만 칸 목록을 본다 — 아니면 scope 가 무엇이든 값이 가는 곳은 그 서비스 하나다.
  //   조직 쪽 조회가 실패하면 «조직 호스트 없음» 으로 본다(받는 쪽을 좁히는 실패라 안전하다).
  const host = HOST_SCOPED_KINDS.get(v.vault_kind);
  const scoped = host
    ? vaultScopeVerdict(v.vault_kind, v.vault_scope, await d.mine(userId), await d.orgScopes(v.vault_kind).catch(() => []))
    : vaultScopeVerdict(v.vault_kind, v.vault_scope, []);
  if (!scoped.ok) {
    throw new HttpError(400,
      `«${vaultKindName(v.vault_kind)}» 칸의 구분값(vault_scope)은 그 값이 실려 나갈 호스트라서, 내 금고나 조직에 이미 등록된 호스트로만 받습니다` +
      (host?.emptyOk ? "(비워 두면 기본 칸으로 받습니다)" : "") +
      ` — 처음 보는 호스트(${v.vault_scope || "빈 값"})는 사람이 ${host?.connect ?? "연결 화면"} 에서 직접 등록하게 안내하세요.`);
  }
  const scope = scoped.vault_scope;
  const replaces = !!(await d.slot(userId, v.vault_kind, scope))?.has_secret;
  const ask: SecretAskPayload = {
    at: new Date().toISOString(), kind: "secret",
    target: "vault", vault_kind: v.vault_kind, vault_scope: scope,
    label: clip(input.label, 80) ?? vaultAskLabel(v.vault_kind, scope),
    why: clip(input.why, 300),
    hint: clip(input.hint, 120),
    //  저장 위치는 서버가 만든다 — 입력에 dest 가 와도 읽지 않는다(AI 가 고른 칸을 AI 의 말로 설명하게 두면 사람이 검증할 길이 없다).
    dest: vaultAskDest(v.vault_kind, scope, replaces),
  };
  await d.setAsk(userId, ask);
  return ask;
}

export const realVaultAskDeps: Omit<VaultAskDeps, "setAsk"> = {
  secretsEnabled: async () => (await import("../../org/credentials/secret-box.js")).secretsEnabled(),
  mine: async (userId) => {
    const s = await import("../../org/credentials/member-secret-store.js");
    return s.listMemberSecretsPublic(s.memberOwner(userId));
  },
  slot: async (userId, kind, scope) => {
    const s = await import("../../org/credentials/member-secret-store.js");
    return s.getMemberSecretPublic(s.memberOwner(userId), kind, scope);
  },
  orgScopes: async (kind) => {
    const s = await import("../../org/credentials/member-secret-store.js");
    return (await s.listMemberSecretsPublic(s.GATEWAY_OWNER)).filter((r) => r.kind === kind).map((r) => r.scope_key);
  },
};

/** 화면이 보낸 값 저장의 의존(시험 seam) — 실제 구현은 아래 realPutDeps. ⚠ 값은 저장 함수 둘에만 건넨다. */
export interface SecretPutDeps {
  /** 저장된 요청 — **대상은 여기서만** 읽는다. */
  getAsk: (userId: string) => Promise<LivAskLike | null | undefined>;
  /** 저장이 끝난 뒤 요청을 닫는다(세션 요청은 공통이 닫으므로 빈 함수). */
  clearAsk: (userId: string) => Promise<unknown>;
  /** 그 금고 칸의 지금 meta·label — 값만 바꾸는 자리라 그대로 다시 넘긴다(저장 경로는 meta 를 교체하므로 안 넘기면 지워진다). */
  vaultSlot: (userId: string, kind: string, scope: string) => Promise<{ meta: Record<string, unknown>; label: string | null } | null>;
  /** me_credential_set 과 같은 저장 경로(member-secret.ts saveOwnCredential). owner 는 언제나 첫 인자 본인. */
  saveOwnCredential: (memberId: string, i: { kind: string; scope_key: string; secret: string; meta: Record<string, unknown>; label: string | null }) => Promise<unknown>;
  saveCollectorSecret: (collectorId: number, field: string, value: string, actor: string) => Promise<unknown>;
  log: (o: Record<string, unknown>, msg: string) => void;
}

export type SecretPutOut = { ok: true; target: "vault"; vault_kind: string; vault_scope: string } | { ok: true; field: string };

/**
 * 화면의 안전 입력칸이 보낸 값을 넣는다. ⚠ 대상은 **저장된 요청**에서만 — 입력에서는 value 하나만 읽는다(다른 수집기·다른 금고 칸으로
 *  새는 것을 막는다). 요청은 저장이 끝난 **뒤에** 닫는다 — 저장이 실패하면 칸이 남아 사람이 다시 넣을 수 있다.
 */
export async function secretAskPut(userId: string, input: Record<string, unknown>, d: SecretPutDeps): Promise<SecretPutOut> {
  //  대기 중인 게 자격 요청이 아니면 값이 날아온 것 자체가 잘못된 호출이다.
  const plan = livSecretPutPlan(await d.getAsk(userId), input);
  if (!plan.ok) {
    if (plan.reason === "no-ask") throw new HttpError(409, "지금 받기로 한 자격이 없습니다");
    throw new HttpError(400, plan.reason === "empty" ? "값이 비어 있습니다" : "값이 너무 깁니다");
  }
  const value = String(input.value);
  const target = plan.target;

  if (target.target === "vault") {
    // me_credential_set 과 **같은 저장 경로** — 값 검사·암호화 키 확인·저장 뒤 부작용이 한 벌이다. owner 는 언제나 요청자 본인.
    const cur = await d.vaultSlot(userId, target.vault_kind, target.vault_scope);
    await d.saveOwnCredential(userId, {
      kind: target.vault_kind, scope_key: target.vault_scope, secret: value,
      meta: cur?.meta ?? {}, label: cur?.label ?? null,
    });
    d.log({ member: userId, kind: target.vault_kind, scope_key: target.vault_scope, source: "session-ask" }, "안전 입력칸으로 본인 금고 자격 저장");
    await d.clearAsk(userId);
    return { ok: true, target: "vault", vault_kind: target.vault_kind, vault_scope: target.vault_scope };  // 값은 절대 되돌려주지 않는다
  }

  await d.saveCollectorSecret(target.collector_id, target.field, value, userId);
  await d.clearAsk(userId);
  return { ok: true, field: target.field };  // 값은 절대 되돌려주지 않는다
}

export const realPutDeps: Omit<SecretPutDeps, "getAsk" | "clearAsk"> = {
  vaultSlot: async (userId, kind, scope) => {
    const s = await import("../../org/credentials/member-secret-store.js");
    return s.getMemberSecretPublic(s.memberOwner(userId), kind, scope);
  },
  saveOwnCredential: async (memberId, i) => (await import("../../capabilities/member-secret.js")).saveOwnCredential(memberId, i),
  saveCollectorSecret: async (collectorId, field, value, actor) => {
    const { upsertCollector } = await import("../../org/store/collectors.js");
    //  id 로 보낸다: key 로 보내면 중복키로 500 이 난다(#1631 실측).
    //   세 번째 인자는 감사 기록의 출처다 — 옛 값('liv')을 그대로 둔다(이 값을 고르는 조회가 있을 수 있다).
    return upsertCollector({ id: collectorId, secrets: { [field]: value } }, actor, "liv");
  },
  log: (o, msg) => logger.info(o, msg),
};

const secretInput = {
  collector_id: z.number().int().positive().optional().describe("자격을 넣을 수집기 id"),
  field: z.string().optional().describe("그 수집기의 시크릿 필드 key(예: token)"),
  vault_kind: z.string().optional().describe("수집기 대신 그 사람 **본인 금고**(me_credential_set 과 같은 칸)에 넣을 때의 자격 종류(예: slack_bot_token). collector_id·field 와 함께 주지 않는다."),
  vault_scope: z.string().optional().describe("본인 금고 칸의 구분값(같은 종류를 여러 개 쓸 때 — 예: GitLab 호스트). 기본 빈 문자열. " +
    "⚠ 구분값이 그 값이 실려 나갈 호스트인 종류(gitlab_pat·lively_workspace)는 내 금고나 조직에 이미 등록된 호스트(gitlab_pat 은 비워 두면 기본 칸)로만 받는다 — 새 호스트는 400 이고, 사람이 연결 화면에서 직접 등록한다."),
  label: z.string().optional().describe("칸 이름 — 사람이 읽는다. 없으면 프리셋 라벨(본인 금고면 자격 종류)."),
  why: z.string().optional().describe("왜 필요한지 한 줄. 이유를 모르면 사람은 겁이 나서 멈춘다."),
  hint: z.string().optional().describe("값이 어떻게 생겼는지(예: ntn_ 로 시작하는 긴 문자열)."),
  cancel: z.boolean().optional().describe("true 면 이 세션에서 걸어 둔 자격 요청을 내린다."),
};

export const secretAskKind: AskKind = {
  kind: "secret",
  label: "값 입력",
  tool: {
    name: "session_ask_secret",
    title: "자격 입력칸 띄우기",
    description:
      "사람에게 받아야 하는 자격(토큰 · 키 · 비밀번호) 하나를 **요청**한다 — 이 세션 화면 오른쪽 «요청» 칸에 안전 입력칸이 뜬다. " +
      "⚠ 시크릿을 대화로 받지 마라. 사람에게 다른 탭 · 메뉴로 가라고 하지도 마라. " +
      "사람이 웹의 세션 화면을 보고 있으면 그 자리에서 끝난다. 로컬 터미널처럼 그 화면이 안 보이는 자리면 응답의 url 을 사람에게 주고 «이 링크에서 넣어 주세요» 라고 하라 — 누르면 그 입력칸으로 바로 간다. " +
      "값은 화면이 받아 곧바로 금고로 넣고, 너는 값을 보지 못한다(저장됐는지만 안다). 저장되면 이 세션에 한 마디가 들어온다 — 안 들어오는 자리(로컬 터미널)면 사람이 끝냈다고 할 때 session_ask_status 로 확인하라. " +
      "넣을 자리는 둘 중 **하나만** 준다 — 수집기 자격 칸이면 collector_id+field, 그 사람 본인의 개인 자격(me_credential_set 이 쓰는 금고 — 예: 슬랙 봇 토큰)이면 vault_kind(+vault_scope). " +
      "본인 금고면 저장 위치(어느 칸 · 어느 호스트 · 이미 있던 값을 바꾸는지)를 서버가 문장으로 만들어 카드에 따로 보여 준다(응답의 ask.payload.dest).",
    input: secretInput,
  },
  aliases: [{ name: "me_liv_ask_secret", title: "자격 입력칸 띄우기(옛 이름)", restPath: "/api/ui/me/liv-secret-ask" }],

  async open(input, who) {
    const choice = askTargetChoice(input);
    if (!choice.ok) {
      throw new HttpError(400, choice.reason === "both"
        ? "넣을 자리는 하나만 — collector_id+field(수집기) 또는 vault_kind(본인 금고) 중 하나를 주세요"
        : "넣을 자리가 필요합니다 — collector_id+field(수집기) 또는 vault_kind(본인 금고)");
    }
    // **대상 검증** — 판정은 순수 모듈이 한다(liv-secret.ts). 여기서는 그 결과를 HTTP 로 옮길 뿐이다.
    if (choice.target === "vault") {
      const p = await vaultSecretAsk(who.userId, input, { ...realVaultAskDeps, setAsk: async () => { /* 저장은 공통이 한다 */ } });
      return { payload: p as unknown as Record<string, unknown>, slot: `vault:${p.vault_kind}@${p.vault_scope ?? ""}` };
    }
    const collectorId = Number(input.collector_id);
    const field = String(input.field ?? "").trim();
    if (!Number.isInteger(collectorId) || collectorId <= 0) throw new HttpError(400, "collector_id 가 필요합니다");
    if (!field) throw new HttpError(400, "field 가 필요합니다");
    const { listCollectors } = await import("../../org/store/collectors.js");
    const c = (await listCollectors()).find((x) => x.id === collectorId);
    const verdict = askTargetVerdict(c, field);
    if (!verdict.ok) {
      if (verdict.reason === "no-collector") throw new HttpError(404, "그 수집기를 찾을 수 없습니다");
      if (verdict.reason === "not-a-secret-field") throw new HttpError(400, `${field} 은(는) 이 수집기의 자격 칸이 아닙니다`);
      throw new HttpError(409, "이 게이트웨이는 자격을 안전하게 보관할 수 없습니다(마스터키 미설정) — 운영자에게 알려주세요");
    }
    const f = c!.fields.find((x) => x.key === field)!;
    const p: SecretAskPayload = {
      at: new Date().toISOString(), kind: "secret", target: "collector",
      collector_id: collectorId, field,
      label: clip(input.label, 80) ?? f.label ?? field,
      why: clip(input.why, 300),
      hint: clip(input.hint, 120) ?? f.hint ?? undefined,
    };
    return { payload: p as unknown as Record<string, unknown>, slot: `collector:${collectorId}:${field}` };
  },

  title: (p) => String(p.label ?? "값 입력"),

  //  대상 수집기가 사라졌거나 이미 채워졌으면 끝난 일이다 — 다른 길(관리 화면 · 다른 기기)로 값이 들어왔을 수 있다.
  async stillOpen(ask, who) {
    const p = ask.payload as LivAskLike;
    if (p.target === "vault") {
      const { listMemberSecretsPublic, memberOwner } = await import("../../org/credentials/member-secret-store.js");
      return askStillOpen(p, [], await listMemberSecretsPublic(memberOwner(who.userId)));
    }
    const { listCollectors } = await import("../../org/store/collectors.js");
    return askStillOpen(p, await listCollectors());
  },

  async submit(ask, input, who) {
    const out = await secretAskPut(who.userId, input, {
      ...realPutDeps,
      getAsk: async () => ask.payload as LivAskLike,
      clearAsk: async () => { /* 닫기는 공통이 한다 */ },
    });
    const label = String((ask.payload as { label?: string }).label ?? "").trim();
    return {
      result: "target" in out ? { saved: true, target: "vault", vault_kind: out.vault_kind, vault_scope: out.vault_scope } : { saved: true, target: "collector", field: out.field },
      say: label ? `«${label}» 값을 저장했어요. 확인하고 이어서 진행해 주세요.` : "요청하신 값을 저장했어요. 확인하고 이어서 진행해 주세요.",
    };
  },
};
