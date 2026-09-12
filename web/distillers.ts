// distillers.ts — 자료 증류기(#1289). [맥락 관리 ▸ 증류 ▸ 증류기].
//
//  왜 이 화면이 있나(실측 ernest-slack-distill-zero-measurement-1289): 고객사 A 슬랙 10,900건 중 증류 13건(0.12%).
//  수집은 도는데 증류가 안 돌았고, 크론을 켜도 인박스가 전역 하나뿐이라 팀별로 다른 대상 채널·지식화 기준·
//  결과 형식을 표현할 데가 없었다. 그래서 '증류기'를 n개 세우고 각각을 여기서 설정한다.
//
//  화면은 둘로 나뉜다(#1564 — 종전엔 목록 위에 카드를 인라인 확장했다):
//   · **목록** `#/context/knowledge` — 사각지대·잔량을 비교하고, 켜고 끄고, 들어간다.
//   · **설정** `#/context/knowledge/<key>`(신규는 `/new`) — 3단 전폭 페이지(distillerPage).
//
//  왜 별도 페이지인가: 인라인 카드는 폼이 702px 밖에 못 썼다(1440 실측: main 1200 캡 → .ctx-layout 1160 →
//  카드 안 2열 = 폼 702 + 반사판 340). 필드 20개를 그 폭에 5단계 가로 탭으로 쪼개 넣고, 6천 자짜리 지시문
//  전문을 340px · max-height 300px 안에서 봐야 했다. 세로는 1840px(2화면). 페이지로 빼면서 함께 해결된 것:
//   · 주소가 생겼다 — "이 증류기 설정 좀 봐줘"가 링크 하나가 된다([[project-modal-url-routed-808]] 의 결).
//   · 카드를 열고 닫을 때마다 목록 전체가 재렌더되던 문제가 사라졌다(목록은 이제 편집을 모른다).
//
//  화면 설계 원칙:
//   · **레버 먼저, 세부는 접어서** — 채널마다 기준이 달라 결국 튜닝해야 하는데 축이 4개면 감이 안 온다.
//     값이 실제로 몇 건을 통과시키는지 **즉시 숫자로** 보여준다(추측 금지).
//   · **사각지대를 맨 위에** — "증류기를 켰는데 왜 안 줄지?"의 답이 목록보다 먼저 보인다.
//   · **채널은 고르는 것** — 실재하는 채널 목록(건수·잔량 포함)에서 눌러 담는다(오타 원천 차단).
//   · **반사판은 늘 곁에** — 설정을 만지는 내내 "지금 이게 무엇을 집는가"가 오른쪽에 붙어 있다.
import { api, busy, el, relTime, replaceKids, sv, toast } from './core.js';
import { svcTile } from './svc-icons.js';
import { svcLogo } from './svc-logos.js';
import { icon as lineIcon } from './v2/icons.js';
import { confirmDialog, skeleton } from './ui-primitives.js';
import { stageJobCard } from './context-stage-job.js';   // 단계 공용 '언제 도나' 카드(#1618)

const PAGE_TYPES = ['', 'decision', 'concept', 'how-to', 'reference', 'research', 'entity'];
const KINDS = ['slack', 'email', 'discord', 'transcript', 'minutes', 'notion_doc', 'clickup_doc', 'drive_file', 'local_file', 'other'];

/** 목록 주소. */
const LIST_HREF = '#/context/knowledge';
/** 설정 페이지 주소 — 목록·크럼·저장 후 이동이 전부 이걸 쓴다(해시 문자열 조립이 흩어지지 않게). */
const pageHref = (key: string) => LIST_HREF + '/' + encodeURIComponent(key);
/** 신규 생성의 자리표시 key — 그래서 이 문자열은 실제 증류기 key 가 될 수 없다(저장 시 거부). */
const NEW_KEY = 'new';

// ── 저장 안 된 변경 가드 ─────────────────────────────────────────────────────
//  설정이 페이지가 되면서 새로고침·탭 닫기로 폼을 통째로 잃을 수 있게 됐다(인라인 카드 시절엔 '닫기'를
//  눌러야 사라졌다). 현재 열린 설정 페이지가 자기 dirty 판정을 여기 걸어 둔다.
//  ⚠ 해시 이동은 beforeunload 가 못 잡는다 — 그 경로는 '← 증류기 목록' 링크가 confirmDialog 로 막는다.
//   브라우저 뒤로가기까지 막으려면 라우터 계약(main.ts route())을 건드려야 해 이번 범위 밖으로 뒀고,
//   대신 '저장 안 된 변경' 배지를 머리에 상시 노출해 상태를 늘 보이게 했다.
let dirtyGuard: (() => boolean) | null = null;
window.addEventListener('beforeunload', (ev) => {
  if (!dirtyGuard || !dirtyGuard()) return;
  ev.preventDefault();
  ev.returnValue = '';
});
window.addEventListener('hashchange', () => {
  // 설정 페이지를 벗어나면 가드를 놓는다 — 라우터는 view 를 갈아치울 뿐 정리 훅을 주지 않는다.
  if (!location.hash.startsWith(LIST_HREF + '/')) dirtyGuard = null;
});

// ══════════════════════════════════════════════════════════════════════════
//  목록 — #/context/knowledge
// ══════════════════════════════════════════════════════════════════════════
export async function distillersPanel(detail, data) {
  //  #3830 4차(2026-09-10 원준): "0부터 다시 재설계 · 디자인 고도화 · 수집기 탭 이상 수준으로".
  //   증류기 하나 = **레인**이다: [읽는 곳] → [남길 기준] → [지식이 가는 곳]. 그래서 목록의 한 장은 글 한 줄이 아니라
  //   그 흐름을 **그림**으로 보여 준다(표지 지도의 역·선로 문법을 그대로 — 켜진 레인은 선로가 흐른다).
  //   돌고 있는 증류기는 흐름 카드, 꺼 둔 증류기는 접힌 목록의 얇은 행. 카테고리는 key 가 아니라 이름으로 보인다.
  busy(detail, el('div', { class: 'card' }, skeleton('증류기 불러오는 중')));

  let res; let catRes: any = null;
  try { [res, catRes] = await Promise.all([api('/api/ui/org/distillers'), api('/api/ui/categories').catch(() => null)]); }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '불러오지 못했습니다 — ' + e.message }))); return; }
  const catName = categoryNames(catRes);

  const distillers = res.distillers || [];
  const coverage = res.coverage || { total_undistilled: 0, uncovered: 0, uncovered_reviewed: 0, distillers: [], uncovered_channels: [] };
  const stat = (id) => coverage.distillers.find((x) => x.id === id) || {};
  const rerender = () => { void distillersPanel(detail, data); };

  const body = el('div', { class: 'cxc dsl' });
  const on = distillers.filter((d) => d.enabled).sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  const off = distillers.filter((d) => !d.enabled);

  body.append(el('div', { class: 'cxc-head' },
    el('div', { class: 'cxc-head-main' },
      el('h3', { class: 'cxc-title' }, el('span', { text: '증류기' }), el('span', { class: 'cxc-title-n num', text: String(distillers.length) })),
      el('p', { class: 'cxc-lead', text: '증류기는 쌓인 자료를 읽고, 남길 가치가 있는 것만 골라 지식으로 씁니다. 자료 하나는 증류기 하나만 읽습니다 — 위에서부터 조건에 맞는 첫 증류기가 읽고, 어느 것에도 맞지 않는 자료는 맨 아래 「안전망」이 읽습니다.' })),
    el('div', { class: 'cxc-head-acts' }, el('a', { class: 'btn btn-primary', href: pageHref(NEW_KEY), text: '+ 증류기 만들기' }))));

  body.append(statsStrip(coverage, on.length, distillers.length));

  if (!distillers.length) {
    body.append(el('div', { class: 'cxc-list' }, el('div', { class: 'cxc-empty' },
      el('p', { class: 'cxc-empty-t', text: '아직 증류기가 없습니다' }),
      el('p', { class: 'cxc-empty-d', text: '증류기가 하나도 없으면 모든 자료를 한 가지 공통 기준으로 읽습니다. 팀이나 채널마다 남길 기준을 다르게 하려면 하나 만드세요.' }))));
  } else {
    body.append(el('p', { class: 'cxc-sub cxc-group-t' }, el('span', { text: '돌고 있는 증류기' }), el('span', { class: 'cxc-title-n num', text: String(on.length) })));
    const cards = el('div', { class: 'dsl-cards' });
    if (!on.length) cards.append(el('div', { class: 'cxc-list' }, el('div', { class: 'cxc-empty' }, el('p', { class: 'cxc-empty-d', text: '켜진 증류기가 없습니다 — 아래에서 하나를 켜세요.' }))));
    for (const d of on) cards.append(distillerCard(d, stat(d.id), catName, rerender));
    body.append(cards);

    if (off.length) {
      const fold = el('details', { class: 'cxc-fold' },
        el('summary', {}, el('span', { class: 'cxc-sub' }, el('span', { text: '꺼 둔 증류기' }), el('span', { class: 'cxc-title-n num', text: String(off.length) })),
          el('span', { class: 'cxc-fold-d', text: '리브가 카테고리마다 미리 준비해 둔 것이 대부분입니다 — 그런 자료가 들어오기 시작하면 켜세요.' })));
      const offList = el('div', { class: 'cxc-list' });
      for (const d of off) offList.append(distillerRowCompact(d, stat(d.id), catName, rerender));
      fold.append(offList);
      body.append(fold);
    }
  }

  body.append(await runJobCard(rerender));
  detail.replaceChildren(body);
}

