// context-collectors.ts — 수집기 관리(#1419 T1·T2·T3). [맥락 관리 ▸ 수집기] 화면.
//
//  구 [설정 ▸ 외부 자료 수집](admin-connectors.ts)과의 차이: 저것은 **커넥터 종류 목록**이었다(슬랙 칸 하나,
//  노션 칸 하나 — 고정된 7줄). 여기는 **내가 가진 수집기 목록**이다. 같은 슬랙으로 셋을 만들 수 있고,
//  각자 자기 계정·범위·주기·산출정책을 갖는다. 그래서 화면 문법도 '설정 폼'이 아니라 '목록 + 만들기'다.
//
//  ── 비개발자 기준 개편(#3830, 2026-09-10 원준) ──────────────────────────────────────────
//  원문: "수집기 창이 너무 어려워서 … 어려운 설정들은 전부 고급설정에 · 리브가 자동으로 만들어준 건 따로 표시 ·
//   <수집기>라는 워딩이 한군데에도 없어서 저 카드 하나하나가 수집기라는 느낌이 안 든다 · 설정 열기 했을 때
//   실제로 바꿀 필요가 있는 것만 보여주고 나머지는 리브가 자동으로 설정했다".
//   ① 목록은 **한 상자 안의 행**(리스트 문법, DS §6.6) — 카드 8장이 따로 떠 있던 것을 접는다. 행마다 서비스
//      로고 + 이름 + 「Notion 수집기」 한 줄. '수집기'라는 말이 행마다 선다.
//   ② **리브가 만든 수집기** 표식 — 판정은 `config.token_source`(외부 앱 연결이 금고를 가리키며 만든 흔적)다.
//      note 문구가 아니라 데이터로 판정한다(문구는 바뀐다).
//   ③ 개발자 어휘를 화면에서 걷는다 — 「토큰 0/1 등록」「기본」「collector-1」은 사람에게 뜻이 없다. 토큰은
//      **문제일 때만**(직접 만든 수집기인데 토큰이 하나도 없을 때) 경고 한 줄로 말한다.
//   ④ 설정은 **기본 설정**(이름 · 무엇을 모을지 · 얼마나 자주)과 **고급 설정**(접힘 — 토큰 출처·식별자·산출
//      정책·API 버전…)으로 가른다. 어느 칸이 기본인지는 아래 `isBasicField` 한 자리가 정한다.
//   ⑤ 켜고 끄기는 스위치 하나(DS §6.4 — 같은 화면에서 스위치와 켜기/끄기 버튼을 섞지 않는다).
import { api, busy, el, relTime, sv, toast, uiText } from './core.js';
import { confirmDialog } from './admin.js';
import { overlay } from './ui-primitives.js';
import { stageJobCard } from './context-stage-job.js';   // 단계 공용 '언제 도나' 카드(#1618)
import { presetSvcKey, svcTile } from './svc-icons.js';

let editingId: number | null = null;
let creatingPreset: string | null = null;   // 프리셋을 고른 뒤 생성 폼
let choosingPreset = false;

/** 리브(외부 앱 연결)가 만든 수집기인가 — 토큰을 금고에서 가져오도록 배선된 흔적이 곧 판정이다. */
function isLivMade(c: any): boolean {
  return !!String(c?.config?.token_source ?? '').trim();
}

/** 외부 앱 연결 화면의 그 앱 상세 — 리브가 만든 수집기의 「연결 관리」가 가리키는 자리. */
function connectHref(presetKey: string): string {
  const k = String(presetKey || '');
  const app = k === 'gdrive' || k === 'gmail' ? 'google' : k;
  return '#/connect/' + encodeURIComponent(app);
}

function intervalLabel(sec: number): string {
  const s = Number(sec) || 600;
  return s >= 86400 ? `${Math.round(s / 86400)}일마다`
    : s >= 3600 ? `${Math.round(s / 3600)}시간마다`
    : `${Math.max(1, Math.round(s / 60))}분마다`;
}

