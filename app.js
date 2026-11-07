/* 투덜이 연구소 - 앱 로직 (브라우저 localStorage 저장) */
'use strict';

const LS = 'complaint-log-v1';
const STATUSES = [['new', '불만'], ['analyzing', '분석중'], ['idea', '아이디어화'], ['doing', '실행'], ['archived', '보관']];
const IDEA_FIELDS = ['why', 'coping', 'ideal', 'idea'];
const FACES = ['😐', '😕', '😠', '😡', '🤬'];
const AI_MODEL = 'claude-haiku-5-5';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const rank = (st) => STATUSES.findIndex((s) => s[0] === st);
const pairKey = (a, b) => [a, b].sort().join('|');

/* ---------- 상태 ---------- */
const DEFAULT_CATEGORIES = ['일상', '업무', '앱/서비스', '제품', '인간관계', '돈', '건강', '기타'];
function defaults() {
  return { complaints: [], groups: [], dismissed: [], aiClusters: [], aiDismissed: [], settings: { threshold: 'normal', ai: false, apiKey: '', categories: DEFAULT_CATEGORIES.slice() } };
}
// 구버전(groupId 하나) → 신버전(groupIds 배열: 한 기록이 여러 묶음에 속할 수 있음)
function migrate(s) {
  for (const c of s.complaints) {
    if (!Array.isArray(c.groupIds)) c.groupIds = c.groupId ? [c.groupId] : [];
    delete c.groupId;
  }
  return s;
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS));
    if (s && Array.isArray(s.complaints) && Array.isArray(s.groups)) {
      const d = defaults();
      return migrate({ ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } });
    }
  } catch (e) { /* 손상된 데이터는 무시 */ }
  return defaults();
}
let state = load();
let view = 'list';
let idx = {};                 // groupId -> complaints[]
let expanded = new Set();
let selected = new Set();
let aiOff = {};               // AI 탭: 제안별로 체크를 끈 묶음 { 제안id: Set(묶음id) }
let expandedAi = new Set();   // AI 탭: 자세히 펼쳐 둔 묶음
let formTags = [];
let formIntensity = 3;
let formCategory = '';
let editingCid = null;        // 수정 중인 기록 id
let linkCid = null;           // 묶음 연결 창이 열린 기록 id
let openGid = null;           // 묶음 상세 창이 열린 묶음 id
let topCat = '';              // 기록 탭 TOP 3의 카테고리 선택 ('' = 전체)

function persist() {
  try { localStorage.setItem(LS, JSON.stringify(state)); }
  catch (e) { toast('저장 실패: 브라우저 저장 공간을 확인하세요'); }
}
function buildIndex() {
  idx = {};
  for (const c of state.complaints) for (const gid of c.groupIds) (idx[gid] ||= []).push(c);
}
// 두 묶음이 같은 기록을 공유하는가 (일부러 연결한 경우 → 합치기 제안에서 제외)
const shareMember = (a, b) => (idx[a] || []).some((c) => c.groupIds.includes(b));
function commit() { buildIndex(); persist(); render(); }

/* ---------- 그룹 통계 ---------- */
function gstats(g, since = 0, cat = '') {
  const m = (idx[g.id] || []).filter((c) => c.createdAt >= since && (!cat || c.category === cat));
  const count = m.length;
  const avg = count ? m.reduce((s, c) => s + c.intensity, 0) / count : 0;
  const tags = [...new Set((idx[g.id] || []).flatMap((c) => c.tags))];
  const times = m.map((c) => c.createdAt);
  return { members: m, count, avg, tags, score: count * avg, last: Math.max(0, ...times), first: Math.min(...times) };
}
function gtitle(g) { return g.title || (idx[g.id]?.[0]?.text || '(제목 없음)').slice(0, 40); }
// 카테고리 배지: 제목(묶음) / 불만 한 건 앞에 붙인다. 묶음에 여러 카테고리가 섞여 있으면 모두 표시.
const catBadges = (list) => list.map((c) => `<span class="badge cat">${esc(c)}</span>`).join('');
const gcats = (g) => [...new Set((idx[g.id] || []).map((c) => c.category).filter(Boolean))];
const gBadge = (g) => catBadges(gcats(g));
const cBadge = (c) => (c.category ? catBadges([c.category]) : '');
// 배지를 못 쓰는 일반 텍스트 자리용: "[업무] 제목"
const gLabel = (g, n = 24) => (gcats(g).length ? `[${gcats(g).join('·')}] ` : '') + gtitle(g).slice(0, n);
function ago(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return '방금';
  if (d < 3600) return Math.floor(d / 60) + '분 전';
  if (d < 86400) return Math.floor(d / 3600) + '시간 전';
  if (d < 86400 * 30) return Math.floor(d / 86400) + '일 전';
  return new Date(t).toLocaleDateString('ko-KR');
}
const fmt = (t) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/* ---------- 유사도/병합 제안 ---------- */
const threshold = () => Sim.THRESHOLDS[state.settings.threshold] ?? Sim.THRESHOLDS.normal;

function groupSim(ga, gb) {
  let best = 0;
  for (const a of idx[ga] || []) for (const b of idx[gb] || []) best = Math.max(best, Sim.similarity(a, b));
  return best;
}
// 한 그룹과 비슷한 다른 그룹들
function similarTo(gid) {
  const th = threshold();
  const out = [];
  for (const g of state.groups) {
    if (g.id === gid || state.dismissed.includes(pairKey(gid, g.id)) || shareMember(gid, g.id)) continue;
    const s = groupSim(gid, g.id);
    if (s >= th) out.push({ gid: g.id, score: s, src: 'kw' });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4);
}
/* ---------- 병합/분리 ---------- */
function snapshot() { return JSON.stringify({ complaints: state.complaints, groups: state.groups, dismissed: state.dismissed, aiClusters: state.aiClusters, aiDismissed: state.aiDismissed }); }
function restore(snap) { Object.assign(state, JSON.parse(snap)); expanded.clear(); selected.clear(); commit(); }