/**
 * 이름과, 이름 뒤에 덧붙인 설명을 가른다 — 리브가 만든 증류기는 「제품 기획서 — 꺼 둠: …」「올린 파일 → 서랍 (테스트 계정 업로드 제외)」
 *  처럼 설명을 이름에 붙여 둔다. 이름은 굵게, 설명은 흐리게 한 줄 아래로(#3830). 데이터는 건드리지 않는다 — 보여 주는 모양만.
 *  괄호는 **띄어 쓴 끝 괄호**만 가른다(「이슈·PR 대화(GitHub·GitLab)」처럼 이름의 일부인 괄호는 둔다).
 */
function splitLabel(label: string): [string, string | null] {
  let name = String(label || '').trim();
  const notes: string[] = [];
  const dash = name.indexOf(' — ');
  if (dash > 0) { notes.push(name.slice(dash + 3).trim()); name = name.slice(0, dash).trim(); }
  const m = name.match(/^(.*\S)\s+\(([^()]+)\)$/);
  if (m) { name = m[1]; notes.unshift(m[2].trim()); }
  return [name, notes.filter(Boolean).join(' · ') || null];
}

/** 카테고리 key → 이름. 화면에 key(`d-3a8863ce8e`·`gtm`)를 내보내지 않는다. */
function categoryNames(catRes: any): (key: string | null | undefined) => string | null {
  const m = new Map<string, string>();
  for (const c of ((catRes && catRes.categories) || [])) if (c && c.key) m.set(String(c.key), String(c.name || c.key));
  return (key) => (key ? (m.get(String(key)) || String(key)) : null);
}

/** 리브가 만든 증류기인가 — 온보딩이 카테고리마다 세운 레인(`liv-` 접두)과 제품이 준비해 두는 프리셋 셋. */
const PRESET_DISTILLERS = new Set(['local-files', 'figma-comments', 'issue-threads']);
function isLivMadeDistiller(d): boolean {
  return String(d.key || '').startsWith('liv-') || PRESET_DISTILLERS.has(String(d.key || ''));
}