export async function renderCollectors(host: HTMLElement): Promise<void> {
  busy(host, el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '수집기를 불러오는 중…' })));
  let d: any;
  try { d = await api('/api/ui/org/collectors'); }
  catch (e) {
    host.replaceChildren(el('div', { class: 'card' },
      el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + (e as Error).message })));
    return;
  }
  const collectors: any[] = d.collectors || [];
  const presets: any[] = (d.presets || []).filter((p: any) => p.enabled !== false);
  // 편집 가능 여부는 **서버 판정을 그대로 받는다**(scope 를 프론트가 재해석하지 않는다) — 어긋나면
  //  버튼은 있는데 눌러야 403 이 나고, 사용자는 '고장'으로 읽는다.
  const canEdit = !!d.canEdit;
  const reload = () => { void renderCollectors(host); };

  const body = el('div', { class: 'cxc' });

  // ── 머리 — 「수집기 n개」 + 만들기. 설명은 한 줄: 대부분은 리브가 만들어 두고, 직접 만드는 건 토큰을 손으로 넣을 때다. ──
  const head = el('div', { class: 'cxc-head' },
    el('div', { class: 'cxc-head-main' },
      el('h3', { class: 'cxc-title' }, el('span', { text: '수집기' }), el('span', { class: 'cxc-title-n num', text: String(collectors.length) })),
      el('p', { class: 'cxc-lead' }, ...uiText(canEdit
        ? '외부 앱을 연결하면 리브가 수집기를 자동으로 만들어 둡니다. 직접 만드는 것은 토큰을 손으로 넣어 붙일 때뿐입니다.'
        : '외부 앱을 연결하면 리브가 수집기를 자동으로 만들어 둡니다. 만들고 고치는 것은 관리자가 합니다 — 무엇이 언제 모이는지는 여기서 그대로 보입니다.'))));
  if (canEdit) {
    const add = el('button', { class: 'btn btn-primary', type: 'button', text: '+ 수집기 만들기' });
    add.addEventListener('click', () => { choosingPreset = true; creatingPreset = null; editingId = null; reload(); });
    head.append(el('div', { class: 'cxc-head-acts' }, add));
  } else {
    head.append(el('div', { class: 'cxc-head-acts' }, el('span', { class: 'cxc-ro', text: '읽기 전용' })));
  }
  body.append(head);

  // 만들기 흐름은 목록 **위**에 선다 — 스크롤 끝에 붙이면 버튼을 눌렀는데 아무 일도 안 일어난 것처럼 보인다.
  if (canEdit && choosingPreset) body.append(presetChooser(presets, reload));
  else if (canEdit && creatingPreset) {
    const p = presets.find((x) => x.key === creatingPreset);
    if (p) body.append(el('div', { class: 'cxc-list' }, collectorEditor(null, presets, reload, p)));
    else creatingPreset = null;
  }

  // ── 목록 — 한 상자. 첫 행은 '내 컴퓨터'(#1881 L5: 수집기 인스턴스가 아니라 올리는 순간이 곧 수집). ──
  const list = el('div', { class: 'cxc-list' });
  list.append(await localRow());
  if (!collectors.length) {
    list.append(el('div', { class: 'cxc-empty' },
      el('p', { class: 'cxc-empty-t', text: '아직 수집기가 없습니다' }),
      el('p', { class: 'cxc-empty-d', text: canEdit
        ? '[외부 앱 연결]에서 슬랙·노션 같은 앱을 연결하면 리브가 첫 수집기를 만들어 둡니다.'
        : '외부 앱이 아직 연결되지 않았습니다. 연결은 관리자가 합니다 — 필요한 앱이 있으면 관리자에게 요청하세요.' }),
      canEdit ? el('a', { class: 'btn btn-ghost btn-sm', href: '#/connect', text: '외부 앱 연결 열기 →' }) : null));
  }
  for (const c of collectors) {
    list.append(collectorRow(c, presets, reload, canEdit));
  }
  body.append(list);

  host.replaceChildren(body);
  // '언제 도나'(#1618) — 이 단계만 잡을 스스로 소유한다(수집기를 켜면 syncCollectorJob 이 크론을 만들고
  //  켠다). 그래서 만들기 버튼은 주지 않되, **주기·지금 실행·마지막 실행 결과**는 다른 세 단계와 같은
  //  자리·같은 말로 보여 준다 — 네 단계의 실행 상태를 같은 시각 언어로 읽을 수 있어야 '어디가 막혔나'가
  //  단계를 오가며 비교된다. host 교체 뒤 비동기로 붙인다(크론 조회 403 이 이 탭을 막지 않게).
  body.append(await stageJobCard({
    stage: '수집',
    actions: ['connector_sync'],
    // ⚠ id 로 한 번 더 거른다 — `connector_sync` 를 쓰는 잡이 두 계보다. 수집기 소유(`collector-<id>`)와
    //  구 커넥터 축(`sync-<system>`). 후자를 집으면 이 카드가 엉뚱한 잡을 가리키고, 켜기 버튼이 봉인된
    //  잡을 되살린다 — sync-clickup 은 커넥터가 꺼진 채 홀로 돌며 사람이 지운 리스트를 4분마다 되살린
    //  전력으로 비활성해 둔 것이다(#1534). 실제로 이 필터 없이 짰더니 화면이 정확히 그걸 집었다.
    matchId: (id) => id.startsWith('collector-'),
    readOnly: true,   // 잡의 주인은 수집기(enabled → syncCollectorJob). 여기서 켜고 끄면 주인과 어긋난다.
    missingLine: '자동 수집이 아직 없습니다 — 켜진 수집기가 없기 때문입니다.',
    managedElsewhere: '수집기를 켜면 그 수집기의 자동 수집이 함께 켜지고, 끄면 같이 멈춥니다.',
    unitName: '수집기',
  }, reload));
}

// ── '내 컴퓨터' 행(#1881 L5) — 로컬 업로드가 자료로 쌓이는 현황. 만들 것도 켤 것도 없다. ──
//  숫자 셋: 자료 n건(source_list kind=local_file total) · 마지막 접수 · 읽지 않은 폴더(local 채널 중 미증류 남은 것).
async function localRow() {
  let meta = '파일이나 폴더를 자료 칸·세션 입력창에 끌어다 놓으면 그대로 자료가 됩니다.';
  let folders = '';
  try {
    const [src, ch] = await Promise.all([
      api('/api/ui/sources?kind=local_file&limit=1'),
      api('/api/ui/org/source-channels?limit=200'),
    ]);
    const total = Number(src?.total || 0);
    const last = src?.entries?.[0]?.updated_at ? relTime(src.entries[0].updated_at) : null;
    const undone = (ch?.channels || []).filter((c: any) => c.kind === 'local_file' && Number(c.undistilled) > 0);
    if (total > 0) {
      meta = `자료 ${total.toLocaleString()}건` + (last ? ` · 마지막 접수 ${last}` : '');
      if (undone.length) folders = `아직 읽지 않은 폴더 ${undone.length}개 — ` + undone.slice(0, 3).map((c: any) => `${c.channel ?? '(폴더 없음)'} ${c.undistilled}건`).join(' · ') + (undone.length > 3 ? ' …' : '');
    }
  } catch { /* 조회 실패 — 안내 문구만 남긴다 */ }
  const tile = el('span', { class: 'svc-tile cxc-tile cxc-tile-local', 'aria-hidden': 'true' }, computerIcon());
  return el('div', { class: 'cxc-row cxc-row-local' },
    tile,
    el('div', { class: 'cxc-main' },
      el('div', { class: 'cxc-t' }, el('span', { class: 'cxc-name', text: '내 컴퓨터' }),
        el('span', { class: 'cxc-state is-on' }, el('span', { class: 'cxc-state-dot', 'aria-hidden': 'true' }), el('span', { text: '올리는 순간 수집' }))),
      el('div', { class: 'cxc-m', text: meta }),
      folders ? el('div', { class: 'cxc-m', text: folders }) : null));
}

