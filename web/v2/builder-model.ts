// v2/builder-model.ts — 앱빌더의 **목록 재료**(#4632). 가운데 목록(builder.ts)과 앱빌더 사이드바(side.ts renderBuilderSection)가 같은 한 벌을 읽는다.
//
//  원준 2026-10-17 «앱 빌더의 사이드바도 기획해줘 … 사이드바 내용까지가 하나의 앱이야». 사이드바가 가운데와 다른 잣대로 「만들던 앱」 을 세우면
//   한쪽에만 보이는 앱이 생긴다. 그래서 판정(만들던 앱 · 내가 만든 앱 · 팀원이 만든 앱)은 여기 한 자리에만 두고, 둘은 그리기만 한다.
//  서버에서 받는 것(앱 목록 · 나)은 한 번 받아 두고 30초 안에는 다시 받지 않는다. 이 브라우저의 만들기 기록 · 셸의 세션 목록은 그릴 때마다 새로 읽는다.
import { api } from '../core.js';
import { studioMe, studioRecBuildingFor, studioRecs } from './app-studio.js';
import { appStateOf } from './app-session.js';
import { declaresServer } from '../lib/app-screen.js';   // #4485 후속 — 서버가 화면을 만드는 앱도 화면 앱
import { appIconSpecOf, type AppIconSpec } from './glass-icon.js';   // #4769 구성원 앱의 아이콘 선언
import { folderView, type FolderView } from '../lib/app-folder-text.js';   // #4785 앱 폴더 줄
import { builderSessionName, draftTitle, isAppInProgress, isBuilderSession, isBuildingSession } from '../lib/builder-flow.js';

export interface BuilderEnv {
  projects: () => ReadonlyArray<{ id: number; name: string }>;
  sessions: () => ReadonlyArray<{ id: string; label: string; projectId: number | null; task?: unknown; lastSeen?: number; createdAt?: number; owned?: boolean; node?: string | null; trashedAt?: string | null; logId?: string | null; logNode?: string | null; raw?: { claudeSessionId?: unknown } | null }>;
  /** 세션 목록(정본)을 한 번이라도 받았나 — 받은 뒤에만 «기록은 있는데 서버에 세션이 없다» 를 «지운 만들기» 로 읽는다. 안 주면 모른다(종전대로 기록을 다 세운다). */
  sessionsReady?: () => boolean;
  /** 앱빌더 사이드바를 다시 그린다 — 앱빌더 안의 이동(셸이 다시 그리지 않는다)과 목록을 새로 받은 뒤. */
  redrawSide?: () => void;
  /** 앱빌더가 주소를 hashchange 없이 바꿨다(고른 카드 · 새 세션) — 셸 탭의 주소도 맞춘다(탭을 다시 켜면 그 주소로 돌아온다). */
  setRoute?: (hash: string) => void;
}
/** 앱 한 줄 — /api/ui/apps 의 행을 앱빌더가 보는 만큼만. 꺼진 앱도 든다(런치패드용 listSessionApps 는 켜진 것만 준다). */
export interface BApp {
  id: string; title: string; version: string; enabled: boolean; installedBy: string; installedAt: number; hasUi: boolean; canEdit: boolean; builtin: boolean; versionNo: number; hasInstructions: boolean; icon: AppIconSpec | null;
  studio: { place?: string; card?: unknown; put?: boolean } | null;   // 매니페스트의 자리 · 기획 카드 · 마무리 표시(앱 코드 — 누가 · 어느 세션 · 원본은 아래 서버 칸)
  //  #4667 서버가 찍은 기록 · 공개 상태(apps/visibility.ts) — app-session.appStateOf 와 같은 자로 읽는다.
  visibility: 'all' | 'me'; madeBy: string; ownerMember: string | null; origin: { id: string; title: string; madeBy: string } | null;
  view: 'installed' | 'published'; draft: { by: string; versionNo: number } | null; buildSession: string; isOwner: boolean; canPublish: boolean; canUnpublish: boolean;
  empty: boolean;   // 「만들기 시작」 이 예약만 하고 아직 첫 판이 없는 앱
  publishedNo: number;   // 공개한 판 번호(0 = 아직 공개 전) — 공개 확인 창이 «지금 쓰는 V3 대신» 이라 말한다
  //  #4785 앱 폴더 — 원하는 상한 · 매니지드 쿼터 정비가 잰 쓰는 양과 그때 걸려 있던 상한 · 단계 · 바꿀 수 있나 · 거나(lib/app-folder-text).
  folder: FolderView;
}
export async function listAllApps(): Promise<BApp[]> { return (await fetchApps()) || []; }
/** 받지 못하면 null — 받아 둔 것을 빈 목록으로 덮지 않으려고(사이드바가 «아직 만든 앱이 없어요» 로 거짓말하지 않게). */
async function fetchApps(): Promise<BApp[] | null> {
  try {
    //  include_empty — 아직 첫 판이 없는 예약 앱(만들던 앱 ②)도 받는다. 나만 보는 앱은 서버가 책임자에게만 싣는다.
    const out: any = await api('/api/ui/apps?include_empty=1');
    const rows: any[] = Array.isArray(out?.apps) ? out.apps : [];
    return rows.filter((a) => a && a.status === 'active').map((a) => ({
      id: String(a.id), title: String(a.title || a.id), version: String(a.version || '0.0.0'), enabled: a.enabled !== false,
      installedBy: String(a.installed_by || ''), installedAt: (() => { const t = Date.parse(String(a.installed_at || '')); return Number.isFinite(t) ? t : 0; })(),
      hasUi: ((((a.manifest && a.manifest.ui) || {}).pages || []).length > 0) || declaresServer(a.manifest), canEdit: a.can_edit === true,   // #4485 후속 — 서버가 화면을 만드는 앱도
      builtin: !!(a.source && a.source.kind === 'builtin'), versionNo: Number(a.current_version_no) || 0,
      hasInstructions: !!(a.manifest && a.manifest.agent && a.manifest.agent.instructions),
      icon: appIconSpecOf(a.manifest),   // #4769
      studio: a.manifest && a.manifest.studio && typeof a.manifest.studio === 'object' ? a.manifest.studio : null,
      ...appStateOf(a), empty: a.empty === true, publishedNo: Number(a.published_version_no) || 0,
      folder: folderView(a.folder),
    }));
  } catch (_) { return null; }
}

