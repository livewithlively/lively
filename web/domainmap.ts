// domainmap.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { VOCAB_CRUD_DEFAULT_REPO, api, el, errorNote, fmtNum, loadRepos, pageHead, relTime, stat, state } from './core.js';
import { actTypeTag } from './dashboard.js';
import { skeleton } from './learn.js';
import { field } from './admin.js';

// 도메인 부채(debt) 분류·표시 — 구 app.js 에서 정의 누락이던 미정의 전역(도메인맵 탭 도입 35353c5 부터의 잠재버그)을
//  v6 TS 분할 시 백엔드 모델 기준으로 정의(2026-06-24). domain-debt 평가기(src/domainmap/core/domain-debt.ts)가
//  severity 를 title 접두사로 인코딩한다: '의도-구조 괴리…'=should_no_is, '도메인 구조 증발…'=vanished,
//  '도메인 구조 침식…'=eroded. 그 외(flagStructuralDrift 등 커스텀 title)는 structural_drift 로 폴백.
function DM_SEV_OF(title: string): string {
  const t = title || '';
  if (t.startsWith('의도-구조 괴리')) return 'should_no_is';
  if (t.startsWith('도메인 구조 증발')) return 'vanished';
  if (t.startsWith('도메인 구조 침식')) return 'eroded';
  return 'structural_drift';
}
// 정렬 순위 — should↔is 괴리 먼저, 그다음 구조 신호(증발>침식>드리프트). 표시 라벨(한국어).
const DM_SEV_RANK: Record<string, number> = { should_no_is: 0, vanished: 1, eroded: 2, structural_drift: 3 };
const DM_SEV_LABEL: Record<string, string> = { should_no_is: '의도 괴리', vanished: '구조 증발', eroded: '구조 침식', structural_drift: '구조 변화' };
// 커밋→구조(is) 변경 op 라벨 — change_log op(insert/update/delete/restore/rename). 미정의 op 는 호출부에서 raw 폴백.
const DM_OP_LABEL: Record<string, string> = { insert: '추가', update: '수정', delete: '제거', rename: '이름변경', restore: '복원', added: '추가', removed: '제거', modified: '수정' };

// ════════════════════════════════════════════
// 도메인 맵(#/domainmap?repo=) — should/is/debt 코드구조 뷰.
// ════════════════════════════════════════════
async function renderDomainmap(view, params) {
  view.replaceChildren(skeleton('도메인 맵을 불러오는 중'));
  const repos = await loadRepos();
  let repo = (params && params.get('repo')) || state.dmRepo
    || (repos.includes(VOCAB_CRUD_DEFAULT_REPO) ? VOCAB_CRUD_DEFAULT_REPO : repos[0]);
  if (!repos.includes(repo)) repo = repos[0];
  state.dmRepo = repo;

  const head = pageHead('도메인 맵', '각 도메인에서 설계 의도와 실제 코드를 나란히 놓고, 둘 사이의 차이를 확인합니다. 의도가 어떻게 바뀌어 왔는지, 어떤 커밋이 코드를 바꿨는지도 볼 수 있습니다.', [], '맵');

  // 준비중 안내 — 탭 최상단 경고(프로젝트 #342). 아직 불완전한 기능임을 알린다.
  //  이 탭(#/domainmap=renderDomainmap) 전용 — 카테고리 제품 화면과 공유하는 domainmapBody 엔 넣지 않는다.
  const wip = el('div', { class: 'dm-wip', role: 'note' },
    el('div', { class: 'dm-wip-title', text: '⚠ 아직 준비 중인 기능입니다' }),
    el('div', { class: 'dm-wip-sub', text: '이 화면은 개발 중이라 내용이 불완전하거나 실제와 다를 수 있습니다. 참고용으로만 봐 주세요.' }),
  );

  // repo 셀렉터 — 복수일 때만(단일이면 라벨 생략, 작업현황/어휘관리와 동일 패턴).
  let repoBar: any = null;
  if (repos.length > 1) {
    const sel = el('select', { class: 'flt-domain' });
    for (const r of repos) sel.append(el('option', { value: r, text: r }));
    sel.value = repo;
    sel.addEventListener('change', () => { state.dmRepo = sel.value; location.hash = '#/domainmap?repo=' + encodeURIComponent(sel.value); });
    repoBar = el('div', { class: 'filter-bar' }, el('span', { class: 'field-label', text: '레포' }), sel);
  }

  let data: any;
  try {
    data = await api('/api/ui/domainmap/map?' + new URLSearchParams({ repo, limit: '150' }));
  } catch (e) {
    view.replaceChildren(...[wip, head, repoBar, errorNote(e, '도메인 맵을 불러오지 못했습니다')].filter(Boolean));
    return;
  }
  const nodes = [wip, head, repoBar,
    ...domainmapBody(data, repos.length > 1 ? repo : null)].filter(Boolean);
  view.replaceChildren(...nodes);
}