// ── 수집기 행 — 이름·상태 한 줄 + 「Notion 수집기 · 리브가 만듦 · 10분마다 · 마지막 수집」 한 줄. 편집 중이면 아래로 펼쳐진다. ──
function collectorRow(c: any, presets: any[], reload: () => void, canEdit: boolean) {
  const row = el('div', { class: 'cxc-row' + (c.enabled ? '' : ' is-off') + (editingId === c.id ? ' is-editing' : '') });
  const liv = isLivMade(c);
  const svc = presetSvcKey(c.preset_key);
  const tile = svcTile(svc, c.preset_label || c.preset_key, true);
  tile.classList.add('cxc-tile');

  // 제목 줄 — 이름 + 상태(점+말). 색만으로 말하지 않는다(DS §8).
  const title = el('div', { class: 'cxc-t' },
    el('span', { class: 'cxc-name', text: c.label || c.key }),
    el('span', { class: 'cxc-state' + (c.enabled ? ' is-on' : '') },
      el('span', { class: 'cxc-state-dot', 'aria-hidden': 'true' }), el('span', { text: c.enabled ? '켜짐' : '꺼짐' })));

  // 정체 줄 — 이것이 무엇인지: 「Notion 수집기」 + 누가 만들었나 + 주기 + 마지막 수집.
  const who = liv
    ? el('span', { class: 'cxc-liv', title: '외부 앱을 연결할 때 리브가 자동으로 만들었습니다' }, livIcon(), el('span', { text: '리브가 만듦' }))
    : el('span', { class: 'cxc-who', text: '직접 만듦' });
  const meta = el('div', { class: 'cxc-m' },
    el('span', { class: 'cxc-kind', text: `${c.preset_label || c.preset_key} 수집기` }),
    who,
    el('span', { class: 'cxc-sep', 'aria-hidden': 'true', text: '·' }),
    el('span', { text: c.enabled ? `${intervalLabel(c.sync_interval_sec)} 자동 수집` : `켜면 ${intervalLabel(c.sync_interval_sec)} 자동 수집` }),
    el('span', { class: 'cxc-sep', 'aria-hidden': 'true', text: '·' }),
    lastRunText(c));

  // 문제 줄 — **문제일 때만**. 직접 만든 수집기인데 토큰이 하나도 없으면 돌 수 없다(리브가 만든 것은 연결의 토큰을 쓰므로 해당 없음).
  const secTotal = (c.fields || []).filter((f: any) => f.secret).length;
  const secSet = Object.values(c.secretsSet || {}).filter(Boolean).length;
  let issue: HTMLElement | null = null;
  if (!liv && secTotal > 0 && secSet === 0) {
    issue = el('div', { class: 'cxc-issue' }, warnIcon(), el('span', { text: '접속 토큰이 없어 수집할 수 없습니다 — [설정]에서 넣어 주세요.' }));
  } else if (c.last_run && c.last_run.status !== 'ok' && c.last_run.status !== 'running') {
    const link = el('button', { class: 'btn-text', type: 'button', text: '기록 보기' });
    link.addEventListener('click', () => openRunLog(c, c.last_run.id));
    issue = el('div', { class: 'cxc-issue' }, warnIcon(), el('span', { text: '마지막 수집이 실패했습니다.' }), link);
  }

  const main = el('div', { class: 'cxc-main' }, title, meta, issue);
  row.append(tile, main);

  // 읽는 사람에게는 여기서 끝 — 상태·주기·마지막 수집까지가 '무엇이 언제 모이나'의 전부다.
  if (!canEdit) return row;

  const acts = el('div', { class: 'cxc-acts' });
  const sw = el('input', { type: 'checkbox', class: 'cxc-sw', role: 'switch', 'aria-label': `${c.label || c.key} 켜기` }) as HTMLInputElement;
  sw.checked = !!c.enabled;
  sw.addEventListener('change', async () => {
    const next = sw.checked;
    sw.disabled = true;
    try {
      await api('/api/ui/org/collectors', { method: 'POST', body: JSON.stringify({ id: c.id, enabled: next }) });
      toast(next ? `켰습니다 — ${intervalLabel(c.sync_interval_sec)} 자동으로 모읍니다` : '껐습니다'); reload();
    } catch (e) { toast((e as Error).message, true); sw.checked = !next; sw.disabled = false; }
  });
  const sync = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '지금 수집' });
  sync.addEventListener('click', async () => {
    try {
      const r = await api(`/api/ui/org/collectors/${c.id}/sync`, { method: 'POST', body: '{}' });
      toast(r.already_running ? '이미 수집하는 중입니다' : '수집을 시작했습니다');
      openRunLog(c, r.run_id);
    } catch (e) { toast('실패 — ' + (e as Error).message, true); }
  });
  const edit = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: editingId === c.id ? '닫기' : '설정', 'aria-expanded': String(editingId === c.id) });
  edit.addEventListener('click', () => { editingId = editingId === c.id ? null : c.id; creatingPreset = null; choosingPreset = false; reload(); });
  acts.append(sw, sync, edit);
  row.append(acts);

  if (editingId === c.id) row.append(collectorEditor(c, presets, reload));
  return row;
}

function lastRunText(c: any): HTMLElement {
  if (!c.last_run) return el('span', { text: '아직 수집한 적 없음' });
  const st = c.last_run.status;
  const when = relTime(c.last_run.started_at);
  return el('span', { text: st === 'running' ? '지금 수집하는 중' : st === 'ok' ? `마지막 수집 ${when}` : `마지막 시도 ${when}` });
}