/** 만들던 앱 한 줄. local = 이 브라우저의 기록에서 왔다 · serverApp = 서버가 아는 그 만들기의 앱. */
export interface Draft { sid: string; title: string; stage: string; appId: string; done: boolean; fixing?: boolean; at: number; local: boolean; node: string; serverApp?: string }
export interface BuilderModel { apps: BApp[]; me: { id: string; name: string }; drafts: Draft[]; mine: BApp[]; team: BApp[]; goneRecs: string[] }
/** 막 시작한 만들기는 세션이 목록에 오기 전일 수 있다 — 그동안은 기록만 있어도 세운다. */
export const REC_GRACE_MS = 2 * 60_000;

/** 방금 지운 앱빌딩 세션 — 셸의 세션 목록이 갱신되기 전에 「만들던 앱」 에 다시 서지 않게(가운데 · 사이드바 둘 다). */
export const deletedSids = new Set<string>();

/** 받아 둔 앱 목록 · 나 + 지금의 기록 · 세션 → 세 묶음. 가운데 목록과 사이드바가 같은 이 판정을 쓴다. */
export function buildModel(apps: BApp[], m: { id: string; name: string }, env: Pick<BuilderEnv, 'projects' | 'sessions' | 'sessionsReady'>): BuilderModel {
  const projName = (pid: number | null): string => { const p = pid ? env.projects().find((x) => x.id === pid) : null; return p ? p.name : ''; };
  // 만들던 앱 — 이 브라우저의 기록 + 앱빌딩 세션(기록이 없어도) · 다 만든 것은 뺀다
  const recs = studioRecs();
  const sessOf = (sid: string) => env.sessions().find((x) => x.id === sid) || null;
  //  #4667 «다 만든 앱» = 마무리(⑤ 「이대로 넣기」)를 지났거나 공개한 앱. 만들기 세션 · 만든 사람은 서버 기록(build_session · made_by)이다.
  const isDone = (a: BApp): boolean => !a.empty && (!!(a.studio && a.studio.put) || a.visibility === 'all');
  //  카드 이름 = 사람이 정한 앱 이름(원준 2026-10-15 «내가 이름 정해 주지 않았나? 그걸로») — 기록의 이름 · 기획 카드 · 세션 이름 «"이름" 앱 제작» · 앱 이름 차례(lib/builder-flow draftTitle).
  //  고침을 보내 둔 기록(fixing) — 앱의 지금 판이 보낸 때 판보다 뒤면 이미 끝났다(앱빌더를 열면 끝맺는다 · 그 전에도 줄은 «수정 중» 이라 하지 않는다).
  const fixingOf = (r: { appId: string; fixing?: { ver: number } }): boolean => { const a = r.fixing && r.appId ? apps.find((x) => x.id === r.appId) : null; return !!r.fixing && !(a && r.fixing.ver > 0 && a.versionNo > r.fixing.ver); };
  const appTitleOf = (id: string): string => { const a = id ? apps.find((x) => x.id === id) : null; return a && !a.empty ? a.title : ''; };
  //  이 브라우저의 기록은 **서버에 그 세션이 있을 때만** 선다. 기록은 브라우저마다 따로라, 한 브라우저에서 지우면(세션 완전 삭제)
  //   다른 브라우저엔 기록이 그대로 남는다 — 종전엔 그 기록만으로 카드가 서서 지운 만들기가 사파리 · 다른 컴퓨터에서 다시 섰다
  //   (원준 2026-10-28 «사파리 브라우전데 안지워졌어»). 세션 목록을 받기 전 · 막 시작한 만들기(REC_GRACE_MS)는 모르니 세운다.
  //   그 세션을 휴지통에 버렸어도 서지 않는다. 서지 않는 기록은 goneRecs 로 돌려 부르는 쪽(앱빌더 목록)이 지운다.
  const ready = !!env.sessionsReady?.();
  const goneRec = (r: { sid: string; at?: number }): boolean => ready && !sessOf(r.sid) && Date.now() - (Number(r.at) || 0) > REC_GRACE_MS;
  const goneRecs = recs.filter(goneRec).map((r) => r.sid);
  //  ★ 만든 앱(⑤ 넣기를 지났거나 공개한 앱)은 고치는 중이어도 「내가 만든 앱」 이다(원준 2026-10-28 «한번이라도 5번 단계까지 끝까지 가면 그건 만든 앱에 있어야»).
  //   그 앱의 기록 · 고치기 세션은 「만들던 앱」 카드가 되지 않는다 — 종전엔 앱의 지금 만들기 세션(build_session) 하나만 끝난 것으로 봐서, 「고치기」 를
  //   다시 누를 때마다 앞의 고치기 세션이 「만들던 앱」 에 같은 이름의 앱으로 하나 더 섰다(원준 2026-10-28 «회의록 어플이 두 개가 됐어»).
  const doneApp = (id: string): boolean => { const a = id ? apps.find((x) => x.id === id) : null; return !!a && isDone(a); };
  const drafts: Draft[] = recs.filter((r) => !r.done && !deletedSids.has(r.sid) && !sessOf(r.sid)?.trashedAt && !goneRec(r) && !doneApp(r.appId || r.draftId || '')).map((r) => ({ sid: r.sid, title: draftTitle({ title: r.title, cardName: r.card && r.card.name, label: sessOf(r.sid)?.label, appTitle: appTitleOf(r.appId || r.draftId || ''), what: r.what }), stage: r.stage, appId: r.appId, done: !!r.done, fixing: fixingOf(r), at: r.at, local: true, node: String(sessOf(r.sid)?.node || ''), serverApp: r.draftId || r.appId || '' }));
  const seen = new Set(drafts.map((d) => d.sid));
  const doneSids = new Set(apps.filter((a) => a.buildSession && isDone(a)).map((a) => a.buildSession));
  //  내가 만든 앱의 이름을 단 세션(«"회의록" 앱 제작») — 만들기 세션 기록이 다른 세션으로 옮겨 간 옛 세션이다. 그 앱은 이미 「내가 만든 앱」 에 있다.
  const doneTitles = new Set(apps.filter((a) => isDone(a) && (a.madeBy === m.id || a.ownerMember === m.id)).map((a) => a.title.trim()));
  //  서버가 아는 내 만들기 — 공개 전이고 마무리 전인 나만 보는 앱(다른 기기 · 다른 브라우저에서 시작한 것도 여기 선다).
  //   앱 찾기와 같은 자(lib/builder-flow isAppInProgress) — 앱빌더가 새로 만드는 중인 앱만 여기 서고, 그 앱은 앱 찾기에 앱으로 서지 않는다. 빈 예약(첫 판 전)도 여기.
  //   보통 AI 세션이 저장한 나만 보는 앱(그 세션도 build_session 으로 적힌다)은 다 만든 앱이라 「내가 만든 앱」 에 선다.
  const buildingApp = (a: BApp): boolean => {
    if (studioRecBuildingFor(a.id)) return true;
    const s = sessOf(a.buildSession);
    return !!s && isBuildingSession(s.label, projName(s.projectId));
  };
  apps.filter((a) => a.isOwner && a.buildSession && (a.empty ? a.visibility === 'me' : isAppInProgress(a, buildingApp(a))) && !seen.has(a.buildSession) && !deletedSids.has(a.buildSession)).forEach((a) => {
    seen.add(a.buildSession);
    drafts.push({ sid: a.buildSession, title: draftTitle({ label: sessOf(a.buildSession)?.label, appTitle: a.empty ? '' : a.title, what: a.empty ? a.title : '' }), stage: a.empty ? 'plan' : 'fix', appId: a.empty ? '' : a.id, done: false, at: a.installedAt, local: false, node: String(sessOf(a.buildSession)?.node || ''), serverApp: a.id });
  });
  //  내 세션만(owned 는 서버 판정 — 없으면 옛 목록, 그때는 보인다). 남이 만들던 앱은 남의 것이다.
  //   휴지통에 버린 세션(홈 사이드바)은 만들던 앱이 아니다 — 지난 세션(멈춘 것)은 이어서 만들 수 있으니 그대로 선다. 앱빌더 「지우기」 는 완전 삭제라 목록에서 아예 빠진다.
  env.sessions().filter((s) => !s.task && !s.trashedAt && s.owned !== false && !seen.has(s.id) && !deletedSids.has(s.id) && isBuilderSession(s.label, projName(s.projectId))).forEach((s) => {
    if (doneSids.has(s.id)) return;   // 그 세션이 만든 앱이 이미 다 만들어졌다 — 「내가 만든 앱」 에 선다
    if (!isBuildingSession(s.label, projName(s.projectId))) return;   // 고치기 세션(«"이름" 앱 고치기»)은 만든 앱을 고치는 것 — 만들던 앱이 아니다
    if (doneTitles.has(builderSessionName(s.label).trim())) return;   // 그 이름의 앱을 이미 다 만들었다(기록이 다른 세션으로 옮겨 간 옛 세션)
    const a = apps.find((x) => x.buildSession === s.id);
    drafts.push({ sid: s.id, title: draftTitle({ label: s.label, appTitle: a && !a.empty ? a.title : '' }), stage: a && !a.empty ? 'fix' : 'plan', appId: a && !a.empty ? a.id : '', done: false, at: s.lastSeen || s.createdAt || 0, local: false, node: String(s.node || ''), serverApp: a ? a.id : '' });
  });
  drafts.sort((a, b) => b.at - a.at);
  const draftAppIds = new Set(drafts.flatMap((d) => [d.appId, d.serverApp || '']).filter(Boolean));
  const ws = apps.filter((a) => !a.builtin && !a.empty);
  const mine = ws.filter((a) => !draftAppIds.has(a.id) && (a.madeBy === m.id || a.ownerMember === m.id));
  const team = ws.filter((a) => !mine.includes(a) && !draftAppIds.has(a.id));
  return { apps, me: m, drafts, mine, team, goneRecs };
}