function mergeGroups(ids, targetId) {
  ids = [...new Set(ids)].filter((id) => state.groups.some((g) => g.id === id));
  if (ids.length < 2) return null;
  const created = (id) => state.groups.find((g) => g.id === id).createdAt;
  if (!targetId || !ids.includes(targetId)) {
    targetId = ids.slice().sort((a, b) => (idx[b]?.length || 0) - (idx[a]?.length || 0) || created(a) - created(b))[0];
  }
  const t = state.groups.find((g) => g.id === targetId);
  for (const id of ids) {
    if (id === targetId) continue;
    const g = state.groups.find((x) => x.id === id);
    // 기록이 이미 target에도 속해 있으면 중복 없이 하나로
    state.complaints.forEach((c) => {
      if (c.groupIds.includes(id)) c.groupIds = [...new Set(c.groupIds.map((x) => (x === id ? targetId : x)))];
    });
    for (const f of IDEA_FIELDS) {
      const a = (t[f] || '').trim(), b = (g[f] || '').trim();
      if (!a) t[f] = b; else if (b && a !== b) t[f] = a + '\n---\n' + b;
    }
    if (rank(g.status) > rank(t.status)) t.status = g.status;
    state.groups = state.groups.filter((x) => x.id !== id);
    expanded.delete(id); selected.delete(id);
  }
  buildIndex();
  t.title = mergedTitle(t);
  return targetId;
}
// 합친 묶음의 제목: "대표 제목 (상황1 / 상황2 / …)" — 각 기록의 상황 메모(없으면 내용 요약)를 모두 담는다.
// 사용자가 제목을 직접 고친 뒤(autoSit=false)에는 그 제목을 기준으로 삼는다.
function mergedTitle(g) {
  const base = ((g.autoSit ? g.baseTitle : g.title) || '').trim() || (idx[g.id]?.[0]?.text || '').slice(0, 40);
  const labels = [];
  for (const c of (idx[g.id] || []).slice().sort((a, b) => a.createdAt - b.createdAt)) {
    const l = (c.situation || c.text).replace(/\s+/g, ' ').trim().slice(0, 30);
    if (l && !labels.includes(l)) labels.push(l);
  }
  g.baseTitle = base; g.autoSit = true;
  return labels.length ? `${base} (${labels.join(' / ')})` : base;
}
// 이 묶음에서 기록을 뺀다. 다른 묶음에도 속해 있으면 그냥 빼고, 유일한 소속이면 새 묶음으로 분리.
function splitComplaint(cid, gid) {
  const c = state.complaints.find((x) => x.id === cid);
  if (!c || !c.groupIds.includes(gid) || (idx[gid] || []).length < 2) return;
  c.groupIds = c.groupIds.filter((x) => x !== gid);
  if (!c.groupIds.length) {
    const g = { id: uid(), title: c.text.split('\n')[0].slice(0, 40), createdAt: Date.now(), status: 'new', why: '', coping: '', ideal: '', idea: '' };
    state.groups.push(g);
    c.groupIds = [g.id];
  }
}
// 묶음 삭제: 이 묶음에만 속한 기록은 삭제, 다른 묶음에도 속한 기록은 유지
function removeGroup(gid) {
  state.groups = state.groups.filter((g) => g.id !== gid);
  state.complaints.forEach((c) => { c.groupIds = c.groupIds.filter((x) => x !== gid); });
  state.complaints = state.complaints.filter((c) => c.groupIds.length);
}