/** 프리셋 고르기 — 만들기의 첫 화면. 내장과 커스텀을 갈라 보여 준다. */
function presetChooser(presets: any[], reload: () => void) {
  const card = el('div', { class: 'cxc-list cxc-chooser' });
  const builtin = presets.filter((p) => p.builtin);
  const custom = presets.filter((p) => !p.builtin);

  const grid = (list: any[]) => {
    const g = el('div', { class: 'cxc-preset-grid' });
    for (const p of list) {
      const b = el('button', { class: 'cxc-preset', type: 'button' });
      const tile = svcTile(presetSvcKey(p.key), p.label, true); tile.classList.add('cxc-tile');
      b.append(tile,
        el('span', { class: 'cxc-preset-x' },
          el('span', { class: 'cxc-preset-t', text: p.label }),
          el('span', { class: 'cxc-preset-d', text: p.description || driverHint(p.driver) || '토큰을 넣어 직접 붙입니다' })));
      b.addEventListener('click', () => { creatingPreset = p.key; choosingPreset = false; reload(); });
      g.append(b);
    }
    return g;
  };

  const cancel = el('button', { class: 'btn-text', type: 'button', text: '취소' });
  cancel.addEventListener('click', () => { choosingPreset = false; reload(); });
  card.append(el('div', { class: 'cxc-chooser-head' },
    el('div', {}, el('b', { class: 'cxc-chooser-t', text: '어느 앱의 수집기를 만들까요?' }),
      el('p', { class: 'cxc-lead' }, ...uiText('이미 [외부 앱 연결]에서 연결한 앱이라면 거기서 「자료 가져오기」를 켜는 쪽이 쉽습니다 — 토큰 없이 리브가 만들어 둡니다.'))),
    cancel));
  if (builtin.length) card.append(el('p', { class: 'cxc-sub', text: '기본 제공' }), grid(builtin));
  if (custom.length) card.append(el('p', { class: 'cxc-sub', text: '직접 정의한 방식' }), grid(custom));
  card.append(el('p', { class: 'cxc-foot' },
    el('span', { text: '찾는 앱이 없나요? ' }),
    el('a', { href: '#/context/sources/presets', text: '사내 API·RSS·웹훅을 코드 없이 새 방식으로 정의 →' })));
  return card;
}

function driverHint(driver: string): string {
  return driver === 'http' ? '사내 API 를 직접 정의한 방식'
    : driver === 'rss' ? 'RSS·Atom 피드'
    : driver === 'webhook' ? '외부에서 밀어 넣는 방식'
    : driver === 'clone' ? '기본 제공을 변형한 템플릿' : '';
}

/**
 * 「무엇을 모을지」에 해당하는 칸 — 비개발자가 실제로 만지는 유일한 설정이라 기본 설정에 선다.
 *  프리셋 정의(src/connectors/config.ts)에 그룹 표식이 없어 여기서 키로 고른다. 새 프리셋에 범위 칸이 생기면 여기에 더한다.
 */
const SCOPE_KEYS = new Set([
  'channels', 'noise_exclude',                         // slack · discord
  'root_pages', 'exclude_pages',                        // notion
  'include_list_ids', 'exclude_list_ids',               // clickup
  'repos', 'projects', 'teams',                         // github · gitlab · linear
  'file_keys', 'team_ids', 'exclude_files',             // figma
  'folders', 'query',                                   // gdrive · gmail
]);

/** 기본 설정 칸의 사람 말 — 서버 힌트는 개발자용으로 길다(노션 루트 페이지 힌트 90자). 기본 칸에는 이름·자리표시자를 짧게 다시 쓴다. */
const FRIENDLY: Record<string, { label?: string; ph?: string; hint?: string }> = {
  channels: { label: '모을 채널', ph: '비우면 전체 — 채널 이름을 쉼표로 구분', },
  noise_exclude: { label: '빼는 채널', ph: '예: alerts, monitoring' },
  root_pages: { label: '모을 페이지', ph: '비우면 연결할 때 고른 페이지 전부', hint: '여기 적은 페이지와 그 아래 페이지만 모읍니다.' },
  exclude_pages: { label: '빼는 페이지', ph: '비우면 없음', hint: '여기 적은 페이지와 그 아래는 모으지 않습니다.' },
  include_list_ids: { label: '모을 리스트', ph: '비우면 전체' },
  exclude_list_ids: { label: '빼는 리스트', ph: '비우면 없음' },
  repos: { label: '저장소', ph: 'owner/repo 또는 주소 — 여러 개면 공백으로 구분' },
  projects: { label: '프로젝트', ph: 'group/project 또는 주소 — 여러 개면 공백으로 구분' },
  teams: { label: '팀', ph: '비우면 워크스페이스 전체 — 팀 키를 공백으로 구분' },
  file_keys: { label: '파일', ph: '피그마 파일 주소를 그대로 붙여넣기 — 여러 개면 공백으로 구분' },
  team_ids: { label: '팀', ph: 'figma.com/files/team/<여기>/… 주소의 팀 id' },
  exclude_files: { label: '빼는 파일', ph: '이름에 이 말이 들어간 파일은 건너뜀 — 예: archive' },
  folders: { label: '모을 폴더', ph: '비우면 드라이브 전체 — 폴더 id 를 쉼표로 구분' },
  query: { label: '검색 조건', ph: '비우면 전체 — Gmail 검색식 그대로(예: -from:noreply)' },
};

/** 기본 설정에 보일 칸인가. 나머지는 전부 고급 설정으로 — 리브가 정해 둔 값을 굳이 보여 주지 않는다. */
function isBasicField(f: any, opts: { liv: boolean; builtin: boolean }): boolean {
  if (!opts.builtin) return true;                       // 직접 정의한 방식은 칸 전부가 사람이 만든 것
  if (f.key === 'token_source') return false;
  if (f.picker || SCOPE_KEYS.has(f.key)) return true;
  if (f.secret) return !opts.liv;                       // 토큰 — 직접 만든 수집기에서만 기본(없으면 못 돈다)
  if (f.required) return !opts.liv;                     // 필수 평문(OAuth Client ID 등) — 같은 이유
  return false;
}