// ── 받아 둔 것 ──
const FRESH_MS = 30_000;
let got: { apps: BApp[]; me: { id: string; name: string }; at: number } | null = null;
let failed = false;   // 마지막으로 받기가 실패했다(받아 둔 것이 있으면 그것을 그대로 쓴다)
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
/** 받아 둔 재료로 지금의 세 묶음 — 아직 한 번도 못 받았으면 null(그리는 쪽은 «불러오는 중»). */
export function builderModelNow(env: Pick<BuilderEnv, 'projects' | 'sessions' | 'sessionsReady'>): BuilderModel | null {
  return got ? buildModel(got.apps, got.me, env) : null;
}
/** 한 번도 못 받았고 마지막 받기가 실패했다 — 그리는 쪽은 «불러오는 중» 대신 그렇다고 말한다. */
export function builderModelFailed(): boolean { return !got && failed; }
/** 앱 목록 · 나를 새로 받는다. force 가 아니면 30초 안에 받은 것은 그대로 쓴다. 받으면 듣는 쪽(사이드바)에 알린다.
 *  받기가 실패하면 받아 둔 것을 그대로 둔다(빈 목록으로 덮지 않는다 · 받은 때도 그대로라 다음 그리기에서 다시 받는다).
 *  force 인데 이미 받는 중이면 그 받기가 끝난 뒤 한 번 더 받는다 — 방금 바꾼 것(지우기 · 공개)이 그 전 받기에 안 들었을 수 있다. */
export function refreshBuilderModel(force = false): Promise<void> {
  if (!force && got && Date.now() - got.at < FRESH_MS) return Promise.resolve();
  if (inflight) return force ? inflight.then(() => refreshBuilderModel(true)) : inflight;
  inflight = Promise.all([fetchApps(), studioMe()]).then(([apps, me]) => {
    if (!apps) { failed = true; if (got) return; }
    else { failed = false; got = { apps, me, at: Date.now() }; }
    for (const f of listeners) { try { f(); } catch (_) { /* 한 쪽이 깨져도 다른 쪽은 그린다 */ } }
  }).finally(() => { inflight = null; });
  return inflight;
}
/** 새로 받았을 때 부를 함수 — 사이드바가 건다. */
export function onBuilderModel(fn: () => void): void { listeners.add(fn); }