// 도메인맵 본문 빌더 — fetched data(/api/ui/domainmap/map)에서 통계 카드 + 도메인/괴리/이력 섹션 노드 배열을 만든다.
//  renderDomainmap(#/domainmap)과 카테고리 제품(space=product) 화면이 공유(동작 동일, 표면만 다름).
//  firstSectionHint: 첫 섹션(도메인 목록) 헤더 옆 보조 라벨(예: 복수 레포일 때 레포명) — 없으면 생략.
function domainmapBody(data, firstSectionHint) {
  const domains = data.domains || [];
  const debts = (data.debts || []).filter((d) => d.status !== 'resolved' && d.status !== 'dismissed');
  const shoulds = data.should_changes || [];
  const isChanges = data.is_commit_changes || [];

  // ── 요약 스탯 ──
  const withShould = domains.filter((d) => d.should && d.should.trim()).length;
  const gapCount = debts.filter((d) => DM_SEV_OF(d.title) === 'should_no_is').length;
  const statCard = el('div', { class: 'card' }, el('div', { class: 'stat-row' },
    stat(fmtNum(domains.length), '도메인', '개'),
    stat(fmtNum(withShould), '의도(should) 설정됨', '/ ' + domains.length),
    stat(fmtNum(debts.length), '괴리·이슈(debt)', gapCount ? ('· 괴리 ' + gapCount) : '건'),
  ));

  // ── 도메인별 should | is | debt ──
  const tone = (d) => (d.debts > 0 ? ' has-debt' : '');
  function domainRow(d) {
    const hasShould = !!(d.should && d.should.trim());
    return el('div', { class: 'dm-dom' + tone(d) },
      el('div', { class: 'dm-dom-head' },
        el('span', { class: 'mono dm-dom-key', text: d.key }),
        d.name && d.name !== d.key ? el('span', { class: 'dm-dom-name', text: d.name }) : null,
        d.cross_cutting ? el('span', { class: 'dm-tag', text: '횡단' }) : null,
        d.space === 'business' ? el('span', { class: 'dm-tag', text: '비즈니스' }) : null,
        d.debts > 0 ? el('span', { class: 'dm-debt-chip', text: '괴리 ' + fmtNum(d.debts) }) : null,
      ),
      el('div', { class: 'dm-axes' },
        el('div', { class: 'dm-axis dm-should' },
          el('span', { class: 'dm-axis-label', text: '의도 · should' }),
          hasShould
            ? el('span', { class: 'dm-axis-val', text: d.should })
            : el('span', { class: 'dm-axis-empty', text: '아직 설정 안 됨' })),
        el('div', { class: 'dm-axis dm-is' },
          el('span', { class: 'dm-axis-label', text: '구조 · is' }),
          el('span', { class: 'dm-axis-val' },
            el('strong', { text: fmtNum(d.units) }), ' 코드',
            d.entities ? el('span', {}, ' · ', el('strong', { text: fmtNum(d.entities) }), ' 엔티티') : null,
            d.proposed ? el('span', { class: 'dm-prop', text: ' · 제안 ' + fmtNum(d.proposed) }) : null,
            (!d.units && !d.entities) ? el('span', { class: 'dm-axis-empty', text: '  매핑된 코드 없음' }) : null)),
      ),
    );
  }

  // ── 괴리(debt) — should↔is 괴리 먼저, 그다음 구조 신호 ──
  const debtSorted = [...debts].sort((a, b) => DM_SEV_RANK[DM_SEV_OF(a.title)] - DM_SEV_RANK[DM_SEV_OF(b.title)]);
  function debtRow(dt) {
    const sev = DM_SEV_OF(dt.title);
    return el('div', { class: 'dm-debt dm-sev-' + sev },
      el('div', { class: 'dm-debt-top' },
        el('span', { class: 'dm-sev-tag', text: DM_SEV_LABEL[sev] }),
        el('span', { class: 'dm-debt-title', text: dt.title }),
        dt.status && dt.status !== 'open' ? el('span', { class: 'dm-debt-status', text: dt.status }) : null),
      dt.detail ? el('div', { class: 'dm-debt-detail', text: dt.detail }) : null,
    );
  }

  // ── 의도(should) 변경 이력 — 누가·어떤 작업으로 의도를 어떻게 바꿨나(before→after) ──
  const valOr = (s, fallback) => (s && s.trim() ? s : fallback);
  function shouldChangeRow(c) {
    return el('div', { class: 'dm-change' },
      el('div', { class: 'dm-change-top' },
        el('span', { class: 'mono', text: c.domain_key || ('#' + c.domain_id) }),
        c.domain_name ? el('span', { class: 'dm-change-dom', text: c.domain_name }) : null,
        el('span', { class: 'dm-change-when', text: relTime(c.at) })),
      el('div', { class: 'dm-diff' },
        el('div', { class: 'dm-diff-side dm-before' },
          el('span', { class: 'dm-diff-label', text: '이전' }),
          el('span', { class: 'dm-diff-val', text: valOr(c.should_before, '(없음)') })),
        el('span', { class: 'dm-diff-arrow', 'aria-hidden': 'true', text: '→' }),
        el('div', { class: 'dm-diff-side dm-after' },
          el('span', { class: 'dm-diff-label', text: '이후' }),
          el('span', { class: 'dm-diff-val', text: valOr(c.should_after, '(없음)') }))),
      el('div', { class: 'dm-change-by' },
        c.activity_id
          ? el('span', { class: 'dm-by-act' }, actTypeTag(c.activity_type), el('span', { class: 'dm-act-title', text: c.activity_title || '' }))
          : el('span', { class: 'dm-change-noact', text: '작업 귀속 없음' }),
        el('span', { class: 'dm-change-who', text: (c.author_person || c.actor_id || '미상') + (c.author_agent ? ' · ' + c.author_agent : '') })),
    );
  }

  // ── 커밋 → 구조(is) 변경 이력 — 어떤 커밋이 code_unit/매핑을 어떻게 바꿨나 ──
  function isChangeRow(c) {
    const label = c.entity_type === 'code_unit' ? (c.code_path || c.code_label || ('code_unit #' + c.entity_id))
      : c.entity_type === 'mapping' ? ('매핑' + (c.domain_key ? ' → ' + c.domain_key : ''))
        : (c.entity_type + ' #' + c.entity_id);
    return el('div', { class: 'dm-change' },
      el('div', { class: 'dm-change-top' },
        el('span', { class: 'dm-op-tag', text: DM_OP_LABEL[c.op] || c.op }),
        el('span', { class: 'mono dm-is-ent', text: label }),
        el('span', { class: 'dm-change-when', text: relTime(c.at) })),
      el('div', { class: 'dm-change-by' },
        el('span', { class: 'dm-by-act' },
          // is(코드구조) 변경은 커밋에서 온다 — 유형이 아니라 commit_sha 로 식별(프로젝트 #182). 정적 '커밋' 칩.
          el('span', { class: 'act-type tone-mint' }, el('span', { class: 'act-type-dot', 'aria-hidden': 'true' }), '커밋'),
          el('span', { class: 'dm-act-title', text: c.activity_title || '' })),
        c.commit_sha ? el('span', { class: 'mono dm-commit', text: c.commit_sha.slice(0, 8) }) : null,
        el('span', { class: 'dm-change-who', text: (c.author_person || c.actor_id || '미상') + (c.author_agent ? ' · ' + c.author_agent : '') })),
    );
  }

  function section(title, hint, rows, emptyText) {
    const box = el('div', { class: 'card dm-section' },
      el('div', { class: 'card-head' }, el('h2', { text: title }),
        hint ? el('span', { class: 'dm-section-hint', text: hint }) : null));
    box.append(rows.length
      ? el('div', { class: 'dm-list' }, ...rows)
      : el('div', { class: 'empty', text: emptyText }));
    return box;
  }

  return [
    statCard,
    section('도메인별 의도(should) · 구조(is) · 괴리(debt)', firstSectionHint || null,
      domains.map(domainRow), '이 레포에 도메인이 없습니다.'),
    section('괴리(debt) — 의도와 구조의 간극', gapCount ? ('should↔is 괴리 ' + fmtNum(gapCount) + '건 포함') : null,
      debtSorted.map(debtRow), '표면화된 괴리·이슈가 없습니다.'),
    section('의도(should) 변경 이력', '누가 · 어떤 작업으로 의도를 바꿨나',
      shoulds.map(shouldChangeRow), '아직 의도(should) 변경 기록이 없습니다. 의도를 설정·수정하면 여기 쌓입니다.'),
    section('커밋 → 구조(is) 변경 이력', '어떤 커밋이 코드 구조를 바꿨나',
      isChanges.map(isChangeRow), '아직 커밋이 구조(is)를 바꾼 기록이 없습니다. commit 작업이 코드를 건드리면 여기 쌓입니다.'),
  ].filter(Boolean);
}

export {
  renderDomainmap,
};