/** 편집기 — 만들기와 수정이 같은 폼(다른 것은 프리셋 고정 여부뿐). 행 아래로 펼쳐진다. */
function collectorEditor(c: any | null, presets: any[], reload: () => void, newPreset?: any) {
  const isNew = !c;
  const preset = newPreset ?? presets.find((p) => p.key === c.preset_key) ?? { key: c?.preset_key, label: c?.preset_label, fields: c?.fields ?? [], guide: c?.guide, builtin: true };
  const liv = !isNew && isLivMade(c);
  const builtin = preset.builtin !== false;
  const box = el('div', { class: 'cxc-editor' });

  const F = (label: string, hint: string | null, ctrl: any) => el('div', { class: 'cxc-field' },
    el('label', { class: 'cxc-label', text: label }),
    ctrl,
    hint ? el('p', { class: 'cxc-hint', text: hint }) : null);

  const labelIn = el('input', { type: 'text', class: 'cxc-in', value: c?.label ?? '',
    placeholder: isNew ? `${preset.label} — 예: 제품팀 채널` : '' }) as HTMLInputElement;
  const keyIn = el('input', { type: 'text', class: 'cxc-in', value: c?.key ?? '',
    placeholder: '비우면 자동으로 만듭니다', ...(isNew ? {} : { disabled: true }) }) as HTMLInputElement;
  const enabledChk = el('input', { type: 'checkbox' }) as HTMLInputElement;
  enabledChk.checked = true;

  // 설정 필드 — 프리셋이 정한다(시크릿은 값 비노출, 빈 값 = 미변경). 기본/고급으로 가른다.
  const inputs: Record<string, { el: HTMLInputElement; secret: boolean }> = {};
  const basicEls: any[] = [], advEls: any[] = [];
  for (const f of (preset.fields || [])) {
    const isSet = c?.secretsSet?.[f.key];
    const basic = isBasicField(f, { liv, builtin });
    const fr = (basic && FRIENDLY[f.key]) || {};
    const inp = el('input', {
      type: 'text', class: 'cxc-in',
      value: f.secret ? '' : (c?.config?.[f.key] ?? ''),
      // 고급 칸은 힌트가 아래에 서므로 자리표시자를 비운다(같은 문장이 칸 안팎에 두 번 서지 않게).
      placeholder: f.secret ? (isSet ? '● 설정됨 — 바꿀 때만 입력' : (f.hint || '')) : basic ? (fr.ph ?? f.hint ?? '') : '',
      ...(f.secret ? { class: 'cxc-in secret-input', autocomplete: 'off', spellcheck: 'false' } : {}),
    }) as HTMLInputElement;
    inputs[f.key] = { el: inp, secret: !!f.secret };
    // 픽커 지원 필드(노션 페이지·클릭업 리스트) — 저장된 수집기에서만 조회할 수 있다(토큰이 있어야 하므로).
    //  값은 id 나열이라 사람에게는 **이름 칩**으로 보인다(#3830 — 「32da9ddde7768…」를 비개발자가 읽을 수 없다).
    const ctrl = (f.picker && c) ? pickChips(c, f, inp, fr.ph ?? '', String(fr.label ?? f.label ?? '항목').split(' ').pop() || '항목') : inp;
    // 기본 칸의 힌트는 자리표시자가 이미 말한다 — 같은 문장을 두 번 적지 않는다(FRIENDLY 가 한 줄 더 주면 그것만).
    //  고급 칸은 서버 힌트를 아래에 둔다(개발자가 읽을 자리).
    const node = F((fr.label ?? f.label ?? f.key) + (f.required && basic ? ' *' : ''), basic ? (fr.hint ?? null) : (f.secret ? null : (f.hint ?? null)), ctrl);
    (basic ? basicEls : advEls).push(node);
  }

  // 주기
  const intervalSel = el('select', { class: 'cxc-in' }) as HTMLSelectElement;
  for (const [v, t] of [[300, '5분마다'], [600, '10분마다'], [1800, '30분마다'], [3600, '1시간마다'], [21600, '6시간마다'], [86400, '하루에 한 번']] as Array<[number, string]>) {
    intervalSel.append(el('option', { value: String(v), text: t }));
  }
  intervalSel.value = String(c?.sync_interval_sec ?? 600);

  // 산출 정책(T3) — 고급. 기본값이면 사람이 알 필요가 없다.
  const outSel = el('select', { class: 'cxc-in' }) as HTMLSelectElement;
  outSel.append(el('option', { value: 'preset', text: '기본 — 이 앱에 맞는 방식으로(리브가 정합니다)' }));
  outSel.append(el('option', { value: 'source', text: '자료로 저장 — 증류기가 골라 지식으로' }));
  outSel.append(el('option', { value: 'knowledge', text: '지식 직행 — 가져오는 즉시 지식으로' }));
  outSel.append(el('option', { value: 'both', text: '둘 다 — 원문을 남기면서 지식도' }));
  outSel.value = c?.output_mode ?? 'preset';
  const catIn = el('input', { type: 'text', class: 'cxc-in',
    value: (c?.output_config?.target_category as string) ?? '', placeholder: '비우면 분류기가 정합니다' }) as HTMLInputElement;
  const catField = F('지식 분류 고정', '지식 직행일 때, 만들어진 지식을 항상 이 분류에 넣습니다.', catIn);
  const syncCatVis = () => { catField.hidden = outSel.value !== 'knowledge' && outSel.value !== 'both'; };
  outSel.addEventListener('change', syncCatVis); syncCatVis();

  const noteIn = el('input', { type: 'text', class: 'cxc-in', value: c?.note ?? '', placeholder: '선택 사항' }) as HTMLInputElement;

  // ── 머리 — 무엇의 설정인가 + (리브가 만든 것이면) 어디서 왔는지. ──
  box.append(el('div', { class: 'cxc-ed-head' },
    el('b', { class: 'cxc-ed-t', text: isNew ? `새 수집기 — ${preset.label}` : '수집기 설정' })));
  if (liv) {
    box.append(el('div', { class: 'cxc-note' },
      livIcon(),
      el('div', {},
        el('p', {}, ...uiText(`리브가 [외부 앱 연결 ▸ ${preset.label}]에서 연결할 때 자동으로 만든 수집기입니다. 계정과 토큰은 그 연결을 그대로 쓰므로 여기서 넣을 것이 없습니다.`)),
        el('a', { class: 'btn btn-ghost btn-sm', href: connectHref(c.preset_key), text: '연결 관리 →' }))));
  } else if (preset.guide?.steps?.length) {
    // 토큰 발급 안내 — 직접 만드는 사람 기준. 이미 토큰이 있으면 접어 둔다.
    const hasToken = Object.values(c?.secretsSet ?? {}).some(Boolean);
    const guideEl = el('details', { class: 'cxc-guide', ...(hasToken ? {} : { open: '' }) },
      el('summary', { text: `${preset.label} 토큰 발급 방법` }));
    if (preset.guide.intro) guideEl.append(el('p', { class: 'cxc-guide-p', text: preset.guide.intro }));
    const ol = el('ol', { class: 'cxc-guide-steps' });
    for (const st of preset.guide.steps) ol.append(el('li', { text: st }));
    guideEl.append(ol);
    if (preset.guide.url) {
      guideEl.append(el('p', {}, el('a', { class: 'btn btn-ghost btn-sm', href: preset.guide.url, target: '_blank', rel: 'noopener noreferrer', text: '발급 페이지 열기 ↗' })));
    }
    box.append(guideEl);
  }

  // ── 기본 설정 — 이름 · 무엇을 · 얼마나 자주. ──
  const basic = el('div', { class: 'cxc-sec' },
    el('p', { class: 'cxc-sub', text: '기본 설정' }),
    F('이름', null, labelIn),
    ...basicEls,
    F('얼마나 자주', '자주 가져올수록 최신이지만 외부 서비스 호출도 늘어납니다.', intervalSel),
    isNew ? el('label', { class: 'cxc-check' }, enabledChk, ' 만들자마자 켜기 — 위 주기로 자동 수집합니다') : null);
  box.append(basic);

  // ── 고급 설정 — 접힘. 리브가 정해 둔 것들. ──
  const adv = el('details', { class: 'cxc-adv' },
    el('summary', {},
      el('span', { class: 'cxc-adv-t', text: '고급 설정' }),
      el('span', { class: 'cxc-adv-d', text: liv ? '리브가 알맞게 정해 두었습니다 — 보통은 바꿀 일이 없습니다.' : '보통은 바꿀 일이 없습니다.' })));
  const advBody = el('div', { class: 'cxc-adv-body' },
    ...advEls,
    F('수집 결과', '가져온 내용을 자료로 쌓을지, 바로 지식으로 만들지 정합니다.', outSel),
    catField,
    F('식별자', isNew ? '영문·숫자 슬러그. 비우면 자동으로 만듭니다.' : '만든 뒤에는 바꾸지 않습니다.', keyIn),
    F('메모', null, noteIn));
  adv.append(advBody);
  box.append(adv);

  // ── 발치 — 저장 · 닫기 · (저장된 것이면) 미리보기 · 실행 기록 · 삭제. ──
  const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', text: isNew ? '수집기 만들기' : '저장' }) as HTMLButtonElement;
  saveBtn.addEventListener('click', async () => {
    const config: Record<string, string> = {}, secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(inputs)) {
      if (v.secret) { if (v.el.value) secrets[k] = v.el.value; }
      else config[k] = v.el.value.trim();
    }
    // 필수값 검사는 저장 전에 — 서버 오류로 알게 하지 않는다(비개발자 화면 요구).
    //  리브가 만든 수집기는 토큰이 금고에 있으므로 시크릿 필수 검사를 건너뛴다(칸이 고급에 접혀 있고 비어 있는 게 정상).
    const missing = liv ? [] : (preset.fields || []).filter((f: any) =>
      f.required && !(f.secret ? (secrets[f.key] || c?.secretsSet?.[f.key]) : config[f.key]));
    if (missing.length) { toast(`${missing.map((f: any) => f.label || f.key).join(', ')} 을(를) 입력하세요`, true); adv.open = true; return; }

    saveBtn.disabled = true; saveBtn.textContent = '저장 중…';
    try {
      await api('/api/ui/org/collectors', { method: 'POST', body: JSON.stringify({
        ...(c ? { id: c.id } : { preset_key: preset.key }),
        key: keyIn.value.trim() || undefined,
        label: labelIn.value.trim() || null,
        enabled: isNew ? enabledChk.checked : !!c.enabled,
        config, secrets,
        sync_interval_sec: Number(intervalSel.value),
        output_mode: outSel.value,
        output_config: catIn.value.trim() ? { target_category: catIn.value.trim() } : {},
        note: noteIn.value.trim() || null,
      }) });
      toast(isNew ? '수집기를 만들었습니다' : '저장했습니다');
      editingId = null; creatingPreset = null; reload();
    } catch (e) { toast('실패 — ' + (e as Error).message, true); saveBtn.disabled = false; saveBtn.textContent = isNew ? '수집기 만들기' : '저장'; }
  });
  const cancelBtn = el('button', { class: 'btn-text', type: 'button', text: isNew ? '취소' : '닫기' });
  cancelBtn.addEventListener('click', () => { editingId = null; creatingPreset = null; reload(); });

  const foot = el('div', { class: 'cxc-ed-foot' });
  const left = el('div', { class: 'cxc-ed-foot-l' }, saveBtn, cancelBtn);
  if (c) {
    const preview = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '뭐가 모이는지 미리 보기' });
    preview.addEventListener('click', () => openPreview(c));
    const runs = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '수집 기록' });
    runs.addEventListener('click', () => openRuns(c));
    left.append(preview, runs);
  }
  foot.append(left);
  if (c) {
    const del = el('button', { class: 'btn-text btn-text-danger', type: 'button', text: '이 수집기 삭제' });
    del.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: `‘${c.label || c.key}’ 수집기를 삭제할까요?`,
        lines: ['이미 모인 자료와 지식은 그대로 남습니다.',
          liv ? '[외부 앱 연결]에서 「자료 가져오기」를 다시 켜면 리브가 다시 만듭니다.' : '같은 식별자로 다시 만들면 중단된 지점부터 이어서 모읍니다.'],
        confirmText: '삭제', danger: true,
      });
      if (!ok) return;
      try { await api(`/api/ui/org/collectors/${c.id}/remove`, { method: 'POST', body: '{}' }); toast('삭제했습니다'); editingId = null; reload(); }
      catch (e) { toast((e as Error).message, true); }
    });
    foot.append(del);
  }
  box.append(foot);
  return box;
}

