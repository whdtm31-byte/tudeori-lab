/* 유사도 계산 (키워드/형태소 근사 기반, 오프라인) */
(function (root) {
  const PARTICLES = ['에서는', '으로는', '에게서', '이라서', '입니다', '했어요', '해서', '하고', '에서', '으로', '에게', '부터', '까지', '처럼', '보다', '한테', '이랑', '이다', '이고', '인데', '는데', '어서', '아서', '네요', '어요', '아요', '해요', '했다', '한다', '하다', '된다', '돼서', '되서', '지만', '은', '는', '이', '가', '을', '를', '에', '의', '도', '로', '과', '와', '만', '다', '요', '게', '고', '서', '며']
    .sort((a, b) => b.length - a.length);
  const STOP = new Set(['너무', '진짜', '정말', '계속', '그냥', '매우', '아주', '하는', '있는', '없는', '같은', '그리고', '그래서', '하지만', '항상', '자꾸', '또', '다시']);

  function stem(t) {
    for (const p of PARTICLES) {
      // 한 글자 조사는 남는 어간이 1글자(앱이→앱, 물이→물)여도 제거
      const min = p.length === 1 ? 1 : 2;
      if (t.length - p.length >= min && t.endsWith(p)) return t.slice(0, -p.length);
    }
    return t;
  }

  const cache = new Map();
  function features(text) {
    if (cache.has(text)) return cache.get(text);
    const clean = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
    const tokens = new Set(), grams = new Set(), heads = new Set();
    for (const raw of clean.split(/\s+/)) {
      if (!raw) continue;
      const t = stem(raw);
      if (STOP.has(t) || STOP.has(raw)) continue;
      tokens.add(t);
      for (let i = 0; i < t.length - 1; i++) grams.add(t.slice(i, i + 2));
      heads.add(t[0]); // 어간 첫 글자 (늦다/늦게 같은 활용 대응)
    }
    const f = { tokens, grams, heads };
    if (cache.size > 5000) cache.clear();
    cache.set(text, f);
    return f;
  }

  function dice(a, b) {
    if (!a.size || !b.size) return 0;
    let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return (2 * n) / (a.size + b.size);
  }
  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return n / (a.size + b.size - n);
  }

  // 두 기록(text + tags)의 유사도 0~1
  function similarity(a, b) {
    const fa = features(a.text + ' ' + (a.situation || ''));
    const fb = features(b.text + ' ' + (b.situation || ''));
    const tagA = new Set(a.tags || []), tagB = new Set(b.tags || []);
    const textScore = 0.45 * dice(fa.grams, fb.grams) + 0.25 * jaccard(fa.tokens, fb.tokens) + 0.1 * dice(fa.heads, fb.heads);
    const tagScore = jaccard(tagA, tagB);
    // 태그가 같은 건 보조 신호일 뿐: 텍스트가 어느 정도 겹칠 때만 가산
    return Math.min(1, textScore + (textScore > 0.12 ? 0.2 * tagScore : 0));
  }

  const api = { similarity, features, THRESHOLDS: { strict: 0.4, normal: 0.26, loose: 0.16 } };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Sim = api;
})(typeof window !== 'undefined' ? window : globalThis);