/** 자료 종류 → 사람 말 · 로고. 로고가 없는 종류(회의록·전사록·메일·그 밖)는 우리 선 글리프로 떨어진다(브랜드가 아니라 종류다). */
const KIND_LABEL: Record<string, string> = {
  slack: '슬랙', discord: '디스코드', email: '메일', transcript: '회의 전사록', minutes: '회의록', notion_doc: '노션 문서',
  clickup_doc: '클릭업 문서', drive_file: '드라이브 파일', local_file: '올린 파일', figma_comment: '피그마 코멘트',
  github_issue: '깃허브 이슈', gitlab_issue: '깃랩 이슈', linear_issue: '리니어 이슈', other: '그 밖',
};
const KIND_SVC: Record<string, string> = {
  slack: 'slack', notion_doc: 'notion', clickup_doc: 'clickup', drive_file: 'google-drive', figma_comment: 'figma',
  github_issue: 'github', gitlab_issue: 'gitlab', linear_issue: 'linear', email: 'google-gmail',
};
export function kindFace(kind: string, cls = ''): HTMLElement {
  const svc = KIND_SVC[kind];
  if (svc && svcLogo(svc)) { const t = svcTile(svc, KIND_LABEL[kind] || kind, true); t.classList.add('cxc-tile'); if (cls) t.classList.add(cls); return t; }
  const glyph = kind === 'local_file' ? 'src' : (kind === 'discord' || kind === 'slack') ? 'chat' : 'doc';
  return el('span', { class: 'svc-tile cxc-tile cxc-tile-machine' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' }, lineIcon(glyph, 'cxc-tile-ic'));
}
function kindText(d): string {
  const ks: string[] = Array.isArray(d.match_kinds) ? d.match_kinds.filter(Boolean) : [];
  if (!ks.length) return '모든 자료';
  const names = ks.map((k) => KIND_LABEL[k] || k);
  return names.length <= 2 ? names.join('·') : names.slice(0, 2).join('·') + ' 외 ' + (names.length - 2);
}
/** 카드 머리의 얼굴 — 종류 로고를 겹쳐 쌓는다(최대 3). 종류가 없으면(모든 자료) 깔때기 하나. */
function faceStack(d): HTMLElement {
  const ks: string[] = Array.isArray(d.match_kinds) ? d.match_kinds.filter(Boolean) : [];
  const wrap = el('span', { class: 'dsl-faces', 'aria-hidden': 'true' });
  if (!ks.length) { wrap.append(el('span', { class: 'svc-tile cxc-tile cxc-tile-machine' }, funnelIcon())); return wrap; }
  for (const k of ks.slice(0, 3)) wrap.append(kindFace(k));
  if (ks.length > 3) wrap.append(el('span', { class: 'dsl-faces-n', text: '+' + (ks.length - 3) }));
  return wrap;
}

// ── 현황 띠 — 숫자 셋. 어느 증류기도 안 읽는 자료가 있으면 그 칸이 경고색이 된다. ──
function statsStrip(cov, onN: number, total: number) {
  const tile = (n: string, l: string, k = '') => el('div', { class: 'dsl-stat' + (k ? ' ' + k : '') },
    el('b', { class: 'dsl-stat-n num', text: n }), el('span', { class: 'dsl-stat-l', text: l }));
  const strip = el('div', { class: 'dsl-stats' },
    tile(onN + ' / ' + total, '켜진 증류기'),
    tile((cov.total_undistilled || 0).toLocaleString() + '건', '아직 읽지 않은 자료'),
    tile((cov.uncovered || 0).toLocaleString() + '건', '어느 증류기도 읽지 않는 자료', cov.uncovered > 0 ? 'is-warn' : 'is-ok'));
  if (cov.uncovered > 0 && onN > 0 && (cov.uncovered_channels || []).length) {
    const issue = el('div', { class: 'cxc-issue cxc-issue-block' },
      el('b', { text: '이 채널들은 어느 증류기도 읽지 않습니다' }),
      el('span', { text: ' — 이대로 두면 지식이 되지 않습니다. 어느 증류기의 「읽을 채널」에 넣거나, 안전망 증류기를 켜세요.' }),
      el('div', { class: 'cxc-chips' }, ...cov.uncovered_channels.map((c) => el('span', { class: 'pill', text: (c.channel || '(채널 없음)') + ' · ' + c.n.toLocaleString() }))));
    return el('div', {}, strip, issue);
  }
  return strip;
}

/** 남길 기준 발췌 — 마크다운 기호를 걷고 앞부분만. */
function criteriaExcerpt(md: string | null | undefined): string {
  const t = String(md || '').replace(/^#+\s*/gm, '').replace(/\*\*|__|`/g, '').replace(/^\s*[-*]\s+/gm, '· ').replace(/\s+/g, ' ').trim();
  return t.length > 150 ? t.slice(0, 150).trimEnd() + '…' : t;
}
const listOf = (x): string[] => Array.isArray(x) ? x.filter(Boolean).map(String) : String(x || '').split('\n').map((s) => s.trim()).filter(Boolean);

// ── 흐름 카드 — [읽는 곳] ══▶ [남길 기준] ══▶ [지식이 가는 곳] ──
function distillerCard(d, st, catName, rerender) {
  const liv = isLivMadeDistiller(d);
  const catchAll = Number(d.priority) <= -100 || /catch-all$/.test(String(d.key || ''));
  const card = el('article', { class: 'dsl-card' + (d.enabled ? '' : ' is-off') });

  // 머리 — 얼굴 · 이름(설정 링크) · 상태 · 표식 / 리브가 만듦 · 마지막 실행 … [스위치][설정]
  const main = el('div', { class: 'cxc-main' },
    el('div', { class: 'cxc-t' },
      el('a', { class: 'cxc-name', href: pageHref(d.key), text: splitLabel(d.label || d.key)[0] }),
      el('span', { class: 'cxc-state' + (d.enabled ? ' is-on' : '') }, el('span', { class: 'cxc-state-dot', 'aria-hidden': 'true' }), el('span', { text: d.enabled ? '켜짐' : '꺼짐' })),
      catchAll ? el('span', { class: 'cxc-tag', text: '나머지 전부' }) : null),
    splitLabel(d.label || d.key)[1] ? el('p', { class: 'cxc-desc', text: splitLabel(d.label || d.key)[1] }) : null,
    el('div', { class: 'cxc-m' },
      el('span', { class: 'cxc-kind', text: kindText(d) + ' 증류기' }),
      liv ? el('span', { class: 'cxc-liv', title: '리브가 미리 준비해 둔 증류기입니다' }, livIcon(), el('span', { text: '리브가 만듦' })) : el('span', { class: 'cxc-who', text: '직접 만듦' }),
      el('span', { class: 'cxc-sep', 'aria-hidden': 'true', text: '·' }),
      el('span', { text: d.last_run_at ? `마지막 실행 ${relTime(d.last_run_at)}` + (d.last_status && d.last_status !== 'ok' ? ' · 실패' : '') : '아직 실행한 적 없음' })));
  const acts = el('div', { class: 'cxc-acts' });
  const sw = el('input', { type: 'checkbox', class: 'cxc-sw', role: 'switch', 'aria-label': `${d.label || d.key} 켜기` }) as HTMLInputElement;
  sw.checked = !!d.enabled;
  sw.addEventListener('change', async () => {
    const next = sw.checked; sw.disabled = true;
    try { await api('/api/ui/org/distillers', { method: 'POST', body: JSON.stringify({ ...settable(d), enabled: next }) }); toast(next ? '켰습니다' : '껐습니다'); rerender(); }
    catch (e) { toast(e.message, true); sw.checked = !next; sw.disabled = false; }
  });
  acts.append(sw, el('a', { class: 'btn btn-ghost btn-sm', href: pageHref(d.key), text: '설정' }));
  card.append(el('div', { class: 'dsl-head' }, faceStack(d), main, acts));

  // 흐름 — 역 셋 + 선로 둘. 켜진 레인만 선로가 흐른다(장식이 아니라 상태).
  const station = (k: string, body: HTMLElement, foot: string | HTMLElement | null) =>
    el('div', { class: 'dsl-st' }, el('span', { class: 'dsl-st-k', text: k }), el('div', { class: 'dsl-st-b' }, body),
      foot ? el('div', { class: 'dsl-st-f' }, typeof foot === 'string' ? el('span', { text: foot }) : foot) : null);
  const wire = () => el('span', { class: 'dsl-wire' + (d.enabled ? ' is-flow' : ''), 'aria-hidden': 'true' }, arrowIcon());

  // ① 읽는 곳 — 채널 알약(최대 5) · 제외 · 봇. 발치는 아직 읽지 않은 자료 수(살아 있는 숫자).
  const inc = listOf(d.include_channels), exc = listOf(d.exclude_channels);
  const readChips = el('div', { class: 'dsl-chips' });
  if (inc.length) { for (const c of inc.slice(0, 5)) readChips.append(el('span', { class: 'dsl-chip', text: '#' + c })); if (inc.length > 5) readChips.append(el('span', { class: 'dsl-chip is-more', text: '+' + (inc.length - 5) })); }
  else readChips.append(el('span', { class: 'dsl-chip is-all', text: '모든 채널' }));
  if (exc.length) readChips.append(el('span', { class: 'dsl-chip is-ex', title: exc.join(', '), text: '빼는 채널 ' + exc.length }));
  if (d.exclude_bots) readChips.append(el('span', { class: 'dsl-chip is-ex', text: '봇 제외' }));
  const backlog = Number(st.backlog || 0);
  const readFoot = el('span', {}, el('b', { class: 'num', text: backlog.toLocaleString() + '건' }), el('span', { text: d.enabled ? ' 아직 읽지 않음' : ' 켜면 읽음' }));

  // ② 남길 기준 — 사람이 쓴 기준의 앞부분. 비어 있으면 기본 기준을 사람 말로.
  const crit = criteriaExcerpt(d.criteria_md);
  const critBody = el('p', { class: 'dsl-crit' + (crit ? '' : ' is-default'), text: crit || '기본 기준 — 결정·합의·사실·절차는 남기고, 잡담·인사·한 번뿐인 이야기는 건너뜁니다.' });
  const rules = d.prefilter_rules && typeof d.prefilter_rules === 'object' ? Object.keys(d.prefilter_rules).filter((k) => k !== 'match') : [];
  const critFoot = rules.length ? '보내기 전에 서버가 한 번 거릅니다' : '읽은 것을 전부 AI가 판단합니다';

  // ③ 지식이 가는 곳 — 카테고리 이름 · 문서 유형 · 대화 묶음.
  const cat = catName(d.target_category);
  const destBody = el('div', {}, el('p', { class: 'dsl-dest' + (cat ? '' : ' is-default'), text: cat || 'AI가 내용에 맞는 카테고리를 고릅니다' }));
  const TYPE_KO: Record<string, string> = { decision: '결정', concept: '개념', 'how-to': '방법·절차', reference: '참조', research: '조사', entity: '사람·회사·물건' };
  const destBits: string[] = [];
  if (d.default_type && TYPE_KO[d.default_type]) destBits.push('문서 유형 ' + TYPE_KO[d.default_type]);
  destBits.push(d.thread_aware ? '대화를 묶어 하나로' : '자료 하나씩 따로');
  card.append(el('div', { class: 'dsl-flow' },
    station('읽는 곳', readChips, readFoot), wire(),
    station('남길 기준', critBody, critFoot), wire(),
    station('지식이 가는 곳', destBody, destBits.join(' · '))));
  return card;
}

// ── 꺼 둔 증류기 — 얇은 행. 켜면 위 카드로 올라간다. ──
function distillerRowCompact(d, st, catName, rerender) {
  const row = el('div', { class: 'cxc-row is-off' });
  const liv = isLivMadeDistiller(d);
  const backlog = Number(st.backlog || 0);
  const cat = catName(d.target_category);
  row.append(faceStack(d),
    el('div', { class: 'cxc-main' },
      el('div', { class: 'cxc-t' },
        el('a', { class: 'cxc-name', href: pageHref(d.key), text: splitLabel(d.label || d.key)[0] }),
        el('span', { class: 'cxc-state' }, el('span', { class: 'cxc-state-dot', 'aria-hidden': 'true' }), el('span', { text: '꺼짐' }))),
      splitLabel(d.label || d.key)[1] ? el('p', { class: 'cxc-desc', text: splitLabel(d.label || d.key)[1] }) : null,
      el('div', { class: 'cxc-m' },
        el('span', { class: 'cxc-kind', text: kindText(d) + ' 증류기' }),
        liv ? el('span', { class: 'cxc-liv' }, livIcon(), el('span', { text: '리브가 만듦' })) : el('span', { class: 'cxc-who', text: '직접 만듦' }),
        el('span', { class: 'cxc-sep', 'aria-hidden': 'true', text: '·' }),
        el('span', { text: cat ? `지식은 「${cat}」로` : 'AI가 카테고리를 고름' }),
        el('span', { class: 'cxc-sep', 'aria-hidden': 'true', text: '·' }),
        el('span', { text: `켜면 읽을 자료 ${backlog.toLocaleString()}건` }))));
  const acts = el('div', { class: 'cxc-acts' });
  const sw = el('input', { type: 'checkbox', class: 'cxc-sw', role: 'switch', 'aria-label': `${d.label || d.key} 켜기` }) as HTMLInputElement;
  sw.addEventListener('change', async () => {
    sw.disabled = true;
    try { await api('/api/ui/org/distillers', { method: 'POST', body: JSON.stringify({ ...settable(d), enabled: true }) }); toast('켰습니다'); rerender(); }
    catch (e) { toast(e.message, true); sw.checked = false; sw.disabled = false; }
  });
  acts.append(sw, el('a', { class: 'btn btn-ghost btn-sm', href: pageHref(d.key), text: '설정' }));
  row.append(acts);
  return row;
}

function funnelIcon(): SVGElement {
  const n = sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M4 5h16l-6.2 7.2V18l-3.6 2v-7.8z' }));
  return n;
}
function arrowIcon(): SVGElement {
  const n = sv('svg', { class: 'dsl-arr', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M9 6l6 6-6 6' }));
  return n;
}
function livIcon(): SVGElement {
  const n = sv('svg', { class: 'cxc-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 12, cy: 12, r: 9 }), sv('circle', { cx: 12, cy: 12, r: 2.5 }));
  return n;
}

/** 삭제 — 목록과 설정 페이지가 같은 문구·같은 확인을 쓴다. after 는 삭제에 성공한 뒤 할 일. */
async function removeDistiller(d, after: () => void) {
  const ok = await confirmDialog({
    title: `증류기 '${d.label || d.key}' 를 삭제할까요?`,
    message: '이미 만들어진 지식은 그대로 남습니다. 이 증류기가 맡던 자료는 다른 증류기(또는 사각지대)로 넘어갑니다.',
    confirmText: '삭제', danger: true,
  });
  if (!ok) return;
  try { await api('/api/ui/org/distillers/remove', { method: 'POST', body: JSON.stringify({ id: d.id }) }); toast('삭제됨'); after(); }
  catch (e) { toast(e.message, true); }
}

// upsert 는 전 필드 교체라, 부분 저장 시 나머지가 날아가지 않게 현재 값을 그대로 되보낸다.
function settable(d) {
  return {
    id: d.id, key: d.key, label: d.label, priority: d.priority, enabled: d.enabled,
    match_kinds: d.match_kinds, match_system: d.match_system,
    include_channels: d.include_channels, exclude_channels: d.exclude_channels,
    include_authors: d.include_authors, exclude_authors: d.exclude_authors,
    exclude_bots: d.exclude_bots, min_chars: d.min_chars, lookback_days: d.lookback_days,
    criteria_md: d.criteria_md, format_md: d.format_md, target_category: d.target_category,
    default_type: d.default_type, name_prefix: d.name_prefix, thread_aware: d.thread_aware,
    prefilter_level: d.prefilter_level, prefilter_rules: d.prefilter_rules,
    batch_size: d.batch_size, batch_max_msgs: d.batch_max_msgs, mode: d.mode, session_ref: d.session_ref,
    model: d.model, effort: d.effort, requester: d.requester, note: d.note,
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  설정 페이지 — #/context/knowledge/<key>
// ══════════════════════════════════════════════════════════════════════════

/** 위치 + 되돌아갈 자리. 이 페이지엔 좌측 단계 내비(.ctx-side)를 그리지 않으므로 이 한 줄이 그 몫을 한다. */
function crumb(): { nav: HTMLElement; back: HTMLElement } {
  const back = el('a', { href: LIST_HREF, text: '← 증류기 목록' });
  return {
    back,
    nav: el('nav', { class: 'dst-crumb', 'aria-label': '위치' }, back,
      el('span', { class: 'dst-crumb-sep', text: '·', 'aria-hidden': 'true' }),
      el('span', { text: '맥락 관리 › 증류' })),
  };
}

/** 페이지 셸 — 로딩·오류·없음도 크럼을 달고 나온다(링크로 착지한 사람이 나갈 길을 잃지 않게). */
function pageShell(...kids: any[]) {
  return el('div', { class: 'dst-page' }, crumb().nav, ...kids);
}

export async function distillerPage(view: HTMLElement, rawKey: string): Promise<void> {
  const key = decodeURIComponent(rawKey || '');
  const isNew = key === NEW_KEY;
  dirtyGuard = null;   // 이전 페이지의 가드를 물려받지 않는다
  view.replaceChildren(pageShell(el('div', { class: 'card' }, skeleton('증류기 설정 불러오는 중'))));

  let d: any = null;
  if (!isNew) {
    let res;
    try { res = await api('/api/ui/org/distillers'); }
    catch (e) {
      view.replaceChildren(pageShell(el('div', { class: 'card' },
        el('p', { class: 'admin-hint', text: '증류기를 불러오지 못했습니다 — ' + e.message }))));
      return;
    }
    d = (res.distillers || []).find((x) => x.key === key) || null;
    if (!d) {
      // 삭제됐거나 오타난 주소 — 링크를 받은 사람이 여기 착지할 수 있으니 무엇이 없는지 그대로 말한다.
      view.replaceChildren(pageShell(el('div', { class: 'card' },
        el('p', { class: 'mini-title' }, el('span', { text: '이 증류기를 찾지 못했습니다' })),
        el('p', { class: 'admin-hint', text: `식별자 '${key}' 인 증류기가 없습니다. 이름이 바뀌었거나 삭제됐을 수 있습니다.` }),
        el('div', { style: 'margin-top:12px' }, el('a', { class: 'btn btn-ghost', href: LIST_HREF, text: '증류기 목록으로' })))));
      return;
    }
  }
  view.replaceChildren(editorPage(d, isNew));
}

function editorPage(d, isNew: boolean): HTMLElement {
  const page = el('div', { class: 'dst-page' });

  // 한 줄 필드 — 라벨·설명·입력을 묶어 일관되게. 설명은 '왜 이 값을 정하나'를 말한다.
  const F = (label, hint, ctrl) => el('div', { class: 'dst-field' },
    el('div', { class: 'field-label', text: label }),
    hint ? el('p', { class: 'admin-hint', text: hint }) : null, ctrl);
  // 짧은 필드 둘을 나란히 — 넓어진 폼을 실제로 쓰려면 이게 필요하다(실측: 260px 짜리 숫자칸이
  //  세로로만 쌓여 오른쪽 500px 이 통째로 비었다). 좁은 화면에서는 CSS 가 1열로 되돌린다.
  const row2 = (a, b) => el('div', { class: 'dst-row2' }, a, b);
  // 접이식 — 세부 옵션을 숨기되 막지는 않는다(커스텀 상한 없음). 폼이 넓어졌어도 '늘 필요하진 않은' 축은 접는다.
  const fold = (title, ...kids) => {
    const wrap = el('div', { class: 'dst-fold' });
    const btn = el('button', { type: 'button', class: 'btn-text', text: '▸ ' + title, 'aria-expanded': 'false' });
    btn.addEventListener('click', () => {
      const open = wrap.classList.toggle('open');
      btn.textContent = (open ? '▾ ' : '▸ ') + title;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    wrap.append(btn, el('div', { class: 'dst-fold-body' }, ...kids));
    return wrap;
  };

  const v = (k, dflt: any = '') => (d && d[k] != null ? d[k] : dflt);
  const listText = (x) => Array.isArray(x) ? x.join('\n') : (x || '');

  // ⓪ 기본
  const keyIn = el('input', { type: 'text', class: 'dst-in dst-in-sm', value: v('key'), placeholder: 'hf-yeosin', ...(isNew ? {} : { disabled: true }) });
  const labelIn = el('input', { type: 'text', class: 'dst-in', value: v('label'), placeholder: '여신 제품팀 증류기' });
  const prioIn = el('input', { type: 'number', class: 'dst-in dst-in-sm', value: String(v('priority', 0)) });
  const enabledChk = el('input', { type: 'checkbox', class: 'cxc-sw', role: 'switch', 'aria-label': '이 증류기 켜 두기', ...(v('enabled', false) ? { checked: true } : {}) });

  // ① 범위
  const kindBoxes: Record<string, HTMLInputElement> = {};
  const kindsWrap = el('div', { class: 'dst-kinds' });
  const curKinds = new Set(v('match_kinds', []) || []);
  for (const k of KINDS) {
    const cb = el('input', { type: 'checkbox', value: k }) as HTMLInputElement;
    cb.checked = curKinds.has(k); kindBoxes[k] = cb;
    kindsWrap.append(el('label', { class: 'dsl-kind' }, cb, kindFace(k, 'dsl-kind-f'), el('span', { text: KIND_LABEL[k] || k })));
  }
  const incCh = el('textarea', { class: 'dst-in', style: 'min-height:88px', placeholder: '한 줄에 채널 하나 — 비우면 모든 채널을 읽습니다' }) as HTMLTextAreaElement;
  incCh.value = listText(v('include_channels', null));
  const excCh = el('textarea', { class: 'dst-in', style: 'min-height:60px', placeholder: '한 줄에 채널 하나 — 비우면 없음' }) as HTMLTextAreaElement;
  excCh.value = listText(v('exclude_channels', null));
  const botChk = el('input', { type: 'checkbox', ...(v('exclude_bots', true) ? { checked: true } : {}) });
  const minIn = el('input', { type: 'number', class: 'dst-in dst-in-sm', value: String(v('min_chars', 0)), min: '0' });
  const lookIn = el('input', { type: 'number', class: 'dst-in dst-in-sm', value: d && d.lookback_days ? String(d.lookback_days) : '', placeholder: '비우면 과거 전체' });

  const chPick = el('div', { class: 'dst-chpick' }, el('span', { class: 'admin-hint', text: '채널 목록 불러오는 중…' }));
  void (async () => {
    try {
      const r = await api('/api/ui/org/source-channels?limit=200');
      const chans = (r.channels || []).filter((c) => c.channel);
      chPick.replaceChildren();
      if (!chans.length) { chPick.append(el('span', { class: 'admin-hint', text: '수집된 채널이 아직 없습니다.' })); return; }
      for (const c of chans) {
        const b = el('button', { type: 'button', class: 'pill', title: '누르면 「읽을 채널」에 넣습니다',
          text: c.channel + ' · 안 읽은 ' + Number(c.undistilled).toLocaleString() });
        b.addEventListener('click', () => {
          const cur = incCh.value.split('\n').map((s) => s.trim()).filter(Boolean);
          if (!cur.includes(c.channel)) { cur.push(c.channel); incCh.value = cur.join('\n'); }
          // 프로그램이 바꾼 값은 input 을 안 쏜다 — 눌러 담아도 반사판이 갱신되게 직접 알린다.
          incCh.dispatchEvent(new Event('input', { bubbles: true }));
        });
        chPick.append(b);
      }
    } catch { chPick.replaceChildren(el('span', { class: 'admin-hint', text: '채널 목록을 불러오지 못했습니다(직접 입력해도 됩니다).' })); }
  })();

  // ② 사전 필터 — 축별 수치가 정본(레버 폐기). 최적값은 AI 가 실측으로 정한다.
  const rules = (d && d.prefilter_rules) || {};
  const rIn = (k, ph) => {
    const i = el('input', { type: 'number', class: 'dst-in dst-in-sm', placeholder: ph }) as HTMLInputElement;
    if (rules[k] != null) i.value = String(rules[k]);
    return i;
  };
  const rDec = rIn('min_decisive', '비우면 조건 없음'), rAut = rIn('min_authors', '비우면 조건 없음');
  const rMsg = rIn('min_msgs', '비우면 조건 없음'), rChr = rIn('min_chars', '비우면 조건 없음');
  const rKw = el('textarea', { class: 'dst-in', style: 'min-height:110px',
    placeholder: '한 줄에 하나. 예) 할인일시납, 플랫폼이용료, 출시일 — 우리 팀에서 실제로 쓰는 말일수록 잘 듣습니다' }) as HTMLTextAreaElement;
  rKw.value = Array.isArray(rules.keywords) ? rules.keywords.join('\n') : '';
  const rMatch = el('select', { class: 'dst-in dst-in-sm' }) as HTMLSelectElement;
  rMatch.append(el('option', { value: 'any', text: '조건 중 하나만 맞아도 보냅니다 (권장)' }));
  rMatch.append(el('option', { value: 'all', text: '조건이 전부 맞아야 보냅니다 (놓치는 것이 많아집니다)' }));
  rMatch.value = rules.match === 'all' ? 'all' : 'any';

  // ③ 기준·형식
  const critIn = el('textarea', { class: 'dst-in', style: 'min-height:150px',
    placeholder: '예) 제품 사양 결정, 장애 원인과 조치, 운영 규칙 합의는 남긴다. 일정 조율과 단순 질문·답은 남기지 않는다.' }) as HTMLTextAreaElement;
  critIn.value = v('criteria_md');
  const fmtIn = el('textarea', { class: 'dst-in', style: 'min-height:150px',
    placeholder: '예) 제목은 "[제품] 결정 한 줄". 본문은 배경 → 결정 → 근거 → 영향 순서로.' }) as HTMLTextAreaElement;
  fmtIn.value = v('format_md');
  //  카테고리는 key 를 치는 칸이 아니라 **이름에서 고르는 칸**(#3830 4차). 목록은 비동기로 채우되 현재 값은 먼저 세운다.
  const catIn = el('select', { class: 'dst-in dst-in-sm' }) as HTMLSelectElement;
  catIn.append(el('option', { value: '', text: 'AI가 내용에 맞는 카테고리를 고름' }));
  if (v('target_category')) { catIn.append(el('option', { value: v('target_category'), text: v('target_category') })); catIn.value = v('target_category'); }
  void (async () => {
    try {
      const r = await api('/api/ui/categories');
      const cur = catIn.value;
      const seen = new Set(['']);
      for (const c of ((r && r.categories) || [])) {
        if (!c || !c.key || seen.has(c.key)) continue; seen.add(c.key);
        const o = el('option', { value: c.key, text: String(c.name || c.key) });
        const dup = [...catIn.options].find((x) => x.value === c.key);
        if (dup) dup.textContent = String(c.name || c.key); else catIn.append(o);
      }
      catIn.value = cur;
    } catch { /* 목록을 못 받아도 현재 값은 서 있다 */ }
  })();
  const TYPE_LABEL: Record<string, string> = { '': 'AI가 고름', decision: '결정', concept: '개념', 'how-to': '방법·절차', reference: '참조', research: '조사', entity: '사람·회사·물건' };
  const typeSel = el('select', { class: 'dst-in dst-in-sm' }) as HTMLSelectElement;
  for (const t of PAGE_TYPES) typeSel.append(el('option', { value: t, text: TYPE_LABEL[t] ?? t }));
  if (v('default_type')) typeSel.value = v('default_type');
  const prefixIn = el('input', { type: 'text', class: 'dst-in dst-in-sm', value: v('name_prefix'), placeholder: '예: product-' });
  const threadChk = el('input', { type: 'checkbox', ...(v('thread_aware', true) ? { checked: true } : {}) });

  // ④ 실행
  const batchIn = el('input', { type: 'number', class: 'dst-in dst-in-sm', value: String(v('batch_size', 3)), min: '1', max: '200' });
  const batchMsgIn = el('input', { type: 'number', class: 'dst-in dst-in-sm', value: String(v('batch_max_msgs', 20)), min: '1', max: '2000' });
  const modeSel = el('select', { class: 'dst-in dst-in-sm' }) as HTMLSelectElement;
  modeSel.append(el('option', { value: 'headless', text: '매번 새 AI 세션에서 (권장)' }));
  modeSel.append(el('option', { value: 'session', text: '늘 켜 둔 AI 세션에 보내서' }));
  if (v('mode')) modeSel.value = v('mode');
  const sessIn = el('input', { type: 'text', class: 'dst-in dst-in-sm', value: v('session_ref'), placeholder: '「늘 켜 둔 AI 세션」일 때만' });
  const modelSel = el('select', { class: 'dst-in dst-in-sm' }) as HTMLSelectElement;
  for (const m of ['', 'fable', 'opus', 'sonnet', 'haiku']) modelSel.append(el('option', { value: m, text: m || '계정 기본값' }));
  if (v('model')) modelSel.value = v('model');
  const effortSel = el('select', { class: 'dst-in dst-in-sm' }) as HTMLSelectElement;
  for (const m of ['', 'low', 'medium', 'high', 'xhigh', 'max']) effortSel.append(el('option', { value: m, text: m || '기본값' }));
  if (v('effort')) effortSel.value = v('effort');
  const reqIn = el('input', { type: 'text', class: 'dst-in dst-in-sm', value: v('requester'), placeholder: '구성원 id — 비우면 자동 실행을 만든 사람' });

  const collect = () => {
    const kw = rKw.value.split('\n').map((s) => s.trim()).filter(Boolean);
    const pr: any = {};
    const put = (k, i) => { const x = (i as HTMLInputElement).value.trim(); if (x !== '') pr[k] = Number(x); };
    put('min_decisive', rDec); put('min_authors', rAut); put('min_msgs', rMsg); put('min_chars', rChr);
    if (kw.length) pr.keywords = kw;
    if (rMatch.value === 'any') pr.match = 'any';
    return {
      ...(d ? { id: d.id } : {}),
      key: (keyIn as HTMLInputElement).value.trim(),
      label: (labelIn as HTMLInputElement).value.trim() || null,
      enabled: (enabledChk as HTMLInputElement).checked,
      priority: Number((prioIn as HTMLInputElement).value) || 0,
      match_kinds: Object.keys(kindBoxes).filter((k) => kindBoxes[k].checked),
      include_channels: incCh.value, exclude_channels: excCh.value,
      exclude_bots: (botChk as HTMLInputElement).checked,
      min_chars: Number((minIn as HTMLInputElement).value) || 0,
      lookback_days: (lookIn as HTMLInputElement).value.trim() ? Number((lookIn as HTMLInputElement).value) : null,
      prefilter_level: 0,   // 레버 폐기 — rules 가 정본
      prefilter_rules: Object.keys(pr).length ? pr : null,
      criteria_md: critIn.value.trim() || null,
      format_md: fmtIn.value.trim() || null,
      target_category: String(catIn.value || '').trim() || null,
      default_type: typeSel.value || null,
      name_prefix: (prefixIn as HTMLInputElement).value.trim() || null,
      thread_aware: (threadChk as HTMLInputElement).checked,
      batch_size: Number((batchIn as HTMLInputElement).value) || 3,
      batch_max_msgs: Number((batchMsgIn as HTMLInputElement).value) || 20,
      mode: modeSel.value,
      session_ref: (sessIn as HTMLInputElement).value.trim() || null,
      model: modelSel.value || null, effort: effortSel.value || null,
      requester: (reqIn as HTMLInputElement).value.trim() || null,
      // 조각: 손대지 않은(빈) 칸은 **키를 아예 안 보낸다** — 미지정=기본값이고, 빈 문자열은 '그 조각을 뺀다'는
      //  다른 뜻이기 때문이다. 조각 UI 를 아직 안 불러왔으면 이 필드를 건드리지 않는다(기존 설정 보존).
      ...(sectionsLoaded.v ? { prompt_sections: (() => {
        const o: Record<string, string> = {};
        for (const [id, ta] of Object.entries(sectionInputs)) if (ta.value !== '') o[id] = ta.value;
        return Object.keys(o).length ? o : null;
      })() } : {}),
    };
  };

  // ── 프롬프트 조각 덮어쓰기(#1419-B) ──────────────────────────────────────────
  //  프롬프트가 코드에 통으로 박혀 있으면 무엇이 나가는지 파악도 수정도 어렵다. 조각만 덮어쓴다.
  //  · 편집란은 **비어 있는 게 기본** — 비면 코드 기본값이 나가고, 제품 개선이 계속 흘러든다.
  //  · [기본값 보기]로 원문을 펼쳐 확인한 뒤 덮어쓴다(무엇을 대체하는지 모르면 덮어쓸 수 없다).
  //  · 대상 지정·안전 문구는 불변이라 여기 없다(스코프 누출·주입 방어 상실 방지).
  const SECTION_HINT: Record<string, string> = {
    intro: '배치 첫 문장. 증류기 이름과 자료 건수를 알립니다.',
    criteria: '무엇을 지식화할지. 위 [지식화 기준] 칸이 이 조각의 저장소입니다 — 여기에 쓰면 그 칸 대신 이게 나갑니다.',
    format: '결과 문서 형식. 위 [문서 형식] 칸이 저장소입니다.',
    thread: '스레드를 한 덩어리로 묶으라는 지시. 스레드 묶기를 끄면 애초에 안 나갑니다.',
    procedure: '절차 ①~⑤(본문 읽기·중복확인·저장·허용선·skip).',
  };
  const sectionInputs: Record<string, HTMLTextAreaElement> = {};
  const sectionDefs: Record<string, HTMLElement> = {};   // [기본값 보기] 본문 — 설정이 바뀌면 **이것만** 갱신한다
  const sectionsHost = el('div', {}, el('p', { class: 'admin-hint', text: '지시문 조각을 불러오는 중…' }));
  const sectionsLoaded = { v: false };
  const defText = (v) => v.def || '(이 조각은 지금 설정에선 나가지 않습니다)';

  // ⚠ **이미 만든 편집란을 다시 만들지 않는다.** 미리보기는 입력이 바뀔 때마다(디바운스 0.6초) 갱신되는데,
  //  그 응답마다 textarea 를 새로 그리면 **사람이 지금 타이핑하던 요소가 DOM 에서 사라진다** — 값은 서버가
  //  override 로 돌려줘 복원되지만 **포커스·커서·선택영역이 매번 날아가** 문장을 이어 쓸 수가 없다
  //  (= 조각 편집이 사실상 불가능. 실측 #1557: 0.6초마다 activeElement 가 BODY 로 빠졌다).
  //  편집란의 값은 **사람이 소유**한다 — 서버 응답이 갱신해야 할 것은 [기본값 보기] 본문뿐이다.
  //  (scripts/distiller-sections-stable.test.mjs 가 이 함수를 산출물에서 꺼내 두 번 호출해 잠근다 —
  //   이름·자유변수를 바꾸면 그 테스트도 함께 고쳐야 한다.)
  function renderSections(views: any[]): void {
    if (sectionsLoaded.v) {
      for (const v of (views || [])) {
        const pre = sectionDefs[v.id];
        if (pre) pre.textContent = defText(v);
      }
      return;
    }
    const rows: HTMLElement[] = [];
    for (const v of (views || [])) {
      const ta = el('textarea', { rows: '5', class: 'dst-in', placeholder: '비어 있으면 기본값이 나갑니다' }) as HTMLTextAreaElement;
      ta.value = typeof v.override === 'string' ? v.override : '';
      sectionInputs[v.id] = ta;
      const pre = el('pre', { class: 'dst-sec-def', text: defText(v) });
      sectionDefs[v.id] = pre;
      rows.push(el('div', { class: 'dst-sec' },
        el('div', { class: 'mini-meta' },
          el('span', { class: 'pill', text: v.label }),
          el('span', { class: 'admin-hint', text: ' ' + (SECTION_HINT[v.id] || '') })),
        ta,
        el('details', { style: 'margin-top:4px' },
          el('summary', { class: 'admin-hint', text: '기본값 보기' }), pre)));
    }
    sectionsLoaded.v = true;
    sectionsHost.replaceChildren(
      el('p', { class: 'admin-hint', text: '비워 두면 코드 기본값이 나갑니다(제품이 개선되면 자동 반영). 내용을 쓰면 그 조각만 대체됩니다. 대상 자료 지정과 안전 문구는 바꿀 수 없어 여기 없습니다.' }),
      ...rows);
  }

  // ── 반사판(우측) — "지금 이 설정이 무엇을 집는가"를 입력 즉시 보여준다 ──────────
  //  종전 화면의 가장 큰 불편이 여기였다: 미리보기가 **저장된 값**만 읽고 폼 맨 아래에 나와서,
  //  채널 하나 고치려면 저장→스크롤→확인을 반복해야 했다(새 증류기는 미리보기 자체가 거부됐다).
  //  이제 입력이 바뀌면 draft 로 서버에 물어 오른쪽이 갱신된다 — 저장 없이. DB 는 안 건드린다.
  //  #1564: 지시문 전문이 접힌 details(max-height 300px) 대신 **남은 높이를 다 쓰는 영역**이 됐다.
  const rBacklog = el('div', { class: 'dst-reflect-num', text: '—' });
  const rFilter = el('p', { class: 'admin-hint', style: 'margin:2px 0 0' });
  const rLoss = el('p', { style: 'margin:6px 0 0;font-size:12px' });
  const rSample = el('div', { class: 'dst-reflect-sample' });
  const rPrompt = el('pre', { class: 'dst-reflect-prompt' });
  const rState = el('p', { class: 'admin-hint', style: 'margin:0', text: '설정을 바꾸면 저장하지 않아도 여기가 바로 바뀝니다.' });

  function paint(r) {
    rState.textContent = '';
    rBacklog.textContent = '읽을 자료 ' + Number(r.backlog || 0).toLocaleString() + '건';
    const fi = r.filter_impact;
    if (!fi) { rFilter.textContent = ''; rLoss.replaceChildren(); }
    else if (!fi.filtered) {
      rFilter.textContent = '거르지 않고 전부 AI에게 보냅니다.';
      rLoss.replaceChildren();
    } else {
      rFilter.textContent = '거른 뒤 AI에게 보내는 것 ' + Number(fi.pass_msgs).toLocaleString() + '건'
        + (fi.pass_pct != null ? ' (' + fi.pass_pct + '%)' : '') + ' · 범위 전체 ' + Number(fi.msgs).toLocaleString() + '건';
      // ⚠ 유실률이 이 화면의 핵심 숫자다 — 절감은 눈에 띄지만 유실은 안 보여주면 아무도 모른 채 지식을 버린다.
      if (fi.loss_pct == null) {
        rLoss.replaceChildren(el('span', { class: 'admin-hint', text: '이 범위에서 지식이 된 대화가 아직 없어, 놓치는 비율을 잴 수 없습니다.' }));
      } else {
        const bad = fi.loss_pct > 5;
        replaceKids(rLoss,el('b', { style: 'color:var(' + (bad ? '--coral-text' : '--mint-deep') + ')',
          text: (bad ? '⚠ ' : '✓ ') + '놓치는 비율 ' + fi.loss_pct + '% — 이미 지식이 된 대화 중 이만큼이 지금 조건에 걸러집니다' }),
          el('span', { class: 'admin-hint', text: ' (' + (fi.known_threads - fi.kept_known) + '/' + fi.known_threads + '건)' }),
          bad ? el('p', { class: 'admin-hint', style: 'margin:4px 0 0', text: '그만큼 앞으로 지식을 놓칩니다. AI에게 "이 증류기 사전 필터를 튜닝해줘"라고 하면 실제 데이터로 알맞은 값을 찾아 넣어 줍니다.' }) : null);
      }
    }
    rSample.replaceChildren();
    for (const s of (r.sample || [])) {
      rSample.append(el('div', { class: 'dsl-sample' },
        el('span', { class: 'dsl-chip', text: String(s.channel || KIND_LABEL[s.kind] || s.kind || '') }),
        el('span', { class: 'dsl-sample-t', text: String(s.title || '(제목 없음)').slice(0, 80) })));
    }
    if (!(r.sample || []).length) {
      rSample.append(el('p', { class: 'admin-hint', text: '지금 조건으로 읽을 자료가 0건입니다 — 채널 이름이 맞는지, 거르기 조건이 너무 센지, 우선순위가 높은 다른 증류기가 먼저 읽는지 확인하세요.' }));
    }
    rPrompt.textContent = r.prompt || '';
    if (r.sections) {
      // 조각이 처음 실리면 collect() 결과에 prompt_sections 가 더해진다 — 그때 '저장된 상태'의 기준선을
      //  다시 잡지 않으면 아무것도 안 건드렸는데 '저장 안 된 변경'으로 보인다. 사람이 이미 손댔으면 그대로 둔다.
      const first = !sectionsLoaded.v;
      renderSections(r.sections);
      if (first && !touched) markClean();
    }
  }

  let seq = 0, timer: any = null;
  async function refresh() {
    const my = ++seq;
    rState.textContent = '계산 중…';
    try {
      const body: any = { draft: collect(), limit: 8 };
      if (!isNew) body.key = d.key;
      const r = await api('/api/ui/org/distillers/preview', { method: 'POST', body: JSON.stringify(body) });
      if (my !== seq) return;            // 늦게 온 응답이 최신 결과를 덮지 않게
      paint(r);
    } catch (e) {
      if (my !== seq) return;
      rState.textContent = '미리보기 실패: ' + e.message;
      // ⑤ 지시문 조각도 **이 응답 하나**에서 온다 — 실패를 그 단계에도 알리지 않으면
      //  "설명 문구만 있고 편집란이 없는" 텅 빈 화면이 되어 사람이 원인을 못 짚는다(#1557).
      if (!sectionsLoaded.v) {
        sectionsHost.replaceChildren(el('p', { class: 'admin-hint',
          text: '지시문 조각을 불러오지 못했습니다(미리보기 실패: ' + e.message + '). 설정을 바꾸면 다시 시도합니다.' }));
      }
    }
  }

  // 지시문 전문은 사람이 통째로 들고 나가 검토하는 물건이다("이 지시문 좀 봐줘") — 6천 자를 직접 드래그하지 않게.
  const copyBtn = el('button', { type: 'button', class: 'btn-text', text: '복사' });
  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(rPrompt.textContent || ''); toast('지시문 전문을 복사했습니다'); }
    catch { toast('복사하지 못했습니다 — 직접 선택해 복사하세요', true); }
  });
  copyBtn.addEventListener('click', (ev) => ev.stopPropagation());   // summary 안의 버튼 — 접힘을 건드리지 않는다
  const reflect = el('aside', { class: 'card dst-reflect dsl-preview', 'aria-label': '지금 설정으로 읽을 자료' },
    el('p', { class: 'dsl-eyebrow', text: '지금 설정이면' }),
    rBacklog, rFilter, rLoss, rState,
    el('p', { class: 'dst-reflect-sub', text: '읽게 될 자료 예시' }), rSample,
    el('details', { class: 'dsl-prompt' },
      el('summary', {}, el('span', { text: 'AI에게 실제로 보내는 지시문 보기' }), copyBtn),
      rPrompt));

  // ── 폼 — 좌측 목차 없이 **번호 섹션 세 개**가 한 번에 보인다(#3830 4차). 카드 하나가 곧 "한 가지 질문".
  //   ① 어떤 자료를 읽을까요 ② 무엇을 지식으로 남길까요 ③ 지식은 어디로 갈까요 — 그리고 맨 아래 접힌 「고급 설정」.
  //   ⚠ 섹션은 모두 같은 DOM 에 살아 있다(가려 두는 것이 아니다) — 반사판·저장·dirty 판정이 전부 이 입력들을 읽는다.
  const intro = (t: string) => el('p', { class: 'dst-intro', text: t });
  const sec = (n: string, title: string, desc: string | null, ...kids: any[]) =>
    el('section', { class: 'card dsl-sec' },
      el('div', { class: 'dsl-sec-h' },
        el('div', { class: 'dsl-sec-tt' }, el('span', { class: 'dsl-num', 'aria-hidden': 'true', text: n }), el('h2', { class: 'dsl-sec-t', text: title })),
        desc ? el('p', { class: 'dsl-sec-d', text: desc }) : null),
      ...kids);

  const secName = el('section', { class: 'card dsl-sec dsl-sec-name' },
    el('div', { class: 'dsl-name-row' },
      F('이름', '목록에 보일 이름입니다. 예: 제품팀 슬랙 대화', labelIn),
      el('label', { class: 'dsl-on' }, enabledChk, el('span', {}, el('b', { text: '켜 두기' }), el('span', { class: 'dsl-on-d', text: '켜 두면 새 자료가 쌓일 때마다 자동으로 읽습니다' })))));

  const secRead = sec('1', '어떤 자료를 읽을까요', '여기서 고른 자료만 이 증류기가 읽습니다. 아무것도 고르지 않으면 전부 읽습니다.',
    F('자료 종류', '여러 개 골라도 됩니다. 슬랙 대화만 읽는 증류기면 「슬랙」만 고르세요.', kindsWrap),
    F('읽을 채널', '아래 목록에서 누르면 들어갑니다(오타가 없습니다). 「안 읽은 n건」은 그 채널에 아직 지식이 되지 않은 자료 수입니다.', el('div', {}, incCh, chPick)),
    F('읽지 않을 채널', '알림 봇·모니터링처럼 지식이 될 게 없는 채널을 적으세요.', excCh),
    el('label', { class: 'inline' }, botChk, el('span', { text: ' 봇이 쓴 메시지는 읽지 않기' })));

  const secKeep = sec('2', '무엇을 지식으로 남길까요', 'AI가 자료를 읽고 「남길까, 말까」를 판단하는 기준입니다. 우리 팀 말로 적으면 됩니다. 비워 두면 기본 기준이 적용됩니다 — 결정·합의·사실·절차는 남기고, 잡담·인사·한 번뿐인 이야기는 건너뜁니다.',
    F('남길 기준', '무엇이 남길 가치가 있고 무엇이 아닌지 그대로 적으세요. 이 문장이 AI의 판단 기준이 됩니다.', critIn),
    F('지식 문서 모양', '제목을 어떻게 짓고 본문을 어떤 순서로 쓸지. 비워 두면 기본 모양(분명한 제목 + 나중에 동료가 그것만 읽고 일할 수 있는 본문)으로 씁니다.', fmtIn));

  const secDest = sec('3', '지식은 어디로 갈까요', '만들어진 지식이 들어갈 자리와 모양입니다. 보통은 그대로 두어도 됩니다.',
    row2(
      F('카테고리', '만들어진 지식을 항상 이 카테고리에 넣습니다.', catIn),
      F('문서 유형', '지식이 어떤 종류의 문서인지.', typeSel)),
    el('label', { class: 'inline' }, threadChk, el('span', { text: ' 대화 묶음(글과 답글)을 하나의 지식으로 — 대화에는 켜 두고, 문서·메일이면 끄세요' })));

  // 고급 설정 — 접힘. 안은 다섯 묶음(각각 또 접힘).
  const adv = el('details', { class: 'dsl-adv' },
    el('summary', {}, el('span', { class: 'dsl-adv-t', text: '고급 설정' }),
      el('span', { class: 'dsl-adv-d', text: '리브가 알맞게 정해 두었습니다 — 보통은 바꿀 일이 없습니다.' })));
  const advBody = el('div', { class: 'dsl-adv-body' },
    fold('읽는 범위 세부 — 글자 수 · 기간 · 우선순위 · 식별자',
      intro('읽을 자료를 더 좁히고 싶거나, 여러 증류기가 같은 자료를 읽을 수 있을 때 순서를 정할 때 씁니다.'),
      row2(
        F('본문 최소 글자 수', '이보다 짧은 자료는 읽지 않습니다. 0이면 제한 없음.', minIn),
        F('기간(일)', '최근 며칠치만 읽습니다. 비우면 과거 전체를 읽습니다.', lookIn)),
      F('우선순위', '여러 증류기가 같은 자료를 읽을 수 있을 때 숫자가 큰 증류기가 읽습니다. 자료 하나는 증류기 하나만 읽습니다. 숫자를 낮게 두고 범위를 넓히면 나머지 전부를 받는 「안전망」이 됩니다.', prioIn),
      F('식별자', isNew ? '이 설정 화면의 주소에 쓰이는 영문 이름(a-z0-9._-). 비우면 자동으로 만듭니다.' : '주소에 쓰이는 영문 이름입니다. 만든 뒤에는 바꾸지 않습니다.', keyIn)),
    fold('보내기 전 거르기 — AI 비용을 줄이는 자리',
      intro('AI가 읽는 데는 비용이 듭니다. 그래서 AI에게 보내기 전에 서버가 먼저 걸러낼 수 있습니다 — 다만 거를수록 값진 것도 함께 놓칠 수 있습니다. 전부 비워 두면 거르지 않고 다 보냅니다. 오른쪽 「놓치는 비율」을 보면서 정하세요.'),
      el('p', { class: 'dst-callout' },
        el('b', { text: '값을 감으로 정하지 마세요. ' }),
        el('span', { text: 'AI에게 "이 증류기 사전 필터를 튜닝해줘"라고 하면 우리 채널의 실제 자료로 계산해 알맞은 값을 넣어 줍니다(AI 호출 없이 계산만 하므로 비용이 없습니다).' })),
      F('대화 최소 글자 수', '이보다 짧은 대화는 보내지 않습니다. 짧은 잡담을 거르는 가장 안전한 조건입니다.', rChr),
      F('꼭 들어 있어야 하는 말', '이 말이 들어 있는 대화만 보냅니다. 「결정」「장애」 같은 일반적인 말보다 우리 팀에서만 쓰는 말이 훨씬 잘 듣습니다.', rKw),
      F('그 말이 최소 몇 번', '위 목록의 말이 한 대화에 몇 번 이상 나와야 보낼지.', rDec),
      fold('참여자 수·메시지 수 조건 — 조심해서',
        el('p', { class: 'admin-hint', text: '⚠ 이 두 조건은 놓치는 것이 많습니다 — 한 사람이 길게 쓴 분석 보고서, 짧지만 결론이 담긴 대화가 걸러집니다. 실제로 네 조건을 전부 걸었을 때 이미 지식이 된 대화의 21%가 걸러진 적이 있습니다.' }),
        row2(F('최소 참여자 수', '이 인원 이상이 참여한 대화만', rAut), F('최소 메시지 수', '이 개수 이상 메시지가 있는 대화만', rMsg))),
      F('조건을 어떻게 묶을까요', '「하나만 맞아도」를 권합니다. 「전부 맞아야」는 값진 대화를 많이 버립니다.', rMatch)),
    fold('지식 이름 규칙',
      F('지식 이름 앞말', '만들어진 지식의 이름을 이 말로 시작하게 합니다. 비우면 없음.', prefixIn)),
    fold('AI 실행 방식 — 한 번에 얼마나 · 누구 계정으로 · 어떤 모델로',
      row2(
        F('한 번에 읽을 대화 수', 'AI가 한 번에 읽는 대화 묶음 수입니다(자료 건수가 아닙니다). 2~3을 권합니다.', batchIn),
        F('한 번에 담을 메시지 상한', '대화를 담다가 이 수를 넘으면 멈춥니다. 첫 대화는 예외로 통째로 담습니다. 20~40을 권합니다.', batchMsgIn)),
      F('실행 계정', '이 사람의 AI 계정으로 돌고, 비용도 그 계정에 붙습니다.', reqIn),
      row2(
        F('실행 방식', '매번 새 세션에서 돌리면 이전 판단에 끌려가지 않습니다(권장).', modeSel),
        F('늘 켜 둔 세션 id', '「늘 켜 둔 AI 세션에 보내서」일 때만 필요합니다.', sessIn)),
      row2(
        F('모델', '남길 기준이 까다로우면 더 좋은 모델을 권합니다. 정확해지는 만큼 비쌉니다.', modelSel),
        F('추론 강도', '높일수록 정확하고 비쌉니다.', effortSel))),
    fold('AI 지시문 — 실제로 보내는 문장',
      intro('AI에게 실제로 보내는 문장을 조각별로 손봅니다. 비워 두면 기본 문장이 나가고, 제품이 좋아지면 자동으로 따라옵니다.'),
      sectionsHost));
  adv.append(advBody);
  const showStep = (_k: string) => { adv.open = true; };   // 저장 검증이 고급 칸(식별자)을 가리킬 때 펼친다

  // ── 저장 안 된 변경 추적 ────────────────────────────────────────────────────
  //  페이지가 되면서 새로고침·뒤로가기로 폼을 잃을 수 있게 됐다. 지금 상태가 저장본과 다른지를 늘 보인다.
  const dirtyBadge = el('span', { class: 'dst-dirty', text: '저장 안 된 변경', hidden: 'hidden' });
  let baseline = '';
  let touched = false;   // 사람이 한 번이라도 건드렸나 — 조각 로드 시 기준선 재촬영 여부 판단에 쓴다
  const isDirty = () => JSON.stringify(collect()) !== baseline;
  function paintDirty() { (dirtyBadge as HTMLElement).hidden = !isDirty(); }
  function markClean() { baseline = JSON.stringify(collect()); paintDirty(); }

  // ── 저장 ──────────────────────────────────────────────────────────────────
  const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', text: isNew ? '증류기 만들기' : '저장' });
  async function save() {
    const body = collect();
    if (!body.key) {
      //  비개발자는 식별자를 모른다 — 비어 있으면 만들어 준다(주소에만 쓰이는 값이라 뜻이 없어도 된다).
      const auto = 'd-' + Math.random().toString(36).slice(2, 8);
      (keyIn as HTMLInputElement).value = auto; body.key = auto;
    }
    // '/new' 가 신규 생성의 주소라, key 가 'new' 면 그 증류기의 설정 페이지를 영영 열 수 없다.
    if (body.key === NEW_KEY) { showStep('basic'); toast("'new' 는 주소에서 '새 증류기'를 뜻해 식별자로 쓸 수 없습니다", true); (keyIn as HTMLInputElement).focus(); return; }
    (saveBtn as HTMLButtonElement).disabled = true;
    try {
      await api('/api/ui/org/distillers', { method: 'POST', body: JSON.stringify(body) });
      if (isNew) {
        // 만든 즉시 그 증류기의 주소로 — replace 라 뒤로가기가 '/new'(빈 폼)로 되돌아가지 않는다.
        //  해시가 바뀌므로 라우터가 이 페이지를 저장된 값으로 다시 그린다.
        dirtyGuard = null;
        toast('증류기를 만들었습니다');
        location.replace(pageHref(body.key));
        return;
      }
      toast('저장했습니다');
      titleEl.textContent = body.label || body.key;
      markClean();
    } catch (e) { toast('실패 — ' + e.message, true); }
    finally { (saveBtn as HTMLButtonElement).disabled = false; }
  }
  saveBtn.addEventListener('click', () => { void save(); });

  // ── 머리 ──────────────────────────────────────────────────────────────────
  const { nav: crumbNav, back } = crumb();
  back.addEventListener('click', (ev) => {
    if (!isDirty()) return;   // 기본 동작(해시 이동)
    ev.preventDefault();
    void (async () => {
      const go = await confirmDialog({
        title: '저장하지 않고 나갈까요?',
        message: '이 증류기 설정에 저장하지 않은 변경이 있습니다.',
        confirmText: '나가기', cancelText: '계속 편집', danger: true,
      });
      if (go) { dirtyGuard = null; location.hash = LIST_HREF; }
    })();
  });

  const titleEl = el('h1', { class: 'dst-title', text: isNew ? '새 증류기' : (d.label || d.key) });
  const headActs = el('div', { class: 'dst-head-acts' }, dirtyBadge, saveBtn);
  if (!isNew) {
    const del = el('button', { class: 'btn-text', type: 'button', text: '삭제' });
    del.addEventListener('click', () => {
      void removeDistiller(d, () => { dirtyGuard = null; location.hash = LIST_HREF; });
    });
    headActs.append(del);
  }
  const head = el('div', { class: 'dst-head' },
    el('div', { class: 'dst-head-main' }, titleEl,
      el('p', { class: 'dst-sub', text: isNew
        ? '어떤 자료를 읽고, 무엇을 지식으로 남길지 정합니다. 오른쪽에서 지금 설정으로 몇 건이 읽히는지 바로 보입니다.'
        : (d.last_run_at ? '마지막 실행 ' + relTime(d.last_run_at) + ' · ' + (d.last_status === 'ok' ? '성공' : d.last_status ? '실패' : '') : '아직 실행한 적 없음') })),
    headActs);

  const form = el('div', { class: 'dst-form' }, secName, secRead, secKeep, secDest, adv);
  page.append(crumbNav, head, el('div', { class: 'dst-grid dst-grid-2' }, form, reflect));

  // 입력 변경 → 디바운스 → 반사판 갱신. 타이핑마다 서버를 때리지 않는다.
  const onEdit = () => { touched = true; paintDirty(); clearTimeout(timer); timer = setTimeout(refresh, 600); };
  page.addEventListener('input', onEdit);
  page.addEventListener('change', onEdit);
  // ⌘/Ctrl+S — ⑤ 지시문은 조각이 5개라 폼이 길다. 저장하려고 머리까지 스크롤해 올라가지 않아도 되게.
  page.addEventListener('keydown', (ev: KeyboardEvent) => {
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 's' || ev.key === 'S')) { ev.preventDefault(); void save(); }
  });

  dirtyGuard = isDirty;
  markClean();      // 방금 그린 값이 곧 저장된 값이다(조각이 실리면 paint 가 기준선을 한 번 더 잡는다)
  void refresh();   // 페이지를 열면 바로 지금 상태를 보여준다(버튼을 누르게 하지 않는다)
  return page;
}

// ── 실행 잡 ────────────────────────────────────────────────────────────────
//  #1618 에서 단계 공용 카드(context-stage-job.ts)로 갈아탔다. 종전 전용 구현과 달라진 것 셋:
//   · 만들면 **켠다**(종전엔 꺼진 채 만들고 다시 켜기를 눌러야 했다 — 화면이 경고하는 '멈춤' 상태를 손수 만드는 셈).
//   · 주기·끄기·지금 실행이 카드 안에 있다(종전엔 "[AI 능력 ▸ 자동화]에서 조정합니다"라고 내보냈다).
//   · 의뢰자 부재를 잡아 그 자리에서 지정하게 한다(없으면 매 주기 조용히 error 였다).
async function runJobCard(rerender) {
  return stageJobCard({
    stage: '증류',
    actions: ['distill_sources_headless', 'distill_sources'],
    create: {
      id: 'distill-sources-headless', label: '자료 증류 (수집된 원본→지식, 헤드리스)',
      action: 'distill_sources_headless', params: {}, interval_sec: 1800,
      note: '켜진 증류기별로 미증류 자료 배치를 헤드리스 AI 세션에 접수. 증류기가 없으면 전 자료 공통 기본 증류.',
    },
    missingLine: '증류 자동 실행이 없습니다 — 증류기를 만들어도 자료가 지식이 되지 않습니다.',
    // 분류와 같은 이유 — 구 세션주입판(distill_sources)은 params.session 이 있어야 돈다.
    unrunnable: (j) => (j.action === 'distill_sources' && !(j.params && j.params.session))
      ? '지금 등록된 증류 자동 실행은 늘 켜 둔 AI 세션이 있어야 도는 옛 방식인데, 그 세션이 정해져 있지 않습니다 — 이대로 켜면 매번 실패합니다.'
      : null,
    usesAi: true,
  }, rerender);
}