// ── 아이콘 — 선 글리프(Feather 계열, DS §6.7). ──
function livIcon(): SVGElement {
  const n = sv('svg', { class: 'cxc-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 12, cy: 12, r: 9 }), sv('circle', { cx: 12, cy: 12, r: 2.5 }));   // 리브 앱 아이콘과 같은 형태(v2/icons liv)
  return n;
}
function warnIcon(): SVGElement {
  const n = sv('svg', { class: 'cxc-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M12 3 2.5 19.5h19z' }), sv('path', { d: 'M12 10v4M12 17.5h.01' }));
  return n;
}
function computerIcon(): SVGElement {
  const n = sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('rect', { x: 3, y: 4.5, width: 18, height: 12, rx: 2 }), sv('path', { d: 'M8 20h8M12 16.5V20' }));
  return n;
}

// ── 픽커 칸(노션 페이지·클릭업 리스트) — 값은 id 나열, 보이는 것은 이름 칩(#3830). ──────────────────
//  이름은 그 수집기의 discover(목록 조회)로 푼다 — [목록에서 고르기]가 이미 부르는 같은 읽기 전용 호출이고, 수집기마다
//  한 번만 부른다. 못 풀면(자격 없음·삭제된 페이지) 짧은 id 칩으로 떨어진다. 원문 칸은 「주소로 직접 넣기」 뒤에 있다.
type PickOpts = Record<string, Array<{ id: string; label: string }>>;
/** null = 목록을 못 받았다(자격 없음·서버 오류) — 「이름이 없다」와 갈라야 화면이 사실대로 말한다. */
const discoverCache = new Map<number, Promise<PickOpts | null>>();
function discoverOptions(c: any): Promise<PickOpts | null> {
  let pr = discoverCache.get(c.id);
  if (!pr) {
    pr = api(`/api/ui/org/collectors/${c.id}/discover`, { method: 'POST', body: '{}' })
      .then((r: any) => (r && r.fields ? r.fields as PickOpts : null)).catch(() => null);
    discoverCache.set(c.id, pr);
  }
  return pr;
}
/** 노션 id 는 대시가 있기도 없기도 하다 — 끝 32자리 16진으로 맞춰 비교한다. */
const normId = (v: string) => { const h = String(v).toLowerCase().replace(/[^0-9a-f]/g, ''); return h.length >= 32 ? h.slice(-32) : String(v).trim(); };