/* ---------- 토스트 ---------- */
let toastTimer;
function toast(msg, actionLabel, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (actionLabel) {
    const b = document.createElement('button');
    b.textContent = actionLabel;
    b.onclick = () => { el.hidden = true; action(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), actionLabel ? 8000 : 3000);
}
function doMerge(ids, targetId, label) {
  const snap = snapshot();
  const t = mergeGroups(ids, targetId);
  if (!t) return null;
  commit();
  toast(label || '합쳤어요', '실행 취소', () => restore(snap));
  return t;
}

/* ---------- 입력 폼 ---------- */
function renderIntensity() {
  $('#intensity').innerHTML = FACES.map((f, i) =>
    `<button type="button" role="radio" aria-checked="${formIntensity === i + 1}" title="강도 ${i + 1}" data-i="${i + 1}" class="${formIntensity === i + 1 ? 'on' : ''}">${f}</button>`).join('');
}
const cats = () => (state.settings.categories?.length ? state.settings.categories : DEFAULT_CATEGORIES);
function renderCats() {
  $('#catbox').innerHTML = cats().map((c) => `<button type="button" role="radio" aria-checked="${formCategory === c}" data-c="${esc(c)}" class="${formCategory === c ? 'on' : ''}">${esc(c)}</button>`).join('');
}
function renderChips() {
  $('#tagChips').innerHTML = formTags.map((t) => `<span class="chip">#${esc(t)}<button type="button" data-rm="${esc(t)}" aria-label="태그 삭제">×</button></span>`).join('');
}
function addTag(raw) {
  const t = raw.trim().replace(/^#/, '').replace(/,/g, '');
  if (t && !formTags.includes(t)) formTags.push(t);
  renderChips();
}
function allTags() {
  const n = {};
  state.complaints.forEach((c) => c.tags.forEach((t) => (n[t] = (n[t] || 0) + 1)));
  return Object.entries(n).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
}

async function submitComplaint() {
  const text = $('#fText').value.trim();
  if (!text) return;
  addTag($('#fTag').value); $('#fTag').value = '';
  const now = Date.now();
  const g = { id: uid(), title: text.split('\n')[0].slice(0, 40), createdAt: now, status: 'new', why: '', coping: '', ideal: '', idea: '' };
  const c = { id: uid(), text, situation: $('#fSituation').value.trim(), intensity: formIntensity, category: formCategory, tags: [...formTags], createdAt: now, groupIds: [g.id] };
  state.groups.push(g); state.complaints.push(c);
  $('#fText').value = ''; $('#fSituation').value = ''; formTags = []; formCategory = ''; renderChips(); renderCats();
  commit();

  let items = similarTo(g.id);
  if (state.settings.ai && state.settings.apiKey) {
    toast('저장했어요 · AI가 비슷한 기록을 찾는 중…');
    try {
      const ids = await aiMatchNew(g.id);
      for (const id of ids) if (!items.some((i) => i.gid === id) && !state.dismissed.includes(pairKey(g.id, id))) items.push({ gid: id, score: groupSim(g.id, id), src: 'ai' });
    } catch (e) { toast('AI 확인 실패: ' + e.message); }
  }
  // AI 대기 중 사용자가 이미 합쳤을 수 있음
  items = items.filter((i) => state.groups.some((x) => x.id === i.gid));
  if (!state.groups.some((x) => x.id === g.id)) return;
  if (items.length) openSuggest(g.id, items, c.id);
  else if (!(state.settings.ai && state.settings.apiKey)) toast('저장했어요');
}

/* ---------- 저장 직후 병합 제안 모달 ---------- */
// 비슷한 기록 카드의 "자세히" 내용: 묶음 안의 기록 전체 + 횟수/강도 (정리 탭과 저장 직후 창에서 공통 사용)
function pairDetail(g) {
  const st = gstats(g);
  return `<ul>${st.members.slice().sort((a, b) => a.createdAt - b.createdAt).map((c) => `<li>${cBadge(c)}${esc(c.text)}<span class="muted small"> · ${fmt(c.createdAt)}${c.situation ? ' · ' + esc(c.situation) : ''}${c.tags.length ? ' · ' + c.tags.map((t) => '#' + esc(t)).join(' ') : ''}</span></li>`).join('')}</ul><div class="muted small">🔁 ${st.count}회 · 강도 ${st.avg.toFixed(1)}</div>`;
}
function openSuggest(gid, items, newCid) {
  const dlg = $('#sugDlg');
  // 기본은 제목만. 제목이나 "자세히"를 누르면 기록 전체가 펼쳐진다.
  const cards = items.map((it) => {
    const g = state.groups.find((x) => x.id === it.gid); if (!g) return '';
    return `<div class="pair" data-cand="${it.gid}">
      <div class="pair-cols one" data-ptoggle role="button" tabindex="0" aria-expanded="false" title="눌러서 자세히 보기">
        <div class="pair-col"><h4>${gBadge(g)}${esc(gtitle(g))} ${it.src === 'ai' ? '<span class="src">AI</span>' : ''}</h4>
          <div class="sug-detail" hidden>${pairDetail(g)}</div></div></div>
      <div class="pair-foot"><button class="mini" data-ptoggle aria-expanded="false">▸ 자세히</button><span class="grow">비슷함 ${Math.round(it.score * 100)}%</span>
        <button class="ghost small" data-act="no">남남이에요</button>
        <button class="ghost small" data-act="both" title="방금 쓴 기록을 이 묶음에도 넣고, 기존 묶음은 그대로 둬요">여기에도 추가</button>
        <button class="primary small" data-act="yes">한 통에!</button></div></div>`;
  }).join('');
  dlg.innerHTML = `<h2>비슷한 기록을 찾았어요</h2>
    <p class="muted small">방금 쓴 불만: ${gBadge(state.groups.find((x) => x.id === gid))}“${esc(gtitle(state.groups.find((x) => x.id === gid)))}”</p>
    <div id="sugCards">${cards}</div>
    <div class="row end"><span></span><button class="ghost" data-act="later">나중에</button></div>`;
  let cur = gid, left = items.slice();
  dlg.onkeydown = (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.pair-cols[data-ptoggle]')) { e.preventDefault(); e.target.click(); }
  };
  dlg.onclick = (e) => {
    const tg = e.target.closest('[data-ptoggle]');
    if (tg) { // 자세히 펼치기/접기
      const card = tg.closest('[data-cand]'), d = card.querySelector('.sug-detail'), open = d.hidden; // 지금 닫혀 있으면 연다
      d.hidden = !open;
      card.classList.toggle('open', open);
      card.querySelector('.pair-cols').setAttribute('aria-expanded', open);
      const b = card.querySelector('.pair-foot [data-ptoggle]'); b.setAttribute('aria-expanded', open); b.textContent = open ? '▾ 접기' : '▸ 자세히';
      return;
    }
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'later') return dlg.close();
    const card = btn.closest('[data-cand]'); const cand = card.dataset.cand;
    if (act === 'no') state.dismissed.push(pairKey(cur, cand));
    if (act === 'yes') cur = doMerge([cur, cand], cand, '합쳤어요') || cur;
    if (act === 'both') {
      const c = state.complaints.find((x) => x.id === newCid);
      if (c && !c.groupIds.includes(cand)) { c.groupIds.push(cand); commit(); toast('두 묶음에 모두 넣었어요'); }
    }
    left = left.filter((i) => i.gid !== cand);
    persist();
    if (!left.length) return dlg.close();
    card.remove();
  };
  if (!dlg.open) dlg.showModal();
}

/* ---------- AI ---------- */
async function aiCall(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-api-key': state.settings.apiKey,
      'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error('API ' + r.status);
  const j = await r.json();
  return (j.content || []).map((c) => c.text || '').join('');
}
function parseJsonArray(s) {
  const m = s.match(/\[[\s\S]*\]/); if (!m) return [];
  try { return JSON.parse(m[0]); } catch { return []; }
}
const groupLine = (g, n) => `${n}. ${gtitle(g)}${(idx[g.id] || []).length > 1 ? ' | ' + idx[g.id].slice(0, 3).map((c) => c.text.slice(0, 40)).join(' / ') : ''}`;

async function aiMatchNew(gid) {
  const g = state.groups.find((x) => x.id === gid);
  const others = state.groups.filter((x) => x.id !== gid).slice(-40);
  if (!others.length) return [];
  const prompt = `사용자가 쓴 새 불만과 "같은 근본 문제"를 말하는 기존 항목 번호만 골라 JSON 숫자 배열로만 답하세요. 해당 없으면 [] 입니다.\n\n새 불만: ${idx[gid].map((c) => c.text).join(' / ')}\n\n기존 항목:\n${others.map((o, i) => groupLine(o, i + 1)).join('\n')}`;
  return parseJsonArray(await aiCall(prompt)).map((n) => others[n - 1]?.id).filter(Boolean);
}
// AI로 묶기: 같은 근본 문제로 보이는 묶음들을 찾아 "제안"으로만 저장한다 (실제 합치기는 AI 탭에서 사용자가 확인한 뒤)
async function aiScanAll() {
  if (!state.settings.apiKey) {
    toast('AI를 쓰려면 설정에서 API 키를 입력해 주세요');
    return $('#openSettings').click();
  }
  const gs = state.groups.filter((g) => (idx[g.id] || []).length).slice(-60);
  if (gs.length < 2) return toast('기록이 더 필요해요');
  const btn = $('#aiScan');
  btn.disabled = true; btn.textContent = '✨ AI가 묶는 중…';
  try {
    const prompt = `아래 항목 중 "같은 근본 문제"를 말하는 것들을 묶어 주세요. JSON 배열로만 답하세요. 각 원소는 {"items":[번호,...],"reason":"묶은 이유 한 문장(한국어)"} 형식입니다. 한 항목은 한 묶음에만 넣고, 묶을 게 없으면 [] 입니다.\n\n${gs.map((g, i) => groupLine(g, i + 1)).join('\n')}`;
    const raw = parseJsonArray(await aiCall(prompt));
    const used = new Set(), out = [];
    for (const el of raw) {
      const nums = Array.isArray(el) ? el : el?.items;
      if (!Array.isArray(nums)) continue;
      const gids = [...new Set(nums.map((x) => gs[x - 1]?.id).filter((id) => id && !used.has(id)))];
      if (gids.length < 2) continue;
      if (state.aiDismissed.includes(gids.slice().sort().join('|'))) continue; // 이미 "아니에요" 한 묶음
      gids.forEach((id) => used.add(id));
      out.push({ id: uid(), gids, reason: Array.isArray(el) ? '' : String(el.reason || '').slice(0, 120) });
    }
    state.aiClusters = out; aiOff = {}; expandedAi.clear(); persist(); render();
    toast(out.length ? `AI가 ${out.length}가지 묶음을 제안했어요. 확인해 주세요` : 'AI가 묶을 만한 항목을 못 찾았어요');
  } catch (e) { toast('AI 실패: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '✨ AI로 묶기'; }
}

/* ---------- 렌더: 기록 탭 (카테고리별 자주 겪는 불만 TOP 3) ---------- */
const catOptions = () => [...new Set([...cats(), ...state.complaints.map((c) => c.category).filter(Boolean)])];
function renderTopCats() {
  const n = (c) => state.complaints.filter((x) => !c || x.category === c).length;
  $('#topCats').innerHTML = ['', ...catOptions()].map((c) =>
    `<button type="button" data-c="${esc(c)}" class="${topCat === c ? 'on' : ''}">${c ? esc(c) : '전체'} <span class="n">${n(c)}</span></button>`).join('');
}
function renderList() {
  if (topCat && !catOptions().includes(topCat)) topCat = '';
  renderTopCats();
  // 빈도(해당 카테고리 안에서의 기록 수) 순 → 평균 강도 → 최근. 상위 3개만.
  let gs = state.groups.map((g) => ({ g, st: gstats(g), sc: gstats(g, 0, topCat) })).filter((x) => x.sc.count);
  gs.sort((a, b) => b.sc.count - a.sc.count || b.sc.avg - a.sc.avg || b.sc.last - a.sc.last);
  const total = gs.length;
  gs = gs.slice(0, 3);
  if (!gs.length) {
    $('#list').innerHTML = `<div class="empty">${state.complaints.length ? '이 카테고리의 기록이 아직 없어요.' : '아직 기록이 없어요.<br>불편했던 일을 한 줄 적어 보세요. 설정에서 샘플 데이터를 넣어볼 수도 있어요.'}</div>`;
    return;
  }
  $('#list').innerHTML = gs.map(({ g, st, sc }, i) => {
    const open = expanded.has(g.id);
    const lvl = Math.max(1, Math.min(5, Math.round(sc.avg)));
    return `<article class="card" data-gid="${g.id}">
      <div class="card-head">
        <span class="rankno">${i + 1}</span>
        <div class="title" data-toggle>${gBadge(g)}${esc(gtitle(g))}</div>
        <div class="badges"><span class="badge">🔁 ${sc.count}회</span><span class="badge int i${lvl}">강도 ${sc.avg.toFixed(1)}</span></div>
      </div>
      <div class="meta">${st.tags.map((t) => `<span class="chip">#${esc(t)}</span>`).join('')}<span>${ago(sc.last)}</span><span class="status">${STATUSES[rank(g.status)]?.[1] || ''}</span></div>
      ${open ? detailHtml(g, st) : ''}
    </article>`;
  }).join('') + (total > 3 ? `<p class="muted small more-note">그 밖의 ${total - 3}개 묶음은 불만광산 탭의 쌓은 광물에서 볼 수 있어요.</p>` : '');
}
function editHtml(c) {
  return `<div class="member editing" data-cid="${c.id}" data-int="${c.intensity}">
    <div class="txt idea-form">
      <label>내용<textarea rows="2" data-e="text">${esc(c.text)}</textarea></label>
      <label>카테고리<select data-e="category"><option value="">(없음)</option>${[...new Set([...cats(), ...(c.category ? [c.category] : [])])].map((x) => `<option ${x === c.category ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      <label>상황 메모<input data-e="situation" value="${esc(c.situation || '')}"></label>
      <label>태그 (쉼표/공백으로 구분)<input data-e="tags" value="${esc(c.tags.join(' '))}"></label>
      <div class="intensity">${FACES.map((f, i) => `<button type="button" data-act="eint" data-i="${i + 1}" class="${c.intensity === i + 1 ? 'on' : ''}" title="강도 ${i + 1}">${f}</button>`).join('')}</div>
      <div class="row"><button class="primary small" data-act="saveedit">저장</button><button class="ghost small" data-act="canceledit">취소</button></div>
    </div></div>`;
}
function detailHtml(g, st) {
  const members = st.members.slice().sort((a, b) => b.createdAt - a.createdAt).map((c) => {
    if (c.id === editingCid) return editHtml(c);
    const others = c.groupIds.filter((x) => x !== g.id).map((x) => state.groups.find((y) => y.id === x)).filter(Boolean);
    return `
    <div class="member" data-cid="${c.id}">
      <span>${FACES[c.intensity - 1]}</span>
      <div class="txt">${cBadge(c)}${esc(c.text)}<span class="sub">${fmt(c.createdAt)}${c.situation ? ' · ' + esc(c.situation) : ''}${c.tags.length ? ' · ' + c.tags.map((t) => '#' + esc(t)).join(' ') : ''}</span>
        ${others.length ? `<span class="sub">🔗 함께 속한 묶음: ${others.map((o) => esc(gLabel(o))).join(', ')}</span>` : ''}</div>
      <div class="acts"><button class="mini" data-act="edit">수정</button><button class="mini" data-act="link" title="다른 묶음에도 이 기록을 넣거나 뺄 수 있어요">묶음 추가</button>${st.count > 1 ? `<button class="mini" data-act="split" title="${c.groupIds.length > 1 ? '이 묶음에서만 빼기' : '새 묶음으로 분리'}">${c.groupIds.length > 1 ? '빼기' : '분리'}</button>` : ''}<button class="mini" data-act="del">삭제</button></div>
    </div>`;
  }).join('');
  const f = (k, label, ph) => `<label>${label}<textarea rows="2" data-f="${k}" placeholder="${ph}">${esc(g[k] || '')}</textarea></label>`;
  return `<div class="detail">
    <div>${members}</div>
    <div class="idea-form">
      <h3>💡 아이디어로 바꾸기</h3>
      <label>대표 제목<input data-f="title" value="${esc(g.title || '')}"></label>
      ${f('why', '진짜 문제는? (왜 불편한가를 3번 물어보기)', '왜 → 왜 → 왜')}
      <div class="grid2">${f('coping', '지금은 어떻게 참거나 해결하나요?', '현재 대처법')}${f('ideal', '이상적인 상태는?', '해결되면 어떤 모습?')}</div>
      ${f('idea', '광물 태우기', '해결 방법, 서비스 컨셉, 떠오르는 것 아무거나')}
      <label>상태<select data-f="status">${STATUSES.map(([v, l]) => `<option value="${v}" ${g.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div><button class="mini danger" data-act="delgroup">이 묶음 전체 삭제</button></div>
    </div></div>`;
}

/* ---------- 묶음 연결 창 (한 기록을 여러 묶음에) ---------- */
function openLink(cid) {
  linkCid = cid;
  const c = state.complaints.find((x) => x.id === cid);
  const dlg = $('#linkDlg');
  dlg.innerHTML = `<h2>이 기록을 넣을 묶음</h2>
    <p class="muted small">“${esc(c.text.slice(0, 80))}”<br>여러 묶음에 동시에 넣을 수 있어요. 체크를 켜고 끄면 바로 반영돼요.</p>
    <input id="linkQ" type="search" placeholder="묶음 검색" style="width:100%;margin:6px 0 10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg)">
    <div id="linkList"></div>
    <div class="row end"><span class="hint">묶음에는 최소 1건, 기록은 최소 1개 묶음이 필요해요</span><button class="primary" id="linkClose">닫기</button></div>`;
  $('#linkQ').oninput = fillLink;
  $('#linkClose').onclick = () => dlg.close();
  dlg.onchange = (e) => {
    if (!e.target.matches('input[data-g]')) return;
    const gid = e.target.dataset.g;
    c.groupIds = e.target.checked ? [...new Set([...c.groupIds, gid])] : c.groupIds.filter((x) => x !== gid);
    commit(); fillLink();
  };
  fillLink();
  if (!dlg.open) dlg.showModal();
}
function fillLink() {
  const c = state.complaints.find((x) => x.id === linkCid); if (!c) return;
  const q = ($('#linkQ')?.value || '').trim().toLowerCase(), loose = Sim.THRESHOLDS.loose;
  const rows = state.groups.filter((g) => (idx[g.id] || []).length).map((g) => {
    let s = 0;
    for (const m of idx[g.id]) if (m.id !== c.id) s = Math.max(s, Sim.similarity(c, m));
    return { g, s, mem: c.groupIds.includes(g.id) };
  }).filter((r) => !q || gtitle(r.g).toLowerCase().includes(q)).sort((a, b) => b.mem - a.mem || b.s - a.s);
  $('#linkList').innerHTML = rows.map(({ g, s, mem }) => {
    const lock = mem && (c.groupIds.length === 1 || idx[g.id].length === 1);
    return `<label class="linkrow"><input type="checkbox" data-g="${g.id}" ${mem ? 'checked' : ''} ${lock ? 'disabled' : ''}>
      <span class="t">${gBadge(g)}${esc(gtitle(g))}</span><span class="muted small">🔁 ${idx[g.id].length}${s >= loose ? ` · 비슷함 ${Math.round(s * 100)}%` : ''}</span></label>`;
  }).join('') || '<div class="muted small">묶음이 없어요</div>';
}

/* ---------- 렌더: 정리 탭 (쌓인 불만) ---------- */
// 쌓인 불만: 모든 기록을 최신순으로 표시, 카테고리/태그/검색으로 필터
function renderRecords() {
  const q = $('#q').value.trim().toLowerCase(), tag = $('#tagFilter').value, cat = $('#catFilter').value;
  const all = state.complaints.map((c, i) => ({ c, i })).sort((a, b) => a.c.createdAt - b.c.createdAt || a.i - b.i).map((x) => x.c);
  const no = new Map(all.map((c, n) => [c.id, n + 1]));
  const groupsOf = (c) => c.groupIds.map((id) => state.groups.find((g) => g.id === id)).filter(Boolean);
  // 번호는 입력 순번(1 = 처음 쓴 기록)이고, 목록은 최신순(번호가 큰 것부터)으로 보여준다
  const rows = all.filter((c) => (!cat || c.category === cat) && (!tag || c.tags.includes(tag)) &&
    (!q || (c.text + ' ' + (c.situation || '') + ' ' + (c.category || '') + ' ' + c.tags.join(' ') + ' ' + groupsOf(c).map(gtitle).join(' ')).toLowerCase().includes(q))).reverse();
  $('#recCount').textContent = all.length ? (rows.length === all.length ? `${all.length}건` : `${rows.length}건 / 전체 ${all.length}건`) : '';
  if (!rows.length) {
    $('#recList').innerHTML = `<div class="empty">${all.length ? '조건에 맞는 기록이 없어요.' : '아직 기록이 없어요.'}</div>`;
    return;
  }
  $('#recList').innerHTML = '<div class="reclist">' + rows.map((c) => c.id === editingCid ? editHtml(c) : `
    <div class="member rec" data-cid="${c.id}">
      <input type="checkbox" class="sel" ${selected.has(c.id) ? 'checked' : ''} aria-label="선택">
      <span class="no">${no.get(c.id)}</span>
      <span>${FACES[c.intensity - 1]}</span>
      <div class="txt">${cBadge(c)}${esc(c.text)}<span class="sub">${fmt(c.createdAt)}${c.situation ? ' · ' + esc(c.situation) : ''}${c.tags.length ? ' · ' + c.tags.map((t) => '#' + esc(t)).join(' ') : ''}</span>
        <span class="sub">🔗 ${groupsOf(c).map((g) => `<button class="gchip" data-gopen="${g.id}" title="묶음 열기">${esc(gLabel(g))}</button>`).join(' ')}</span></div>
      <div class="acts"><button class="mini" data-act="edit">수정</button><button class="mini" data-act="link" title="다른 묶음에도 이 기록을 넣거나 뺄 수 있어요">묶음 추가</button><button class="mini" data-act="del">삭제</button></div>
    </div>`).join('') + '</div>';
}

/* ---------- 렌더: AI 탭 (AI가 묶은 제안 → 확인 후 묶기) ---------- */
function aiClusterList() {
  return (state.aiClusters || []).map((c) => ({ ...c, gids: c.gids.filter((id) => (idx[id] || []).length) })).filter((c) => c.gids.length >= 2);
}
function renderAi() {
  const cl = aiClusterList(), has = !!state.settings.apiKey;
  $('#aiList').innerHTML = cl.length ? cl.map((c) => {
    const off = aiOff[c.id] || new Set();
    const picked = c.gids.filter((id) => !off.has(id));
    const items = c.gids.map((gid) => {
      const g = state.groups.find((x) => x.id === gid), open = expandedAi.has(gid);
      return `<div class="ai-item" data-gid="${gid}">
        <input type="checkbox" ${off.has(gid) ? '' : 'checked'} aria-label="이 묶음에 포함">
        <button type="button" class="ai-title" data-aitoggle aria-expanded="${open}" title="눌러서 ${open ? '접기' : '자세히 보기'}">${gBadge(g)}${esc(gtitle(g))} <span class="muted small">🔁 ${idx[gid].length}회 ${open ? '▾' : '▸'}</span></button>
        ${open ? `<div class="ai-detail">${pairDetail(g)}</div>` : ''}</div>`;
    }).join('');
    return `<div class="pair ai-card" data-cl="${c.id}">
      <div class="ai-reason"><span class="src">AI</span> ${esc(c.reason || '같은 문제로 보여요')}</div>
      <div class="ai-items">${items}</div>
      <div class="pair-foot"><span class="grow">체크한 ${picked.length}개가 하나로 묶여요</span>
        <button class="ghost small" data-act="aino">아니에요</button>
        <button class="primary small" data-act="aiyes" ${picked.length < 2 ? 'disabled' : ''}>${picked.length}개 묶기</button></div></div>`;
  }).join('') : `<div class="empty">${has ? 'AI가 묶은 제안이 아직 없어요.<br><span class="small">“AI로 묶기”를 누르면 같은 문제로 보이는 불만을 찾아 알려줘요.</span>' : 'AI를 쓰려면 설정에서 API 키를 입력해 주세요.'}</div>`;
}

/* ---------- 렌더: 아이디어 메모 탭 ---------- */
function renderIdeas() {
  const items = state.groups.filter((g) => (g.idea || '').trim() && (idx[g.id] || []).length)
    .map((g) => ({ g, st: gstats(g) })).sort((a, b) => b.st.score - a.st.score);
  $('#ideaList').innerHTML = items.length ? items.map(({ g, st }) => `
    <article class="card idea-item" data-gid="${g.id}">
      <div class="card-head">
        <div class="title" data-open>${gBadge(g)}${esc(gtitle(g))}</div>
        <div class="badges">${st.count > 1 ? `<span class="badge">🔁 ${st.count}회</span>` : ''}<span class="badge">${STATUSES[rank(g.status)]?.[1] || ''}</span></div>
      </div>
      <div class="idea-text">${esc(g.idea.trim())}</div>
      <div class="meta" style="margin-left:0"><button class="mini" data-open>묶음 열기</button></div>
    </article>`).join('')
    : '<div class="empty">아직 태운 광물이 없어요.<br><span class="small">쏟아내기 탭의 불만을 펼치거나, 불만광산 탭의 기록에서 묶음을 열면 “광물 태우기” 칸이 있어요.</span></div>';
}

/* ---------- 묶음 상세 창 (기록 TOP 3 밖의 묶음도 열어서 보고 고칠 수 있게) ---------- */
function openGroup(gid) {
  openGid = gid;
  renderGroupDlg();
  const d = $('#grpDlg');
  if (openGid && !d.open) d.showModal();
}
function renderGroupDlg() {
  const d = $('#grpDlg'), g = state.groups.find((x) => x.id === openGid);
  if (!g || !(idx[g.id] || []).length) { openGid = null; if (d.open) d.close(); return; }
  d.innerHTML = `<div class="dlg-head"><h2>${gBadge(g)}${esc(gtitle(g))}</h2><button class="ghost small" id="grpClose">닫기</button></div>
    <div data-gid="${g.id}">${detailHtml(g, gstats(g))}</div>`;
}

/* ---------- 렌더 총괄 ---------- */
function render() {
  buildIndex();
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  ['list', 'tidy', 'ai', 'ideas'].forEach((v) => ($('#view-' + v).hidden = v !== view));
  const n = aiClusterList().length;
  $('#aiBadge').hidden = !n; $('#aiBadge').textContent = n;
  // 태그 필터/자동완성
  const tags = allTags(), cur = $('#tagFilter').value;
  $('#tagFilter').innerHTML = '<option value="">모든 태그</option>' + tags.map((t) => `<option ${t === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
  $('#tagList').innerHTML = tags.map((t) => `<option value="${esc(t)}">`).join('');
  // 카테고리 필터: 설정 목록 + 데이터에만 남아 있는 카테고리
  const curCat = $('#catFilter').value;
  $('#catFilter').innerHTML = '<option value="">모든 카테고리</option>' + catOptions().map((c) => `<option ${c === curCat ? 'selected' : ''}>${esc(c)}</option>`).join('');
  updateSelBar();
  if (view === 'list') renderList();
  if (view === 'tidy') renderRecords();
  if (view === 'ai') renderAi();
  if (view === 'ideas') renderIdeas();
  if ($('#grpDlg').open) renderGroupDlg();
  $('#capHint').textContent = state.complaints.length ? `지금까지 ${state.complaints.length}건 · ${state.groups.length}개 묶음` : '';
}
function updateSelBar() {
  $('#selBar').hidden = selected.size < 2; $('#selCount').textContent = `${selected.size}개 선택`;
}
function go(v) { view = v; render(); }

/* ---------- 이벤트 ---------- */
$('#intensity').onclick = (e) => { const b = e.target.closest('button'); if (b) { formIntensity = +b.dataset.i; renderIntensity(); } };
$('#tagChips').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { formTags = formTags.filter((t) => t !== b.dataset.rm); renderChips(); } };
$('#fTag').onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(e.target.value); e.target.value = ''; }
  if (e.key === 'Backspace' && !e.target.value && formTags.length) { formTags.pop(); renderChips(); }
};
$('#fTag').onchange = (e) => { if (e.target.value) { addTag(e.target.value); e.target.value = ''; } };
$('#fText').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitComplaint(); } };
$('#captureForm').onsubmit = (e) => { e.preventDefault(); submitComplaint(); };

$('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) { go(b.dataset.view); b.scrollIntoView({ inline: 'center', block: 'nearest' }); } }; // 좁은 화면에서 눌린 탭이 항상 보이게
['q', 'tagFilter', 'catFilter'].forEach((id) => ($('#' + id).oninput = renderRecords));
$('#catbox').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  formCategory = formCategory === b.dataset.c ? '' : b.dataset.c; // 다시 누르면 선택 해제
  renderCats();
};
$('#topCats').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  topCat = b.dataset.c; renderList();
};

/* 기록 하나에 대한 동작(수정/묶음 추가/삭제) — TOP 3 카드, 묶음 상세 창, 전체 기록 목록에서 공통으로 사용 */
function recAct(act, btn) {
  const row = btn.closest('[data-cid]'), cid = row?.dataset.cid;
  const snap = snapshot();
  if (act === 'edit') { editingCid = cid; render(); return true; }
  if (act === 'canceledit') { editingCid = null; render(); return true; }
  if (act === 'eint') {
    row.dataset.int = btn.dataset.i;
    row.querySelectorAll('[data-act=eint]').forEach((b) => b.classList.toggle('on', b === btn));
    return true;
  }
  if (act === 'saveedit') {
    const c = state.complaints.find((x) => x.id === cid);
    const text = row.querySelector('[data-e=text]').value.trim();
    if (!text) { toast('내용을 입력해 주세요'); return true; }
    c.text = text;
    c.situation = row.querySelector('[data-e=situation]').value.trim();
    c.category = row.querySelector('[data-e=category]').value;
    c.tags = [...new Set(row.querySelector('[data-e=tags]').value.split(/[,\s]+/).map((t) => t.replace(/^#/, '')).filter(Boolean))];
    c.intensity = +row.dataset.int;
    editingCid = null; commit(); toast('수정했어요', '실행 취소', () => restore(snap));
    return true;
  }
  if (act === 'link') { openLink(cid); return true; }
  if (act === 'del') {
    if (!confirm('이 기록을 삭제할까요? (속한 모든 묶음에서 사라져요)')) return true;
    state.complaints = state.complaints.filter((c) => c.id !== cid);
    cleanupGroups(); commit(); toast('삭제했어요', '실행 취소', () => restore(snap));
    return true;
  }
  return false;
}
// 묶음 단위 클릭: TOP 3 카드와 묶음 상세 창에서 공통
function onGroupClick(e) {
  const gid = e.target.closest('[data-gid]')?.dataset.gid;
  if (e.target.closest('[data-toggle]') && gid) { expanded.has(gid) ? expanded.delete(gid) : expanded.add(gid); return renderList(); }
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const act = btn.dataset.act;
  if (recAct(act, btn)) return;
  const snap = snapshot();
  if (act === 'split') { splitComplaint(btn.closest('[data-cid]').dataset.cid, gid); commit(); toast('이 묶음에서 뺐어요', '실행 취소', () => restore(snap)); }
  if (act === 'delgroup') {
    if (!confirm('이 묶음을 삭제할까요?\n이 묶음에만 속한 기록은 함께 삭제되고, 다른 묶음에도 속한 기록은 남아요.')) return;
    removeGroup(gid); cleanupGroups(); commit(); toast('삭제했어요', '실행 취소', () => restore(snap));
  }
}
function cleanupGroups() {
  const used = new Set(state.complaints.flatMap((c) => c.groupIds));
  state.groups = state.groups.filter((g) => used.has(g.id));
  const cids = new Set(state.complaints.map((c) => c.id));
  [...expanded].forEach((id) => !used.has(id) && expanded.delete(id));
  [...selected].forEach((id) => !cids.has(id) && selected.delete(id));
}
// 아이디어 입력칸: 입력 중 재렌더 없이 저장만
function onGroupInput(e) {
  const f = e.target.dataset.f; if (!f) return;
  const g = state.groups.find((x) => x.id === e.target.closest('[data-gid]').dataset.gid);
  g[f] = e.target.value;
  if (f === 'title') g.autoSit = false; // 직접 고친 제목은 이후 합칠 때 기준이 됨
  persist();
}
function onGroupChange(e) {
  const f = e.target.dataset.f;
  if (f !== 'status' && f !== 'title') return;
  const g = state.groups.find((x) => x.id === e.target.closest('[data-gid]').dataset.gid);
  g[f] = e.target.value; if (f === 'title') g.autoSit = false;
  commit();
}
$('#list').onclick = onGroupClick; $('#list').oninput = onGroupInput; $('#list').onchange = onGroupChange;
$('#grpDlg').onclick = (e) => { if (e.target.closest('#grpClose')) return $('#grpDlg').close(); onGroupClick(e); };
$('#grpDlg').oninput = onGroupInput; $('#grpDlg').onchange = onGroupChange;
$('#grpDlg').onclose = () => { openGid = null; };

// 전체 기록 목록
$('#recList').onclick = (e) => {
  if (e.target.matches('.sel')) { const cid = e.target.closest('[data-cid]').dataset.cid; e.target.checked ? selected.add(cid) : selected.delete(cid); return updateSelBar(); }
  const g = e.target.closest('[data-gopen]'); if (g) return openGroup(g.dataset.gopen);
  const btn = e.target.closest('button[data-act]'); if (btn) recAct(btn.dataset.act, btn);
};
$('#selMerge').onclick = () => {
  // 선택한 기록이 속한 묶음(기록이 여러 묶음에 속하면 첫 번째 묶음)을 하나로 합친다
  const gids = [...new Set([...selected].map((cid) => state.complaints.find((c) => c.id === cid)?.groupIds[0]).filter(Boolean))];
  if (gids.length < 2) return toast('서로 다른 묶음에 속한 기록을 2개 이상 선택해 주세요');
  selected.clear(); doMerge(gids, null, `${gids.length}개 묶음을 합쳤어요`);
};
$('#selClear').onclick = () => { selected.clear(); render(); };

// AI 탭: 제목 눌러 자세히 / 체크로 포함 여부 / "묶기"로 확정 / "아니에요"로 넘기기
$('#aiList').onclick = (e) => {
  const card = e.target.closest('[data-cl]'); if (!card) return;
  const cid = card.dataset.cl;
  const tg = e.target.closest('[data-aitoggle]');
  if (tg) { const gid = tg.closest('[data-gid]').dataset.gid; expandedAi.has(gid) ? expandedAi.delete(gid) : expandedAi.add(gid); return renderAi(); }
  const btn = e.target.closest('button[data-act]'); if (!btn || btn.disabled) return;
  const c = aiClusterList().find((x) => x.id === cid); if (!c) return;
  const off = aiOff[cid] || new Set(), picked = c.gids.filter((id) => !off.has(id));
  const snap = snapshot();
  state.aiClusters = state.aiClusters.filter((x) => x.id !== cid);
  if (btn.dataset.act === 'aino') {
    state.aiDismissed.push(c.gids.slice().sort().join('|'));
    for (let i = 0; i < c.gids.length; i++) for (let j = i + 1; j < c.gids.length; j++) state.dismissed.push(pairKey(c.gids[i], c.gids[j]));
    persist(); render(); return toast('제안을 넘겼어요', '실행 취소', () => restore(snap));
  }
  if (!mergeGroups(picked, null)) { restore(snap); return toast('묶을 수 있는 묶음이 2개 이상 필요해요'); }
  commit(); toast(`AI 제안대로 ${picked.length}개를 묶었어요`, '실행 취소', () => restore(snap));
};
$('#aiList').onchange = (e) => {
  if (!e.target.matches('.ai-item input[type=checkbox]')) return;
  const cid = e.target.closest('[data-cl]').dataset.cl, gid = e.target.closest('[data-gid]').dataset.gid;
  const off = (aiOff[cid] ||= new Set());
  e.target.checked ? off.delete(gid) : off.add(gid);
  renderAi();
};
$('#aiScan').onclick = aiScanAll;
$('#ideaList').onclick = (e) => { if (e.target.closest('[data-open]')) openGroup(e.target.closest('.card').dataset.gid); };

/* ---------- 설정/데이터 ---------- */
$('#openSettings').onclick = () => {
  $('#setTh').value = state.settings.threshold; $('#setAi').checked = state.settings.ai; $('#setKey').value = state.settings.apiKey;
  $('#setCats').value = cats().join(', ');
  $('#setDlg').showModal();
};
$('#setDlg').onclose = () => {
  const newCats = [...new Set($('#setCats').value.split(',').map((s) => s.trim()).filter(Boolean))];
  state.settings = { threshold: $('#setTh').value, ai: $('#setAi').checked, apiKey: $('#setKey').value.trim(), categories: newCats.length ? newCats : DEFAULT_CATEGORIES.slice() };
  if (formCategory && !cats().includes(formCategory)) formCategory = '';
  renderCats(); persist(); render();
};
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#exJson').onclick = () => { const { settings, ...data } = state; download('투덜이연구소.json', JSON.stringify(data, null, 2), 'application/json'); };
$('#exCsv').onclick = () => {
  const q = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  // 한 기록이 여러 묶음에 속하면 묶음마다 한 행씩 나옵니다.
  const rows = [['작성일시', '불만', '카테고리', '상황', '강도', '태그', '묶음 제목', '상태', '진짜 문제', '현재 대처법', '이상적 상태', '아이디어']];
  for (const c of state.complaints) {
    for (const gid of c.groupIds) {
      const g = state.groups.find((x) => x.id === gid) || {};
      rows.push([new Date(c.createdAt).toISOString(), c.text, c.category, c.situation, c.intensity, c.tags.join(' '), g.title, STATUSES[rank(g.status)]?.[1], g.why, g.coping, g.ideal, g.idea]);
    }
  }
  download('투덜이연구소.csv', '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n'), 'text/csv');
};
$('#imJson').onclick = () => $('#imFile').click();
$('#imFile').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.complaints) || !Array.isArray(d.groups)) throw new Error('형식이 달라요');
    migrate(d); // 구버전 파일(groupId)도 지원
    if (!confirm(`기록 ${d.complaints.length}건을 가져옵니다. 현재 데이터에 추가할까요? (같은 ID는 건너뜀)`)) return;
    const gids = new Set(state.groups.map((g) => g.id)), cids = new Set(state.complaints.map((c) => c.id));
    d.groups.forEach((g) => !gids.has(g.id) && state.groups.push(g));
    d.complaints.forEach((c) => !cids.has(c.id) && state.complaints.push(c));
    state.dismissed.push(...(d.dismissed || []));
    cleanupGroups(); commit(); toast('가져왔어요');
  } catch (err) { toast('가져오기 실패: ' + err.message); }
};
$('#wipe').onclick = () => {
  if (!confirm('모든 기록을 삭제할까요? 되돌릴 수 없어요. (먼저 JSON으로 내보내기를 권장해요)')) return;
  state.complaints = []; state.groups = []; state.dismissed = []; state.aiClusters = []; state.aiDismissed = []; expanded.clear(); selected.clear(); commit(); toast('모두 삭제했어요');
};
$('#sample').onclick = () => {
  const D = 86400000, now = Date.now();
  const S = [
    ['배송이 너무 늦어요', 3, ['쇼핑'], 9], ['배송 늦게 와서 짜증남', 4, ['쇼핑'], 6], ['주문한 지 일주일인데 아직도 배송 중', 4, ['쇼핑'], 1],
    ['회의가 너무 길어서 일을 못 한다', 4, ['업무'], 8], ['회의 시간이 또 길어졌다', 3, ['업무'], 4],
    ['앱이 자꾸 느려서 답답하다', 3, ['앱'], 5], ['앱 로딩이 너무 느림', 3, ['앱'], 2],
    ['아침마다 지하철에 사람이 너무 많다', 4, ['출근'], 7], ['출근길 지하철 사람 많아서 힘들다', 5, ['출근'], 3],
    ['커피값이 너무 비싸다', 2, ['돈'], 2], ['점심 메뉴 고르기가 매번 힘들다', 2, ['일상'], 1],
  ];
  for (const [text, intensity, tags, ago_] of S) {
    const t = now - ago_ * D - Math.random() * D * 0.5;
    const g = { id: uid(), title: text.slice(0, 40), createdAt: t, status: 'new', why: '', coping: '', ideal: '', idea: '' };
    state.groups.push(g);
    const category = { 쇼핑: '제품', 업무: '업무', 앱: '앱/서비스', 출근: '일상', 돈: '돈', 일상: '일상' }[tags[0]] || '';
    state.complaints.push({ id: uid(), text, situation: '', intensity, category, tags, createdAt: t, groupIds: [g.id] });
  }
  $('#setDlg').close(); view = 'tidy'; commit(); toast('샘플을 넣었어요. 불만광산 탭에서 쌓은 광물을 보거나, 또 너냐 탭에서 AI로 묶어 보세요');
};

/* ---------- 시작 ---------- */
renderIntensity(); renderCats(); renderChips(); render();

/* ---------- 모바일/앱 설치(PWA) ---------- */
// 상단바 높이를 CSS 변수로 알려 줌 (선택 바가 상단바 아래에 붙도록)
(function trackHeader() {
  const hdr = document.querySelector('.top');
  const set = () => document.documentElement.style.setProperty('--hdr', hdr.offsetHeight + 'px');
  set();
  if ('ResizeObserver' in window) new ResizeObserver(set).observe(hdr); else window.addEventListener('resize', set);
})();

// 다른 앱에서 "공유"로 보낸 내용 / 바로가기 / 주소 매개변수(?text=…&cat=…)를 입력창에 채워 둔다.
// 자동으로 저장하지는 않는다 — 내용을 확인하고 "털어놓기"를 눌러야 저장된다.
(function handleLaunchParams() {
  const p = new URLSearchParams(location.search);
  const text = [p.get('title'), p.get('text'), p.get('url')]
    .filter(Boolean).map((s) => s.trim())
    .filter((s, i, a) => s && a.indexOf(s) === i)                    // 같은 내용 중복 제거
    .filter((s, i, a) => !a.some((o, j) => j !== i && o !== s && o.includes(s)))   // 다른 항목에 이미 포함된 것 제외
    .join('\n').slice(0, 2000);
  const wantsNew = p.has('new');
  if (!text && !wantsNew && !p.has('cat')) return;
  go('list');
  if (text) { $('#fText').value = text; toast('공유받은 내용을 불러왔어요. 확인하고 “털어놓기”를 눌러 주세요'); }
  const cat = p.get('cat');
  if (cat && cats().includes(cat)) { formCategory = cat; renderCats(); }
  $('#fText').focus();
  history.replaceState(null, '', location.pathname);                  // 새로고침해도 다시 채워지지 않게 주소 정리
})();

// 서비스 워커: 한 번 열어 두면 인터넷이 없어도 앱이 열린다. (https 또는 localhost에서만 동작, file:// 에서는 건너뜀)
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { /* 등록 실패해도 앱은 정상 동작 */ }));
}