function pickChips(c: any, f: any, inp: HTMLInputElement, emptyText: string, noun: string): HTMLElement {
  const names = new Map<string, string>();
  const chips = el('div', { class: 'cxc-pchips' });
  const why = el('p', { class: 'cxc-pick-why', hidden: true });
  const raw = el('div', { class: 'cxc-pick-raw', hidden: true }, inp);
  const ids = () => String(inp.value || '').split(',').map((x) => x.trim()).filter(Boolean);
  //  이름을 못 풀면 id 조각(「32da9ddd…」)이 아니라 「페이지 1」처럼 센다 — id 는 사람에게 뜻이 없다(툴팁에만 둔다).
  //  주소를 붙여 넣은 값은 주소가 곧 사람이 알아보는 이름이라 그대로 짧게 보인다.
  const shortId = (id: string, i: number) => /^https?:/i.test(id)
    ? id.replace(/^https?:\/\//i, '').slice(0, 36) + (id.length > 44 ? '…' : '')
    : `${noun} ${i + 1}`;
  const paint = () => {
    const list = ids();
    chips.replaceChildren();
    if (!list.length) { chips.append(el('span', { class: 'cxc-pchips-empty', text: emptyText || '비어 있음' })); return; }
    for (const [i, id] of list.entries()) {
      const label = names.get(normId(id));
      const rm = el('button', { class: 'cxc-pchip-x', type: 'button', 'aria-label': (label || '이 항목') + ' 빼기', text: '×' });
      rm.addEventListener('click', () => {
        inp.value = ids().filter((x) => x !== id).join(',');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        paint();
      });
      chips.append(el('span', { class: 'cxc-pchip' + (label ? '' : ' is-raw'), title: label ? id : '이름을 찾지 못했습니다 — ' + id },
        el('span', { class: 'cxc-pchip-t', text: label || shortId(id, i) }), rm));
    }
  };
  paint();
  void discoverOptions(c).then((fields) => {
    for (const o of ((fields && fields[f.key]) || [])) names.set(normId(o.id), o.label);
    if (!fields && ids().length) {
      why.textContent = `${c.preset_label || '외부 앱'}에서 ${noun} 이름을 불러오지 못해 번호로 보입니다 — 연결이 끊겼을 수 있습니다. 위 [연결 관리]에서 확인하세요.`;
      why.hidden = false;
    }
    paint();
  });
  const pick = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '목록에서 고르기' });
  pick.addEventListener('click', () => openScopePicker(c, f, inp, (picked) => { for (const o of picked) names.set(normId(o.id), o.label); paint(); }));
  const rawBtn = el('button', { class: 'btn-text', type: 'button', text: '주소로 직접 넣기' });
  rawBtn.addEventListener('click', () => {
    raw.hidden = !raw.hidden;
    rawBtn.textContent = raw.hidden ? '주소로 직접 넣기' : '주소 칸 닫기';
    if (!raw.hidden) inp.focus();
  });
  inp.addEventListener('change', paint);
  return el('div', { class: 'cxc-pick' }, chips, why, el('div', { class: 'cxc-pick-acts' }, pick, rawBtn), raw);
}

// ── 보조 오버레이 ──────────────────────────────────────────────────────────
async function openScopePicker(c: any, f: any, inp: HTMLInputElement, onApply?: (picked: Array<{ id: string; label: string }>) => void) {
  const box = el('div', {}, el('p', { class: 'admin-hint', text: '목록을 불러오는 중…' }));
  const back = overlay(`${f.label || f.key} — 목록에서 고르기`, box);
  try {
    const r = await api(`/api/ui/org/collectors/${c.id}/discover`, { method: 'POST', body: '{}' });
    const opts: any[] = (r.fields && r.fields[f.key]) || [];
    if (!opts.length) { box.replaceChildren(el('p', { class: 'admin-hint', text: r.note || '고를 항목이 없습니다 — 직접 입력하세요.' })); return; }
    const selected = new Set(String(inp.value || '').split(',').map(normId).filter(Boolean));
    const checks = new Map<string, HTMLInputElement>();
    const rows = opts.map((o) => {
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = selected.has(normId(o.id));
      checks.set(o.id, cb);
      return el('label', { class: 'ctx-pick-item' }, cb, el('span', { text: o.label }));
    });
    const apply = el('button', { class: 'btn btn-primary btn-sm', text: '적용' });
    apply.addEventListener('click', () => {
      inp.value = [...checks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id).join(',');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      onApply?.(opts.filter((o) => checks.get(o.id)?.checked).map((o) => ({ id: String(o.id), label: String(o.label) })));
      back.remove();
      toast('골랐습니다 — [저장]을 눌러야 반영됩니다');
    });
    box.replaceChildren(el('div', { class: 'ctx-pick-list' }, ...rows), el('div', { class: 'ctx-actions' }, apply));
  } catch (e) { box.replaceChildren(el('p', { class: 'admin-hint', text: '조회 실패: ' + (e as Error).message })); }
}

async function openPreview(c: any) {
  const box = el('div', {}, el('p', { class: 'admin-hint', text: '실제로 한 번 호출해 보는 중…' }));
  overlay(`미리 보기 — ${c.label || c.key}`, box);
  try {
    const r = await api(`/api/ui/org/collectors/${c.id}/preview`, { method: 'POST', body: '{}' });
    if (!r.ok) { box.replaceChildren(el('p', { class: 'admin-hint', text: '가져오지 못했습니다 — ' + (r.error || '알 수 없는 오류') })); return; }
    const sample: any[] = r.sample || [];
    if (!sample.length) {
      // ⚠ 0건의 원인을 **단정하지 않는다.** 예전엔 "설정(범위·필드 매핑)을 확인하세요"라고 못박았는데,
      //  실제로 가장 흔한 원인은 자격 실패였다(#1631 실측: 노션 401 인데 이 문구가 범위를 보라고 보냈다).
      //  이제 자격·범위 실패는 서버가 오류로 올려 주므로(failure-class.ts) 여기까지 온 0건은
      //  "정말 없거나 · 매핑 문제"다. 그래도 순서를 흔한 것부터 두고 단정은 피한다.
      box.replaceChildren(el('p', { class: 'admin-hint', text: '지금 잡히는 것이 0건입니다. 그 범위에 실제로 자료가 없거나, 고유 id 매핑이 비어 항목이 버려졌을 수 있습니다(매핑이 비면 전부 버려집니다).' }));
      return;
    }
    const list = el('div', { class: 'ctx-preview-list' });
    for (const s of sample) {
      list.append(el('div', { class: 'ctx-preview-row' },
        el('div', { class: 'ctx-preview-t', text: s.title || '(제목 없음)' }),
        el('div', { class: 'ctx-preview-m', text: [s.author, s.container_name, s.occurred_at?.slice(0, 10)].filter(Boolean).join(' · ') }),
        s.body_preview ? el('div', { class: 'ctx-preview-b', text: s.body_preview }) : null));
    }
    box.replaceChildren(
      el('p', { class: 'admin-hint', text: `이 설정으로 지금 이런 것들이 들어옵니다(샘플 ${sample.length}건 — 저장하지 않았습니다).` }),
      list);
  } catch (e) { box.replaceChildren(el('p', { class: 'admin-hint', text: '실패: ' + (e as Error).message })); }
}

async function openRuns(c: any) {
  const box = el('div', {}, el('p', { class: 'admin-hint', text: '불러오는 중…' }));
  overlay(`수집 기록 — ${c.label || c.key}`, box);
  try {
    const r = await api('/api/ui/org/connector/runs?' + new URLSearchParams({ collector_id: String(c.id), limit: '20' }));
    const runs: any[] = r.runs || [];
    if (!runs.length) { box.replaceChildren(el('p', { class: 'admin-hint', text: '아직 수집한 기록이 없습니다.' })); return; }
    box.replaceChildren(...runs.map((run) => {
      const row = el('div', { class: 'ctx-run-row' },
        el('span', { class: 'ctxp-dot ' + (run.status === 'ok' ? 'ctxp-dot-ok' : run.status === 'running' ? 'ctxp-dot-note' : 'ctxp-dot-warn'), 'aria-hidden': 'true' }),
        el('span', { class: 'ctx-run-t', text: run.status === 'ok' ? '성공' : run.status === 'running' ? '진행 중' : run.status === 'canceled' ? '중지됨' : '실패' }),
        el('span', { class: 'ctx-run-m', text: `${run.mode === 'full' ? '전체' : '증분'} · ${relTime(run.started_at)}` }));
      row.addEventListener('click', () => openRunLog(c, run.id));
      return row;
    }));
  } catch (e) { box.replaceChildren(el('p', { class: 'admin-hint', text: '실패: ' + (e as Error).message })); }
}

/** 실행 로그 — 진행 중이면 2초 폴링(구 커넥터 화면의 검증된 동작을 그대로). */
async function openRunLog(c: any, runId: number) {
  const status = el('div', { class: 'admin-hint', text: '불러오는 중…' });
  const pre = el('pre', { class: 'run-log' });
  const back = overlay(`수집 로그 — ${c.label || c.key}`, status, pre);
  let offset = 0, timer: any = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const tick = async () => {
    if (!document.body.contains(back)) { stop(); return; }
    try {
      const r = await api(`/api/ui/org/connector/runs/${runId}?offset=${offset}`);
      if (r.log_chunk) pre.append(document.createTextNode(r.log_chunk));
      if (r.next_offset != null) offset = r.next_offset;
      pre.scrollTop = pre.scrollHeight;
      status.textContent = (r.status === 'ok' ? '성공' : r.status === 'running' ? '진행 중 — 자동 갱신' : r.status === 'canceled' ? '중지됨' : '실패')
        + ` · ${r.mode === 'full' ? '전체' : '증분'}`;
      if (r.status !== 'running') stop();
    } catch (e) { status.textContent = '로그를 불러오지 못했습니다: ' + (e as Error).message; stop(); }
  };
  await tick();
  if (!timer) timer = setInterval(tick, 2000);
}
