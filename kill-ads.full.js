/* ============================================================================
 *  kill-ads.js — Facebook: hide every Ad / Sponsored unit, every "Suggested for
 *  you" / Reels / "People you may know" unit and every post Facebook labels
 *  "AI content"; strip tracking from links; answer tracker beacons locally.
 *  Runs continuously in the tab.  Brave / Chrome / Firefox.
 *
 *  HOW TO USE
 *    1. Open facebook.com, press F12 (or Ctrl+Shift+I / Cmd+Opt+I) -> Console tab.
 *    2. Paste this whole file, press Enter.
 *       - Brave/Chrome: the first time, the console asks you to type  allow pasting
 *       - Firefox: if it refuses, type  allow pasting  (or  Autoriser le collage etc.)
 *    3. Leave the tab open. Re-paste after a full page reload (F5) — SPA
 *       navigation inside Facebook (Home, groups, pages...) keeps it alive.
 *
 *  WHAT IT DOES
 *    Every 250 ms (plus on every DOM change, before the browser paints) it
 *    scans all feed units and sets `display: none !important` on anything
 *    detected as ad / suggested / AI content.  Biased to hide: when Facebook's
 *    data says "not organic" or cannot be decoded at all, the unit goes.
 *    Only real posts can be hidden: the element must be a rendered <div>
 *    inside the page's main region that contains no navigation/dialog/other
 *    landmarks, is not a page-wide layer and is not already invisible — so
 *    the nav bar, dialogs, portals and Facebook's SVG label sprite are never
 *    touched (touching the sprite is what paints "Learn More" / dates all over
 *    the page).
 *
 *  LINKS
 *    - `?fbclid=…`, `__cft__[0]`, `__tn__`, `ref=`, `utm_*`, `gclid` … are
 *      removed from every link on the page (Facebook's and external ones).
 *    - `l.facebook.com/l.php?u=<real url>&h=…` redirect shims are unwrapped
 *      to the real URL; `ping=` / `attributionsrc=` click-tracking attributes
 *      are removed; external links get rel="noopener noreferrer".
 *    - Clicks on external links go straight to the site (Facebook's click
 *      handlers — click logging, shim re-insertion — never see the click).
 *      window.open() URLs are cleaned as well.
 *    Signed CDN URLs (fbcdn.net, fbsbx.com) are never modified.
 *
 *  TRACKERS
 *    XMLHttpRequest / fetch / sendBeacon calls to Facebook's telemetry
 *    endpoints (/ajax/bz, /ajax/bnzai, /tr, hsts-pixel, privacy_sandbox,
 *    scribe, webstorage/process_keys, …) and GraphQL operations whose name says
 *    Impression / Logging / Falco / Viewability … are answered locally with a
 *    fake "OK" (so Facebook does not retry) and never leave the browser.
 *    Nothing that Facebook needs to render (GraphQL feed queries, chat,
 *    bootloader, route definitions) is blocked.  __killAds.net() prints what
 *    was blocked and every endpoint / GraphQL operation seen so far.
 *
 *  CONSOLE OUTPUT (visible only with DevTools open)
 *    - one line per tick:  [kill-ads] tick: 2 hidden on page (SPONSORED 1, ENGAGEMENT 1) · 28 feed units
 *                          · 2 hidden since start · 143 links cleaned · 37 tracker requests blocked
 *      The text is identical while nothing changes, so DevTools collapses the
 *      repeats into one line with a counter ("Group similar messages" setting).
 *    - one line per hidden unit:  [kill-ads] HIDDEN #1 SPONSORED via graphql:sponsored-data — "Nike · Sponsored …"  <element>
 *      (click the element at the end of the line to jump to it in the Elements panel)
 *    - one line the first time each tracker endpoint is blocked, one line per
 *      external link opened directly.
 *    __killAds.cfg.verbose = 0  → quiet,   = 2 → adds scan#/ms and every cleaned link
 *
 *  Console errors like "Failed to apply filter … matches-path / has-text / upward"
 *  from ublock-filters.js are Brave Shields' own cosmetic filters, not this script.
 *
 *  HOW IT DETECTS (all layers run; any hit hides the unit)
 *    1. Facebook's own GraphQL data. The script hooks XMLHttpRequest / fetch and
 *       reads the JSON Facebook embeds in the page. For every feed edge it takes
 *       the unit category (cat_sensitive: plain, or enc = sha256(sha256(post_id)+cat)),
 *       the `SponsoredData` object and the GenAI "AI content" transparency
 *       metadata, then joins them to the DOM through the `__cft__[0]` tracking
 *       token that Facebook puts into every link of the unit (the token is
 *       remembered before the link cleaner strips it).  Categories hidden by
 *       default: everything except ORGANIC (friends / pages you follow / your
 *       groups) — SPONSORED, ENGAGEMENT (= "Suggested for you"), PROMOTION,
 *       Reels/Shorts trays, TRENDING, SHOWCASE, … and UNDECODED.
 *    2. `/ads/about` links (only ads have them).
 *    3. Ad tracking tokens are about twice as long as organic ones.
 *    4. What you actually SEE in the unit header: text reconstructed from
 *       geometry (immune to letter scrambling, decoys, off-screen text), SVG
 *       <use> chains (how "Ad" / "Sponsored" / timestamps are painted), aria
 *       labels — matched against multi-language "Sponsored"/"Ad", "AI content"
 *       and "Suggested for you"/"Follow"/"Join"/"Reels" dictionaries (the
 *       latter is skipped when Facebook's data says the unit is ORGANIC).
 *
 *  OPTIONAL CONSOLE API
 *    __killAds.stats()      counters            __killAds.hidden()   list hidden units
 *    __killAds.net()        blocked trackers, GraphQL operations, endpoints seen
 *    __killAds.stop()       pause               __killAds.start()    resume
 *    __killAds.unhide()     show everything     __killAds.inspect($0) explain one element
 *    __killAds.cleanUrl(u)  clean one URL
 *    __killAds.cfg.debug = true                 log every decision
 *    __killAds.cfg.verbose = 0 | 1 | 2          per-tick console line: off | collapsing | detailed
 *    __killAds.cfg.hideSuggested = false        keep "Suggested for you"/"Follow" units found visually
 *    __killAds.cfg.hideCategories = ['SPONSORED']   least aggressive: hide only real ads (+ AI)
 *    __killAds.cfg.cleanLinks / blockTrackers / directExternalClicks = false   switch a feature off
 * ========================================================================== */
(() => {
  'use strict';
  const W = window, D = document;
  if (W.__killAds) { try { W.__killAds.stop(); } catch (e) { /* ignore */ } }

  /* ---------------------------------------------------------------- config */
  const CFG = {
    tick: 250,                      // ms between full scans (DOM mutations trigger extra scans)
    // Feed-unit categories to hide (Facebook's own classification, see CATS below). Everything that is
    // not ORGANIC (friends / pages you follow / your groups) is hidden: ads, "Suggested for you",
    // Reels trays, PYMK, promotions, and units whose category cannot be decoded at all.
    hideCategories: ['SPONSORED', 'ENGAGEMENT', 'ENGAGEMENT_QP', 'PROMOTION', 'HIGH_VALUE_PROMOTION',
      'FRIENDLY_FEED_PROMOTION', 'FRIENDLY_FEED_MID_CARD', 'SHOWCASE', 'FB_SHORTS', 'FB_SHORTS_FALLBACK',
      'END_OF_FEED_REELS', 'TRENDING', 'INJECTED_STORY', 'FB_STORIES_ENGAGEMENT', 'UNDECODED'],
    hideAI: true,                   // hide posts Facebook marks as AI-generated
    hideSuggested: true,            // hide units whose header says "Suggested for you" / "Follow" / "Join" / Reels ...
    hideRightRail: true,            // the "Sponsored" box in the right column
    cftLength: 280,                 // __cft__[0] token length that marks an ad (organic ~190-210, ads ~390)
    headerHeight: 260,              // px from the top of a unit that count as "header" for label search
    visualRetries: 24,              // rendered ticks during which the visual check is repeated per unit
    cleanLinks: true,               // strip fbclid/__cft__/__tn__/utm_... from every link, unwrap l.facebook.com/l.php?u=
    directExternalClicks: true,     // clicks on external links go straight to the site (Facebook's click handlers never see them)
    blockTrackers: true,            // answer Facebook's telemetry beacons locally instead of sending them
    blockUrls: [                    // request URLs (XHR / fetch / sendBeacon) that are pure tracking
      /\/ajax\/bz(\?|\/|$)/, /\/ajax\/bnzai/, /\/tr\/?(\?|$)/, /\/privacy_sandbox\//, /\/security\/hsts-pixel\.gif/,
      /\/common\/scribe_endpoint\.php/, /\/ajax\/webstorage\/process_keys/, /\/ajax\/typeahead\/record_basic_metrics/,
      /\/\/(pixel|an|connect)\.facebook\.(com|net)\//, /\/ajax\/qm\//, /\/ajax\/error\//, /\/ajax\/logging\//,
    ],
    // GraphQL requests whose fb_api_req_friendly_name matches this are telemetry (impression / view logging)
    blockGraphql: /Impression|Logging|Logger|LogEvent|Telemetry|Falco|Viewability|ClientLog|VPVD|Analytics|ViewLog|Beacon|Metrics/i,
    verbose: 1,                     // 0 quiet · 1 one console line per tick (identical lines collapse in DevTools)
                                    //   + one line per hidden unit · 2 per-tick line with scan#/ms (never collapses)
    debug: false,                   // log every decision (very chatty)
    suggestedLabels: [
      // en
      'Suggested for you', 'Suggested Reels', 'Suggested Reel', 'Reels and short videos', 'Reels', 'People you may know',
      'Suggested groups', 'Groups you might like', 'Suggested pages', 'Pages you might like', 'Suggested events',
      'Recommended for you', 'Popular near you', 'Trending', 'Suggested post', 'Suggested content', 'Videos for you',
      'Reels for you', 'Follow', 'Join', 'Join group', 'Sponsored · Follow',
      // pl
      'Proponowane dla Ciebie', 'Propozycje dla Ciebie', 'Sugerowane dla Ciebie', 'Rolki', 'Rolki i krótkie filmy',
      'Osoby, które możesz znać', 'Proponowane grupy', 'Grupy, które mogą Ci się spodobać', 'Obserwuj', 'Dołącz', 'Dołącz do grupy',
      'Popularne w Twojej okolicy', 'Polecane dla Ciebie',
      // de
      'Vorschläge für dich', 'Vorgeschlagen für dich', 'Reels und Kurzvideos', 'Personen, die du kennen könntest',
      'Vorgeschlagene Gruppen', 'Folgen', 'Beitreten', 'Gruppe beitreten',
      // fr
      'Suggestions pour vous', 'Suggéré pour vous', 'Reels et vidéos courtes', 'Vous connaissez peut-être', 'Groupes suggérés',
      'Suivre', 'Rejoindre', 'Rejoindre le groupe',
      // es
      'Sugerencias para ti', 'Sugerido para ti', 'Reels y videos cortos', 'Personas que quizás conozcas', 'Grupos sugeridos',
      'Seguir', 'Unirte', 'Unirse al grupo', 'Unirte al grupo',
      // pt
      'Sugestões para você', 'Sugerido para você', 'Sugestões para ti', 'Reels e vídeos curtos', 'Pessoas que você talvez conheça',
      'Pessoas que talvez conheças', 'Participar', 'Participar do grupo',
      // it
      'Suggeriti per te', 'Consigliati per te', 'Reels e video brevi', 'Persone che potresti conoscere', 'Gruppi suggeriti',
      'Segui', 'Iscriviti', 'Unisciti al gruppo',
      // nl
      'Voorgesteld voor jou', 'Suggesties voor jou', "Reels en korte video's", 'Mensen die je misschien kent', 'Voorgestelde groepen',
      'Volgen', 'Lid worden',
      // ru / uk / cs / sk
      'Рекомендации для вас', 'Рекомендуется для вас', 'Возможно, вы знакомы', 'Подписаться', 'Присоединиться', 'Вступить',
      'Рекомендації для вас', 'Можливо, ви знайомі', 'Підписатися', 'Приєднатися',
      'Návrhy pro vás', 'Doporučeno pro vás', 'Lidé, které možná znáte', 'Sledovat', 'Připojit se',
      'Odporúčané pre vás', 'Sledovať', 'Pripojiť sa',
    ],
    labels: [
      // en
      'Sponsored', 'Ad', 'Ads', 'Paid partnership', 'Advertisement', 'Promoted',
      // pl
      'Sponsorowane', 'Sponsorowany', 'Sponsorowana', 'Reklama', 'Reklamy', 'Płatna współpraca', 'Promowane',
      // de / nl / da / sv / no / fi
      'Gesponsert', 'Anzeige', 'Werbung', 'Gesponsord', 'Advertentie', 'Sponsoreret', 'Annonce',
      'Sponsrad', 'Sponsrat', 'Annons', 'Sponset', 'Annonse', 'Sponsoroitu', 'Mainos',
      // fr / es / pt / it / ro / ca
      'Sponsorisé', 'Sponsorisée', 'Commandité', 'Publicité', 'Publicidad', 'Patrocinado', 'Patrocinada',
      'Anuncio', 'Anúncio', 'Sponsorizzato', 'Sponsorizzata', 'Pubblicità', 'Sponsorizat', 'Reclamă', 'Patrocinat',
      // cs / sk / hu / hr / sr / sl / bg / uk / ru / el / tr
      'Sponzorováno', 'Sponzorované', 'Sponzorovaný', 'Szponzorált', 'Hirdetés', 'Sponzorirano', 'Oglas',
      'Спонзорисано', 'Спонзорирано', 'Реклама', 'Спонсируется', 'Спонсорується', 'Χορηγούμενη', 'Χορηγούμενο',
      'Διαφήμιση', 'Sponsorlu', 'Reklam',
      // ar / he / hi / bn / th / vi / id / ms
      'مُموَّل', 'ممول', 'إعلان', 'ממומן', 'פרסומת', 'प्रायोजित', 'विज्ञापन', 'স্পনসর্ড', 'ได้รับการสนับสนุน', 'โฆษณา',
      'Được tài trợ', 'Quảng cáo', 'Bersponsor', 'Iklan', 'Ditaja',
      // ja / ko / zh
      '広告', 'スポンサー', '광고', '赞助', '贊助', '赞助内容', '廣告', '广告',
    ],
    aiLabels: [
      // en
      'AI content', 'AI info', 'AI label', 'Made with AI', 'Created with AI', 'Generated with AI', 'Imagined with AI',
      'AI-generated', 'AI generated',
      // pl
      'Treść AI', 'Treści AI', 'Informacje o AI', 'Etykieta AI', 'Utworzone przy użyciu AI', 'Utworzono za pomocą AI',
      'Wygenerowane przez AI', 'Wygenerowano przez AI',
      // de / nl / da / sv / no / fi
      'KI-Info', 'KI-Inhalt', 'KI-Inhalte', 'Mit KI erstellt', 'KI-generiert', 'AI-info', 'AI-inhoud', 'Gemaakt met AI',
      'AI-indhold', 'Lavet med AI', 'AI-innehåll', 'Skapad med AI', 'AI-innhold', 'KI-innhold', 'Laget med KI',
      'Tekoälysisältö', 'Tekoälyllä luotu',
      // fr / es / pt / it / ro / ca
      'Infos IA', 'Contenu IA', "Créé avec l'IA", 'Généré par IA', "Généré par l'IA", 'Info de IA', 'Información de IA',
      'Contenido de IA', 'Creado con IA', 'Generado con IA', 'Informações de IA', 'Conteúdo de IA', 'Criado com IA',
      'Gerado por IA', 'Info IA', 'Contenuto IA', "Creato con l'IA", 'Generato con IA', 'Conținut AI', 'Creat cu AI',
      // cs / sk / hu / hr / sr / bg / uk / ru / el / tr
      'Obsah AI', 'Informace o AI', 'Vytvořeno pomocí AI', 'Obsah vytvorený AI', 'AI-tartalom', 'MI-tartalom',
      'AI sadržaj', 'Sadržaj AI', 'Съдържание с ИИ', 'Контент ШІ', 'Створено за допомогою ШІ', 'Контент ИИ',
      'Создано с помощью ИИ', 'Περιεχόμενο AI', 'Yapay zeka içeriği', 'YZ içeriği', 'Yapay zeka ile oluşturuldu',
      // ar / he / ja / ko / zh
      'محتوى الذكاء الاصطناعي', 'تم إنشاؤه بالذكاء الاصطناعي', 'תוכן AI', 'נוצר באמצעות AI',
      'AIコンテンツ', 'AI情報', 'AIで作成', 'AI 콘텐츠', 'AI 정보', 'AI로 제작됨', 'AI 内容', 'AI 內容', 'AI 信息', 'AI 資訊', '由 AI 生成',
    ],
  };

  // Feed-unit categories as used by Facebook (verified: SPONSORED = 5).
  const CATS = {
    UNKNOWN: 0, ORGANIC: 1, ENGAGEMENT: 2, FIXED_POSITION: 3, PROMOTION: 4, SPONSORED: 5,
    END_OF_FEED_CONTENT: 6, FB_STORIES: 7, HIGH_VALUE_PROMOTION: 8, FB_STORIES_ENGAGEMENT: 9,
    SHOWCASE: 10, FB_SHORTS: 11, TRENDING: 12, ENGAGEMENT_QP: 13, MULTI_FB_STORIES_TRAY: 14,
    END_OF_FEED_REELS: 15, FB_SHORTS_FALLBACK: 16, FRIENDLY_FEED_MID_CARD: 17,
    FRIENDLY_FEED_PROMOTION: 18, INJECTED_STORY: 19, LIMITED_PERSONALIZATION_NOTICE: 20,
  };
  const HEX64 = /^[0-9a-f]{64}$/;

  const stats = {
    hidden: 0, byMethod: {}, byCategory: {}, scans: 0, units: 0, lastScanMs: 0,
    payloads: 0, edges: 0, decoded: 0, undecoded: 0, tokens: 0, xhr: 0, fetch: 0, blobs: 0, parseErrors: 0,
  };
  const state = new WeakMap();       // unit element -> {status, tries, vtries, cat, method}
  const hiddenUnits = new Set();
  const TAG = '%c[kill-ads]%c', TAG_CSS = 'color:#e0245e;font-weight:bold', RESET_CSS = 'color:inherit';
  const say = (msg, ...a) => console.log(TAG + ' ' + msg, TAG_CSS, RESET_CSS, ...a);
  const log = (...a) => { if (CFG.debug) console.log('%c[kill-ads]', TAG_CSS, ...a); };
  function excerpt(el) {
    let t = '';
    try { t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e) { /* ignore */ }
    return t.length > 90 ? t.slice(0, 90) + '…' : t;
  }

  /* ---------------------------------------------------------------- crypto */
  const shaCache = new Map();
  async function sha256(str) {
    let v = shaCache.get(str);
    if (v) return v;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    v = Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
    if (shaCache.size > 20000) shaCache.clear();
    shaCache.set(str, v);
    return v;
  }
  // enc == sha256(sha256(post_id) + categoryNumber)  -> category name (or null)
  async function decodeEnc(enc, ids) {
    for (const id of ids) {
      const base = await sha256(String(id));
      for (const [name, num] of Object.entries(CATS)) {
        if (await sha256(base + num) === enc) return name;
      }
      for (const name of Object.keys(CATS)) {
        if (await sha256(base + name) === enc) return name;
      }
    }
    return null;
  }

  /* ------------------------------------------------------ GraphQL data layer */
  // token (__cft__[0] == encrypted_click_tracking) -> info, post_id -> info
  const byToken = new Map(), byPost = new Map();
  const groups = new Map();          // response / preloader key -> Map(edgeIndex -> info)

  function walk(o, fn, depth) {
    depth = depth || 0;
    if (!o || typeof o !== 'object' || depth > 90) return;
    if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) walk(o[i], fn, depth + 1); return; }
    if (fn(o) === false) return;
    for (const k in o) { const v = o[k]; if (v && typeof v === 'object') walk(v, fn, depth + 1); }
  }
  function trimMap(m, keep) {
    let drop = m.size - keep;
    for (const k of m.keys()) { if (drop-- <= 0) break; m.delete(k); }
  }
  function getGroup(key) {
    let g = groups.get(key);
    if (!g) {
      g = new Map(); g.pending = new Map();
      groups.set(key, g);
      if (groups.size > 80) trimMap(groups, 40);
    }
    return g;
  }
  function aiPositive(o) {
    if (o.was_detected_as_ai_generated === true || o.was_self_disclosed_as_ai_generated === true) return true;
    if (o.zero_click_transparency_label) return true;
    const d = o.ai_generated_detected_info;
    if (d && typeof d === 'object' && (d.gen_ai_transparency_type || d.ai_character_owner)) return true;
    // unknown schema variant: the strategy is present at all -> treat as AI (bias to hide)
    return o.was_detected_as_ai_generated === undefined && o.was_self_disclosed_as_ai_generated === undefined;
  }
  // Pull tokens / sponsored / AI markers out of an edge (or a deferred part of it).
  function absorb(obj, info) {
    walk(obj, o => {
      const t = o.encrypted_click_tracking;
      if (typeof t === 'string' && t.length > 20) info.tokens.add(t);
      const tn = o.__typename;
      if (typeof tn === 'string') {
        if (tn === 'SponsoredData') { if (Object.keys(o).length > 1) info.sponsored = true; }
        else if (tn.indexOf('SponsoredLabel') >= 0 || tn.indexOf('SponsoredContext') >= 0) info.sponsored = true;
        else if (tn.indexOf('GenAIContentTransparency') >= 0 || tn.indexOf('AILabel') >= 0 || tn.indexOf('AiLabel') >= 0) { if (aiPositive(o)) info.ai = true; }
      }
      if (o.was_detected_as_ai_generated === true || o.was_self_disclosed_as_ai_generated === true) info.ai = true;
      if (o.ad_id && o.client_token) info.sponsored = true;
      return true;
    });
  }
  function publish(info) {
    for (const t of info.tokens) { if (!byToken.has(t)) stats.tokens++; byToken.set(t, info); }
    if (info.postId) byPost.set(info.postId, info);
    if (byToken.size > 8000) trimMap(byToken, 4000);
    if (byPost.size > 8000) trimMap(byPost, 4000);
  }
  function registerEdge(edge, group, n) {
    if (!edge || typeof edge !== 'object') return;
    const node = edge.node && typeof edge.node === 'object' ? edge.node : {};
    const info = {
      cat: null, decoded: false, ai: false, sponsored: false, tokens: new Set(), n,
      postId: node.post_id != null ? String(node.post_id) : null, type: node.__typename || null,
    };
    group.set(n, info);
    absorb(edge, info);
    const cs = edge.cat_sensitive;
    if (cs && typeof cs === 'object') {
      if (typeof cs.cat === 'string' && cs.cat) { info.cat = cs.cat; info.decoded = true; }
      else if (typeof cs.enc === 'string' && HEX64.test(cs.enc)) {
        const ids = [...new Set([node.post_id, node.id, edge.deduplication_key, node.deduplication_key]
          .filter(v => v != null && /^\d{5,}$/.test(String(v))).map(String))];
        decodeEnc(cs.enc, ids).then(cat => {
          info.decoded = true;
          if (cat) { info.cat = cat; stats.decoded++; } else { info.cat = 'UNDECODED'; stats.undecoded++; }
          publish(info); schedule();
        }).catch(() => { info.decoded = true; });
      } else info.decoded = true;
    } else info.decoded = true;
    stats.edges++;
    const pend = group.pending.get(n);
    if (pend) { for (const d of pend) absorb(d, info); group.pending.delete(n); }
    publish(info);
    if (info.sponsored || info.ai || (info.cat && CFG.hideCategories.includes(info.cat))) schedule();
  }
  function attachDeferred(group, n, data) {
    const info = group.get(n);
    if (info) { absorb(data, info); publish(info); return; }
    let arr = group.pending.get(n);
    if (!arr) { arr = []; group.pending.set(n, arr); }
    if (arr.length < 50) arr.push(data);
  }
  const isEdge = e => !!e && typeof e === 'object' && !Array.isArray(e) &&
    ('cat_sensitive' in e || (e.node && typeof e.node === 'object' && ('__isFeedUnit' in e.node || e.node.__typename === 'Story')));
  function findEdges(data, group) {
    walk(data, o => {
      const edges = o.edges;
      if (Array.isArray(edges) && edges.length && edges.some(isEdge)) {
        edges.forEach((e, n) => { if (isEdge(e)) registerEdge(e, group, n); });
        return false;
      }
      return true;
    });
  }
  // A "chunk" is one GraphQL result object: {data, extensions} or a streamed/deferred {label, path, data}.
  function collectChunks(root, out) {
    if (!root || typeof root !== 'object') return;
    const isChunk = o => o.data && typeof o.data === 'object' && !Array.isArray(o.data) && ('path' in o || 'extensions' in o || 'label' in o);
    if (!Array.isArray(root) && isChunk(root)) { out.push(root); return; }
    walk(root, o => { if (isChunk(o)) { out.push(o); return false; } return true; });
  }
  function ingestResults(results, key) {
    const group = getGroup(key);
    const chunks = [];
    for (const r of results) collectChunks(r, chunks);
    for (const c of chunks) {
      const path = Array.isArray(c.path) ? c.path : null;
      const i = path ? path.lastIndexOf('edges') : -1;
      if (path && i >= 0 && typeof path[i + 1] === 'number') {
        if (path.length === i + 2) registerEdge(c.data, group, path[i + 1]);
        else attachDeferred(group, path[i + 1], c.data);
      } else {
        findEdges(c.data, group);
      }
    }
  }
  const RELEVANT = ['cat_sensitive', 'encrypted_click_tracking', 'SponsoredData', 'GenAIContentTransparency'];
  function ingestText(text, key) {
    if (typeof text !== 'string' || text.length < 50) return;
    if (!RELEVANT.some(s => text.indexOf(s) >= 0)) return;
    stats.payloads++;
    const results = [];
    const lines = text.split('\n');
    for (let l of lines) {
      l = l.trim();
      if (!l) continue;
      if (l.startsWith('for (;;);')) l = l.slice(9);
      try { results.push(JSON.parse(l)); } catch (e) { stats.parseErrors++; }
    }
    if (!results.length && lines.length > 1) { try { results.push(JSON.parse(text)); } catch (e) { /* ignore */ } }
    if (results.length) { try { ingestResults(results, key); } catch (e) { log('ingest error', e); } }
  }

  // JSON Facebook embeds in the HTML (initial feed page + streamed SSR chunks).
  const seenScripts = new WeakSet();
  function ingestScripts() {
    const scripts = D.querySelectorAll('script[type="application/json"]');
    for (let i = 0; i < scripts.length; i++) {
      const s = scripts[i];
      if (seenScripts.has(s)) continue;
      seenScripts.add(s);
      const t = s.textContent;
      if (!t || t.length < 200) continue;
      stats.blobs++;
      const m = /"(adp_[A-Za-z0-9_]+)"/.exec(t);
      ingestText(t, m ? m[1] : 'blob' + i + ':' + t.length);
    }
  }

  /* ---------------------------------------------- network hooks + tracker blocking */
  // Hooks are installed once per page (per HOOK_GEN) and always forward to the *current* instance
  // (window.__killAds), so re-pasting the script keeps working and the newest config decides.
  const HOOK_GEN = 3;
  let seq = 0;
  const GQL = /\/api\/graphql|\/graphql\//i;
  const dispatch = (text, key) => { const inst = W.__killAds; if (inst && inst._ingest) inst._ingest(text, key); };
  const decide = (url, body, via) => { const inst = W.__killAds; return inst && inst._net ? inst._net(String(url), body, via) : null; };
  const FAKE_BODY = 'for (;;);{"__ar":1,"payload":null,"lid":"0"}';
  const FAKE_TYPE = 'application/x-javascript; charset=utf-8';

  const net = { seen: new Map(), blocked: new Map(), gql: new Map(), total: 0, blockedTotal: 0 };
  const bump = (map, k, cap) => { if (map.size < (cap || 600) || map.has(k)) map.set(k, (map.get(k) || 0) + 1); };
  function netKey(url) {
    try { const u = new URL(url, W.location.href); return u.hostname + u.pathname.replace(/\d{4,}/g, 'N').slice(0, 90); } catch (e) { return String(url).slice(0, 90); }
  }
  function friendlyName(body) {
    try {
      if (typeof body === 'string') { const m = /(?:^|&)fb_api_req_friendly_name=([^&]+)/.exec(body); return m ? decodeURIComponent(m[1]) : null; }
      if (body && typeof body.get === 'function') { const v = body.get('fb_api_req_friendly_name'); return v == null ? null : String(v); }
    } catch (e) { /* ignore */ }
    return null;
  }
  // Decide whether a request is tracking. Returns a reason string (=> block) or null.
  function netDecision(url, body, via) {
    net.total++;
    const key = netKey(url);
    if (!/rsrc\.php|fbcdn\.net|fbsbx\.com/.test(url)) bump(net.seen, via + ' ' + key);
    let why = null;
    if (CFG.blockTrackers) {
      for (const re of CFG.blockUrls) { if (re.test(url)) { why = 'url'; break; } }
      if (!why && GQL.test(url)) {
        const name = friendlyName(body);
        if (name) { bump(net.gql, name); if (CFG.blockGraphql && CFG.blockGraphql.test(name)) why = 'graphql:' + name; }
      }
    }
    if (why) {
      net.blockedTotal++;
      const k = via + ' ' + (why === 'url' ? key : why);
      const n = (net.blocked.get(k) || 0) + 1;
      net.blocked.set(k, n);
      if (CFG.verbose >= 2 || (CFG.verbose && n === 1)) say(`blocked tracker ${k}${n > 1 ? ' ×' + n : ''}`);
    }
    return why;
  }
  function fakeXhrSuccess(xhr, url) {
    let response = FAKE_BODY;
    try {
      const rt = xhr.responseType;
      if (rt === 'json') response = { __ar: 1, payload: null };
      else if (rt === 'arraybuffer') response = new TextEncoder().encode(FAKE_BODY).buffer;
      else if (rt === 'blob') response = new Blob([FAKE_BODY], { type: FAKE_TYPE });
    } catch (e) { /* ignore */ }
    const props = { readyState: 4, status: 200, statusText: 'OK', responseURL: url, responseText: FAKE_BODY, response };
    for (const k in props) { try { Object.defineProperty(xhr, k, { value: props[k], configurable: true, writable: true }); } catch (e) { /* ignore */ } }
    try {
      xhr.getAllResponseHeaders = () => 'content-type: ' + FAKE_TYPE + '\r\n';
      xhr.getResponseHeader = n => (/^content-type$/i.test(String(n)) ? FAKE_TYPE : null);
    } catch (e) { /* ignore */ }
    setTimeout(() => {
      try { xhr.dispatchEvent(new Event('readystatechange')); } catch (e) { /* ignore */ }
      for (const t of ['load', 'loadend']) {
        try { xhr.dispatchEvent(new ProgressEvent(t, { lengthComputable: true, loaded: FAKE_BODY.length, total: FAKE_BODY.length })); } catch (e) { /* ignore */ }
      }
    }, 0);
  }
  function hookXHR() {
    const P = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
    if (!P || P.__killAdsHooked >= HOOK_GEN) return;
    const open = P.open, send = P.send;
    P.open = function (method, url) {
      try { this.__killAdsUrl = String(url); } catch (e) { /* ignore */ }
      return open.apply(this, arguments);
    };
    P.send = function (body) {
      const url = this.__killAdsUrl || '';
      try {
        if (decide(url, body, 'xhr')) { fakeXhrSuccess(this, url); return; }
        if (GQL.test(url)) {
          const key = 'xhr' + (++seq);
          let consumed = 0;
          const pump = final => {
            let txt = null;
            try { if (this.responseType === '' || this.responseType === 'text') txt = this.responseText; } catch (e) { txt = null; }
            if (txt == null && final) {
              try { const r = this.response; if (r instanceof ArrayBuffer) txt = new TextDecoder().decode(r); else if (typeof r === 'string') txt = r; } catch (e) { /* ignore */ }
            }
            if (txt == null || txt.length <= consumed) return;
            const end = final ? txt.length : txt.lastIndexOf('\n');
            if (end <= consumed) return;
            const part = txt.slice(consumed, end);
            consumed = end;
            const inst = W.__killAds; if (inst) inst._stats.xhr++;
            dispatch(part, key);
          };
          this.addEventListener('progress', () => pump(false));
          this.addEventListener('loadend', () => pump(true));
        }
      } catch (e) { /* ignore */ }
      return send.apply(this, arguments);
    };
    P.__killAdsHooked = HOOK_GEN;
  }
  async function readStream(body, key) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const i = buf.lastIndexOf('\n');
      if (i >= 0) { dispatch(buf.slice(0, i), key); buf = buf.slice(i + 1); }
    }
    buf += dec.decode();
    if (buf.trim()) dispatch(buf, key);
  }
  function hookFetch() {
    if (typeof W.fetch !== 'function' || W.fetch.__killAdsHooked >= HOOK_GEN) return;
    const orig = W.fetch;
    const hooked = function (input, init) {
      let url = '';
      try { url = typeof input === 'string' ? input : (input && input.url) || String(input); } catch (e) { /* ignore */ }
      try {
        const body = init && init.body != null ? init.body : null;
        if (decide(url, typeof body === 'string' || (body && typeof body.get === 'function') ? body : null, 'fetch')) {
          return Promise.resolve(new Response(FAKE_BODY, { status: 200, statusText: 'OK', headers: { 'content-type': FAKE_TYPE } }));
        }
        if (init && init.attributionReporting) { init = Object.assign({}, init); delete init.attributionReporting; }
      } catch (e) { /* ignore */ }
      const p = init === undefined ? orig.call(this, input) : orig.call(this, input, init);
      try {
        if (GQL.test(url)) {
          return p.then(res => {
            try {
              const inst = W.__killAds; if (inst) inst._stats.fetch++;
              const key = 'fetch' + (++seq);
              const clone = res.clone();
              if (clone.body && typeof clone.body.getReader === 'function') readStream(clone.body, key).catch(() => {});
              else clone.text().then(t => dispatch(t, key)).catch(() => {});
            } catch (e) { /* ignore */ }
            return res;
          });
        }
      } catch (e) { /* ignore */ }
      return p;
    };
    hooked.__killAdsHooked = HOOK_GEN;
    try { W.fetch = hooked; } catch (e) { /* ignore */ }
  }
  function hookBeacon() {
    const N = W.navigator;
    if (!N || typeof N.sendBeacon !== 'function' || N.sendBeacon.__killAdsHooked >= HOOK_GEN) return;
    const orig = N.sendBeacon;
    const hooked = function (url, data) {
      try { if (decide(url, typeof data === 'string' || (data && typeof data.get === 'function') ? data : null, 'beacon')) return true; } catch (e) { /* ignore */ }
      return orig.apply(this, arguments);
    };
    hooked.__killAdsHooked = HOOK_GEN;
    try { N.sendBeacon = hooked; } catch (e) { /* ignore */ }
  }
  function hookOpen() {
    if (typeof W.open !== 'function' || W.open.__killAdsHooked >= HOOK_GEN) return;
    const orig = W.open;
    const hooked = function (url, ...rest) {
      try {
        const inst = W.__killAds;
        if (inst && inst._cleanUrl && typeof url === 'string') {
          const c = inst._cleanUrl(url);
          if (c) { if (inst.cfg.verbose) inst._say('window.open cleaned → ' + c.href.slice(0, 140)); url = c.href; }
        }
      } catch (e) { /* ignore */ }
      return orig.call(this, url, ...rest);
    };
    hooked.__killAdsHooked = HOOK_GEN;
    try { W.open = hooked; } catch (e) { /* ignore */ }
  }
  let resObs = null;
  function observeResources() {
    if (!W.PerformanceObserver || resObs) return;
    try {
      resObs = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          const it = e.initiatorType;
          if (it === 'xmlhttprequest' || it === 'fetch' || it === 'beacon' || /rsrc\.php|fbcdn\.net|fbsbx\.com/.test(e.name)) continue;
          bump(net.seen, it + ' ' + netKey(e.name));
        }
      });
      resObs.observe({ type: 'resource', buffered: true });
    } catch (e) { resObs = null; }
  }

  /* ------------------------------------------------------------ link cleaning */
  const FB_HOST = /(^|\.)(facebook\.com|fb\.com|fb\.me|fb\.watch|messenger\.com|m\.me|instagram\.com|threads\.net|workplace\.com|meta\.com)$/i;
  const SHIM_HOST = /^(l|lm)\.(facebook|messenger|instagram|workplace|threads)\.(com|net)$/i;   // l.facebook.com/l.php?u=<real url>
  const NEVER_HOST = /(^|\.)(fbcdn\.net|fbcdn\.com|fbsbx\.com|cdninstagram\.com)$/i;              // signed CDN URLs: never touch
  const YT_HOST = /(^|\.)(youtube\.com|youtu\.be)$/i;
  const TRACK_PARAMS = new Set(['fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', 'igsh',
    'twclid', 'ttclid', 'yclid', 'srsltid', '_ga', '_gl', '_hsenc', '_hsmi', 'mkt_tok', 'oly_anon_id', 'oly_enc_id', 'vero_id', 'vero_conv',
    'wickedid', 's_kwcid', 'ef_id', 'rb_clickid', 'sc_cid', 'trk', 'mibextid', 'sfnsn', 'fb_action_ids', 'fb_action_types', 'fb_source', 'fb_ref']);
  const TRACK_PREFIX = /^(utm_|fb_|hsa_|pk_|piwik_|mtm_|oly_|vero_|__cft__|__xts__|__tn__|__eep__|__so__|__rv__)/i;
  const FB_PARAMS = new Set(['ref', 'refid', 'refsrc', 'ref_type', 'ref_component', 'ref_page', 'ref_src', 'fref', 'hc_ref', 'hc_location',
    'eid', 'comment_tracking', 'notif_id', 'notif_t', 'notif_ids', 'tn', 'idorvanity', 'dti', 'tracking', 'action_history', 'ls_ref',
    'referral_code', 'referral_story_type', 'entrypoint', 'entry_point', 'source_ref', 'nav_source', '_rdr', '_rdc', 'rdr', 'rdc', '_nc_x',
    'video_source', 'ftentidentifier', 'rdid', 'paipv', 'eav', 'extid', 'wtsid', 'share_url']);
  function isTrackingParam(name, fb, yt) {
    const n = name.toLowerCase();
    if (TRACK_PARAMS.has(n) || TRACK_PREFIX.test(n)) return true;
    if (yt && (n === 'si' || n === 'feature' || n === 'pp')) return true;
    return fb && (FB_PARAMS.has(n) || /^(ref|hc_)[a-z_]*$/.test(n) || /^__[a-z]+__(\[\d+\])?$/.test(n) || /^c\[\d+\]$/.test(n));
  }
  function stripQuery(u, fb) {
    const parts = u.search.slice(1).split('&');
    const keep = [];
    const yt = YT_HOST.test(u.hostname);
    let changed = false;
    for (const p of parts) {
      if (!p) { changed = true; continue; }
      const eq = p.indexOf('=');
      let name = eq >= 0 ? p.slice(0, eq) : p;
      try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch (e) { /* keep raw */ }
      if (isTrackingParam(name, fb, yt)) { changed = true; continue; }
      keep.push(p);
    }
    if (changed) u.search = keep.length ? '?' + keep.join('&') : '';
    return changed;
  }
  // -> {href, external} when the URL had to change, null when it is already clean
  function cleanUrl(raw) {
    if (typeof raw !== 'string' || raw.length < 8 || raw[0] === '#') return null;
    if (/^\s*(javascript|mailto|tel|sms|blob|data):/i.test(raw)) return null;
    let u;
    try { u = new URL(raw, W.location.href); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (NEVER_HOST.test(u.hostname)) return null;
    let changed = false, hops = 0;
    while (SHIM_HOST.test(u.hostname) && hops++ < 3) {
      const target = u.searchParams.get('u');
      if (!target) break;
      let t;
      try { t = new URL(target); } catch (e) { break; }
      if (t.protocol !== 'http:' && t.protocol !== 'https:') break;
      u = t; changed = true;
    }
    const fb = FB_HOST.test(u.hostname);
    if (u.search.length > 1 && stripQuery(u, fb)) changed = true;
    if (u.hash && /fbclid=/i.test(u.hash)) { u.hash = ''; changed = true; }
    return changed ? { href: u.href, external: !fb } : null;
  }
  const cftOf = new WeakMap();   // anchor -> __cft__[0] token, remembered before the href is cleaned (detection needs it)
  let linksCleaned = 0;
  const decodeTok = t => { if (t.indexOf('%') >= 0) { try { return decodeURIComponent(t); } catch (e) { /* raw */ } } return t; };
  function cleanAnchor(a) {
    const raw = a.getAttribute('href');
    if (raw == null || a.__ka === raw) return;
    if (raw.indexOf('__cft__') >= 0) { const m = CFT_RE.exec(raw); if (m) cftOf.set(a, decodeTok(m[1])); }
    if (a.hasAttribute('ping')) a.removeAttribute('ping');
    if (a.hasAttribute('attributionsrc')) a.removeAttribute('attributionsrc');
    const c = CFG.cleanLinks ? cleanUrl(raw) : null;
    if (!c) { a.__ka = raw; return; }
    let out = c.href;
    const origin = W.location.origin + '/';
    if (raw[0] === '/' && raw[1] !== '/' && out.startsWith(origin)) out = out.slice(origin.length - 1);
    a.setAttribute('href', out);
    if (c.external) {
      const rel = (a.getAttribute('rel') || '').split(/\s+/).filter(Boolean);
      for (const r of ['noopener', 'noreferrer']) if (!rel.includes(r)) rel.push(r);
      a.setAttribute('rel', rel.join(' '));
      for (const at of ['data-lynx-uri', 'data-lynx-mode', 'onmouseover', 'onclick']) if (a.hasAttribute(at)) a.removeAttribute(at);
    }
    a.__ka = out;
    linksCleaned++;
    if (CFG.verbose >= 2) say('link cleaned: ' + raw.slice(0, 100) + ' → ' + out.slice(0, 100));
  }
  function cleanAnchorsIn(root) {
    if (root.tagName === 'A') { cleanAnchor(root); return; }
    const as = root.getElementsByTagName ? root.getElementsByTagName('a') : [];
    for (let i = 0; i < as.length; i++) if (as[i].hasAttribute('href')) cleanAnchor(as[i]);
  }
  function cleanLinks(full) {
    const L = D.links;
    for (let i = 0; i < L.length; i++) cleanAnchor(L[i]);
    if (full) {
      const els = D.querySelectorAll('[attributionsrc],[ping]');
      for (let i = 0; i < els.length; i++) { els[i].removeAttribute('attributionsrc'); els[i].removeAttribute('ping'); }
    }
  }
  // External links: make sure the browser navigates to the clean URL and Facebook's click handlers
  // (click logging, link-shim swap) never run. Internal links are left to Facebook's router.
  function onClickCapture(e) {
    if (!running || !CFG.directExternalClicks) return;
    const t = e.target;
    const a = t && t.closest ? t.closest('a[href]') : null;
    if (!a) return;
    cleanAnchor(a);
    let u;
    try { u = new URL(a.href, W.location.href); } catch (err) { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (u.hostname === W.location.hostname || FB_HOST.test(u.hostname) || NEVER_HOST.test(u.hostname)) return;
    e.stopPropagation();
    if (CFG.verbose) say('external link opened directly: ' + u.href.slice(0, 140));
  }

  /* ------------------------------------------------------ text normalization */
  const ZW = /[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD\u034F\u180E]/g;
  const norm = s => String(s == null ? '' : s).normalize('NFKC').replace(ZW, '').replace(/[’‘`´]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  const trimPunct = s => s.replace(/^[\s·•.:|\-–—,()[\]]+|[\s·•.:|\-–—,()[\]]+$/g, '');
  let AD_LABELS = new Set(), AI_LABELS = new Set(), SUG_LABELS = new Set(), AD_LONG = [], AI_LONG = [], SUG_LONG = [];
  function refreshLabels() {
    AD_LABELS = new Set(CFG.labels.map(norm));
    AI_LABELS = new Set(CFG.aiLabels.map(norm));
    SUG_LABELS = new Set((CFG.suggestedLabels || []).map(norm));
    AD_LONG = [...AD_LABELS].filter(l => l.length >= 6);
    AI_LONG = [...AI_LABELS].filter(l => l.length >= 6);
    SUG_LONG = [...SUG_LABELS].filter(l => l.length >= 10);   // short ones ("follow", "join") only match whole segments
  }
  // Visible header text -> {cat:'SPONSORED'|'AI_CONTENT'|'SUGGESTED', label} or null
  function classifyText(text) {
    const t = trimPunct(norm(text));
    if (!t) return null;
    if (AD_LABELS.has(t)) return { cat: 'SPONSORED', label: t };
    if (AI_LABELS.has(t)) return { cat: 'AI_CONTENT', label: t };
    let sug = null;
    if (CFG.hideSuggested && SUG_LABELS.has(t)) sug = { cat: 'SUGGESTED', label: t };
    for (const seg of t.split(/\s*[·•|]\s*/)) {
      const s = trimPunct(seg);
      if (!s) continue;
      if (AD_LABELS.has(s)) return { cat: 'SPONSORED', label: s };
      if (AI_LABELS.has(s)) return { cat: 'AI_CONTENT', label: s };
      if (!sug && CFG.hideSuggested && SUG_LABELS.has(s)) sug = { cat: 'SUGGESTED', label: s };
    }
    if (t.length <= 60) {
      for (const l of AD_LONG) if (t.indexOf(l) >= 0) return { cat: 'SPONSORED', label: l };
      for (const l of AI_LONG) if (t.indexOf(l) >= 0) return { cat: 'AI_CONTENT', label: l };
      if (!sug && CFG.hideSuggested) for (const l of SUG_LONG) if (t.indexOf(l) >= 0) { sug = { cat: 'SUGGESTED', label: l }; break; }
    }
    return sug;
  }

  /* -------------------------------------------------------- visual detection */
  const alpha = color => { const m = /rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+))?/.exec(color); return m ? (m[1] === undefined ? 1 : parseFloat(m[1])) : 1; };

  function makeVis(unit) {
    const styles = new Map();
    const cs = el => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s); } return s; };
    const hiddenCache = new Map();
    const hiddenByStyle = el => {
      if (hiddenCache.has(el)) return hiddenCache.get(el);
      let h = false;
      for (let e = el; e; e = e.parentElement) {
        if (hiddenCache.has(e)) { h = hiddenCache.get(e); break; }
        const s = cs(e);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0 ||
            (s.clipPath && s.clipPath !== 'none') || (s.clip && s.clip !== 'auto') ||
            parseFloat(s.fontSize) === 0 || (s.filter && /opacity\(0/.test(s.filter))) { h = true; break; }
        if (e === unit) break;
      }
      hiddenCache.set(el, h);
      return h;
    };
    const clipCache = new Map();
    const clipRect = el => {
      if (clipCache.has(el)) return clipCache.get(el);
      let r = { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 };
      for (let e = el; e; e = e.parentElement) {
        const s = cs(e);
        if (/hidden|clip|scroll|auto/.test(s.overflowX + ' ' + s.overflowY)) {
          const b = e.getBoundingClientRect();
          r = { left: Math.max(r.left, b.left), top: Math.max(r.top, b.top), right: Math.min(r.right, b.right), bottom: Math.min(r.bottom, b.bottom) };
        }
        if (e === unit || e === D.body) break;
      }
      clipCache.set(el, r);
      return r;
    };
    const rectVisible = (rect, el) => {
      if (rect.width <= 0.1 || rect.height <= 0.1) return false;
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const c = clipRect(el);
      return cx > c.left && cx < c.right && cy > c.top && cy < c.bottom;
    };
    const elementVisible = el => !hiddenByStyle(el) && rectVisible(el.getBoundingClientRect(), el);
    return { cs, hiddenByStyle, rectVisible, elementVisible };
  }

  // Reconstruct the visible text lines of the top part of `unit`, exactly as painted.
  function visibleLines(unit, maxTop, vis) {
    const uRect = unit.getBoundingClientRect();
    if (!uRect.width || !uRect.height) return [];
    const limitBottom = uRect.top + maxTop;
    const glyphs = [];
    const walker = D.createTreeWalker(unit, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const range = D.createRange();
    let n, count = 0, below = 0;
    while ((n = walker.nextNode()) && count++ < 500 && below < 40) {
      const p = n.parentElement;
      if (!p || p.closest('script,style,noscript')) continue;
      range.selectNodeContents(n);
      const rects = range.getClientRects();
      if (!rects.length) continue;
      const first = rects[0];
      if (first.top > limitBottom) { below++; continue; }
      if (first.bottom < uRect.top - 2) continue;
      if (vis.hiddenByStyle(p)) continue;
      const st = vis.cs(p);
      if (alpha(st.color) === 0 && !st.webkitTextFillColor) continue;
      if (!vis.rectVisible(first, p)) continue;
      glyphs.push({ x: first.left, x2: first.right, y: first.top, h: first.height, text: n.nodeValue.replace(ZW, ''), el: p });
    }
    glyphs.sort((a, b) => (Math.abs(a.y - b.y) > Math.min(a.h, b.h) * 0.6 ? a.y - b.y : a.x - b.x));
    const lines = [];
    for (const g of glyphs) {
      const cur = lines[lines.length - 1];
      if (cur && Math.abs(g.y - cur.y) <= Math.min(g.h, cur.h) * 0.6) {
        const gap = g.x - cur.x2;
        cur.text += (gap > g.h * 0.28 ? ' ' : '') + g.text;
        cur.x2 = Math.max(cur.x2, g.x2);
        cur.els.push(g.el);
      } else {
        lines.push({ y: g.y, h: g.h, x2: g.x2, text: g.text, els: [g.el] });
      }
    }
    return lines;
  }

  // Text painted through <svg><use href="#SvgWml…"> chains (how FB draws "Ad", "Sponsored", timestamps).
  function resolveSvgText(svg) {
    let cur = svg;
    for (let hops = 0; cur && hops < 24; hops++) {
      if (cur.tagName && cur.tagName.toLowerCase() === 'text') return cur.textContent;
      const texts = cur.getElementsByTagName ? cur.getElementsByTagName('text') : null;
      if (texts && texts.length) return Array.from(texts, t => t.textContent).join(' ');
      const use = cur.querySelector ? cur.querySelector('use') : null;
      if (!use) return '';
      const href = use.getAttribute('href') || use.getAttribute('xlink:href') || use.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
      cur = href.charAt(0) === '#' ? D.getElementById(href.slice(1)) : null;
    }
    return '';
  }
  function svgTexts(root, maxTop, vis) {
    const out = [];
    const top = root.getBoundingClientRect().top;
    const svgs = root.querySelectorAll('svg');
    for (let i = 0; i < svgs.length && i < 150; i++) {
      const svg = svgs[i];
      const r = svg.getBoundingClientRect();
      if (r.top > top + maxTop || !r.width || !r.height) continue;
      if (!svg.querySelector('use,text')) continue;
      if (!vis.elementVisible(svg)) continue;
      const t = resolveSvgText(svg);
      if (t && t.trim()) out.push(t);
    }
    return out;
  }
  function ariaTexts(root, maxTop, vis) {
    const out = [];
    const top = root.getBoundingClientRect().top;
    const els = root.querySelectorAll('[aria-label],[aria-labelledby]');
    for (let i = 0; i < els.length && i < 150; i++) {
      const el = els[i];
      const r = el.getBoundingClientRect();
      if (r.top > top + maxTop || !r.width || !r.height) continue;
      let text = el.getAttribute('aria-label') || '';
      const by = el.getAttribute('aria-labelledby');
      if (by) text += ' ' + by.split(/\s+/).map(id => { const t = D.getElementById(id); return t ? t.textContent : ''; }).join(' ');
      if (text.trim() && vis.elementVisible(el)) out.push(text);
    }
    return out;
  }
  function visualVerdict(unit) {
    const vis = makeVis(unit);
    for (const line of visibleLines(unit, CFG.headerHeight, vis)) {
      const c = classifyText(line.text);
      if (c) return { cat: c.cat, label: c.label, via: 'text' };
    }
    for (const t of svgTexts(unit, CFG.headerHeight, vis)) {
      const c = classifyText(t);
      if (c) return { cat: c.cat, label: c.label, via: 'svg' };
    }
    for (const t of ariaTexts(unit, CFG.headerHeight, vis)) {
      const c = classifyText(t);
      if (c && c.cat !== 'SUGGESTED') return { cat: c.cat, label: c.label, via: 'aria' };
    }
    return null;
  }

  /* ------------------------------------------------------------------ hiding */
  const ATTR = 'data-kill-ads';
  const STYLE_ID = 'kill-ads-style';
  function ensureStyle() {
    if (D.getElementById(STYLE_ID)) return;
    const css = `[${ATTR}]{display:none!important}`;
    try {
      const st = D.createElement('style');
      st.id = STYLE_ID;
      const nonceEl = D.querySelector('style[nonce],script[nonce]');
      if (nonceEl && nonceEl.nonce) st.nonce = nonceEl.nonce;
      st.textContent = css;
      (D.head || D.documentElement).appendChild(st);
      if (!st.sheet) throw new Error('style blocked');
    } catch (e) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        D.adoptedStyleSheets = [...D.adoptedStyleSheets, sheet];
      } catch (e2) { /* inline styles still work */ }
    }
  }
  function applyHide(unit, cat) {
    if (unit.getAttribute(ATTR) !== cat) unit.setAttribute(ATTR, cat);
    if (unit.style.display !== 'none') unit.style.setProperty('display', 'none', 'important');
  }
  // Only real posts may be hidden: a rendered <div> strictly inside the page's main region that does
  // not itself contain page landmarks (navigation, dialogs, the sprite/portal layers, ...).
  const LANDMARKS = '[role="main"],[role="navigation"],[role="banner"],[role="dialog"],[role="alertdialog"],' +
    '[role="complementary"],[role="feed"],[role="search"],[role="contentinfo"],nav,header,footer';
  function qualifies(unit, rail) {
    if (!unit || unit.tagName !== 'DIV' || !unit.isConnected) return false;
    const p = unit.parentElement;
    if (!p || p === D.body || p === D.documentElement || p.parentElement === D.body) return false; // portals / app root
    if (unit.classList.contains('__fb-light-mode') || unit.classList.contains('__fb-dark-mode')) return false;
    if (unit.querySelector(LANDMARKS)) return false;
    const main = D.querySelector('[role="main"]');
    if (!rail && main && !main.contains(unit)) return false;
    if (rail && !unit.closest('[role="complementary"]')) return false;
    const cs = W.getComputedStyle(unit);
    if (cs.position === 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (unit.getClientRects().length === 0) return false;                 // already invisible - nothing to do
    const r = unit.getBoundingClientRect();
    if (r.width < 120 || r.height < 24) return false;                     // decoys / empty placeholders
    if (W.innerWidth >= 900 && r.width > W.innerWidth * 0.8) return false; // page-wide layer, not a post
    return true;
  }
  function hide(unit, st, cat, method) {
    if (!qualifies(unit, method === 'right-rail')) { st.status = 'skip'; log('refused to hide (not a post)', method, unit); return; }
    st.status = 'hidden'; st.cat = cat; st.method = method;
    st.prevDisplay = unit.style.getPropertyValue('display');
    st.prevPriority = unit.style.getPropertyPriority('display');
    hiddenUnits.add(unit);
    stats.hidden++;
    const m = method.split(':')[0];
    stats.byMethod[m] = (stats.byMethod[m] || 0) + 1;
    stats.byCategory[cat] = (stats.byCategory[cat] || 0) + 1;
    const text = CFG.verbose ? excerpt(unit) : '';   // read before hiding: hidden units have no innerText
    applyHide(unit, cat);
    if (CFG.verbose) say(`HIDDEN #${stats.hidden} ${cat} via ${method} — "${text}"`, unit);
    else log(`HIDDEN ${cat} via ${method}`, unit);
  }
  function unhideOne(unit, why) {
    const st = state.get(unit);
    unit.removeAttribute(ATTR);
    // restore Facebook's own inline display (if any) instead of blindly removing it
    if (st && st.prevDisplay) unit.style.setProperty('display', st.prevDisplay, st.prevPriority || '');
    else unit.style.removeProperty('display');
    hiddenUnits.delete(unit);
    if (st) { st.status = 'new'; st.tries = 0; st.vtries = 0; }
    if (CFG.verbose) say(`released (${why})`, unit);
  }

  /* ---------------------------------------------------------------- scanning */
  // A feed unit = direct child of the feed container. Modern FB has no role="feed"; each unit wraps a
  // div[data-virtualized] through a chain of single-child divs, so climb that chain to the feed's child.
  function unitOf(el) {
    let u = el;
    while (u.parentElement && u.parentElement !== D.body && u.parentElement.children.length === 1 &&
           !u.parentElement.getAttribute('role')) u = u.parentElement;
    return u;
  }
  function collectUnits() {
    const out = [];
    const seen = new Set();
    const main = D.querySelector('[role="main"]');
    const add = u => {
      if (!u || seen.has(u) || u === D.body || u === D.documentElement) return;
      if (main && !main.contains(u)) return;                                 // only the main region holds posts
      if (u.querySelectorAll('[data-virtualized]').length > 1) return;       // a container, not a unit
      seen.add(u); out.push(u);
    };
    const feeds = D.querySelectorAll('div[role="feed"]');
    for (let i = 0; i < feeds.length; i++) for (const u of feeds[i].children) add(u);
    const virt = D.querySelectorAll('div[data-virtualized]');
    for (let i = 0; i < virt.length; i++) {
      const v = virt[i];
      if (v.closest('div[role="feed"]')) continue;
      const u = unitOf(v);
      if (u.parentElement && u.parentElement.children.length > 1) add(u);
    }
    const arts = D.querySelectorAll('div[aria-posinset], div[role="article"]');
    for (let i = 0; i < arts.length; i++) {
      const a = arts[i];
      if (a.closest('div[role="feed"], [' + ATTR + ']')) continue;
      let inside = false;
      for (const u of out) if (u.contains(a)) { inside = true; break; }
      if (inside) continue;
      if (a.parentElement && a.parentElement.closest('div[role="article"], div[aria-posinset]')) continue;
      add(unitOf(a));
    }
    return out;
  }

  const CFT_RE = /[?&]__cft__(?:\[0\]|%5B0%5D)?=([^&#"'\s]+)/;
  function unitTokens(unit) {
    const out = new Set();
    const as = unit.getElementsByTagName('a');
    for (let i = 0; i < as.length && i < 300; i++) {
      const a = as[i];
      const cached = cftOf.get(a);               // remembered before the link cleaner stripped the token
      if (cached) { out.add(cached); continue; }
      const href = a.getAttribute('href') || '';
      if (href.indexOf('__cft__') < 0) continue;
      const m = CFT_RE.exec(href);
      if (!m) continue;
      const t = decodeTok(m[1]);
      cftOf.set(a, t);
      out.add(t);
    }
    return out;
  }
  const rank = i => (i.sponsored ? 4 : 0) + (i.cat && CFG.hideCategories.includes(i.cat) ? 3 : 0) + (i.ai ? 2 : 0) + (i.decoded ? 1 : 0);
  function dataVerdict(unit) {
    let info = null, maxLen = 0, n = 0;
    for (const t of unitTokens(unit)) {
      n++;
      if (t.length > maxLen) maxLen = t.length;
      const i = byToken.get(t);
      if (i && (!info || rank(i) > rank(info))) info = i;
    }
    return { info, maxLen, n };
  }
  const ADS_LINK = 'a[href*="/ads/about"], a[href*="facebook.com/ads/"], a[href^="/ads/"], a[href*="/ad_center/"], a[href*="/adpreferences/"]';

  function processUnit(unit) {
    let st = state.get(unit);
    if (!st) { st = { status: 'new', tries: 0, vtries: 0, cat: null, method: null }; state.set(unit, st); stats.units++; }
    if (st.status === 'hidden') {
      // safety: if the hidden element turned into a container of many units, release it
      if (unit.querySelectorAll('[data-virtualized]').length > 1) { unhideOne(unit, 'turned into a container of several units'); return; }
      applyHide(unit, st.cat);
      return;
    }
    st.tries++;
    if (st.status === 'known' && st.tries % 8 !== 0) return;

    // 1. Facebook's own data, joined through the __cft__[0] tokens of the unit's links
    const dv = dataVerdict(unit);
    const info = dv.info;
    if (info) {
      if (info.sponsored) return hide(unit, st, 'SPONSORED', 'graphql:sponsored-data');
      if (info.cat && CFG.hideCategories.includes(info.cat)) return hide(unit, st, info.cat, 'graphql:category');
      if (info.ai && CFG.hideAI) return hide(unit, st, 'AI_CONTENT', 'graphql:genai');
    }
    // 2. only ads link to /ads/about
    if (unit.querySelector(ADS_LINK)) return hide(unit, st, 'SPONSORED', 'ads-link');
    // 3. ad tracking tokens are ~2x longer than organic ones (used when the data layer has no verdict)
    if (dv.maxLen >= CFG.cftLength && !(info && info.decoded && info.cat)) return hide(unit, st, 'SPONSORED', 'cft-length:' + dv.maxLen);
    // 4. what the user sees in the header ("Sponsored", "AI info", "Suggested for you", "Follow", "Reels", ...)
    const rendered = dv.n > 0 || unit.querySelector('h2,h3,h4,a[href]');
    if (rendered) st.vtries++;
    if (rendered && (st.vtries <= CFG.visualRetries || st.vtries % 16 === 0)) {
      const v = visualVerdict(unit);
      // Facebook's own data saying ORGANIC (friends / followed pages / own groups) beats the "Suggested" heuristic only
      const organic = info && info.decoded && info.cat === 'ORGANIC';
      if (v && (v.cat !== 'AI_CONTENT' || CFG.hideAI) && !(v.cat === 'SUGGESTED' && organic)) return hide(unit, st, v.cat, 'label-' + v.via + ':' + v.label);
    }
    if (info && info.decoded) { st.status = 'known'; st.cat = info.cat; }
  }

  const railSeen = new WeakSet();
  function railSection(rail, el) {
    const railH = rail.getBoundingClientRect().height || 1;
    let sec = el;
    while (sec.parentElement && sec.parentElement !== rail) {
      const h = sec.getBoundingClientRect().height;
      if (h > 100 && sec.children.length >= 2 && sec.querySelector('a[href]')) break;
      sec = sec.parentElement;
    }
    const h = sec.getBoundingClientRect().height;
    if (sec === rail || h > railH * 0.7 || sec.querySelectorAll('a[href]').length > 12) return null;
    return sec;
  }
  function scanRightRail() {
    const rails = D.querySelectorAll('div[role="complementary"]');
    for (let r = 0; r < rails.length; r++) {
      const rail = rails[r];
      const vis = makeVis(rail);
      const hits = [];
      for (const line of visibleLines(rail, 1e6, vis)) {
        const c = classifyText(line.text);
        if (c && c.cat === 'SPONSORED' && line.els.length) hits.push(line.els[0]);
      }
      const svgs = rail.querySelectorAll('svg');
      for (let i = 0; i < svgs.length && i < 100; i++) {
        const svg = svgs[i];
        if (!svg.querySelector('use,text') || !vis.elementVisible(svg)) continue;
        const c = classifyText(resolveSvgText(svg));
        if (c && c.cat === 'SPONSORED') hits.push(svg);
      }
      const ads = rail.querySelectorAll(ADS_LINK);
      for (let i = 0; i < ads.length; i++) hits.push(ads[i]);
      for (const el of hits) {
        if (railSeen.has(el)) continue;
        railSeen.add(el);
        const sec = railSection(rail, el);
        if (!sec) { log('right-rail: ambiguous container, skipped', el); continue; }
        if (sec.hasAttribute(ATTR)) continue;
        const st = { status: 'hidden', tries: 0, vtries: 0 };
        state.set(sec, st);
        hide(sec, st, 'SPONSORED', 'right-rail');
      }
    }
  }

  /* -------------------------------------------------------------------- loop */
  function tickLine(unitCount) {
    if (!CFG.verbose) return;
    const now = [...hiddenUnits].filter(u => u.isConnected);
    const cats = {};
    for (const u of now) { const s = state.get(u); const c = (s && s.cat) || '?'; cats[c] = (cats[c] || 0) + 1; }
    const byCat = Object.keys(cats).map(c => `${c} ${cats[c]}`).join(', ') || 'none';
    let msg = `tick: ${now.length} hidden on page (${byCat}) · ${unitCount} feed units · ${stats.hidden} hidden since start` +
      ` · ${linksCleaned} links cleaned · ${net.blockedTotal} tracker requests blocked`;
    if (CFG.verbose >= 2) msg += ` · scan #${stats.scans} ${stats.lastScanMs} ms · edges ${stats.edges} · tokens ${byToken.size}`;
    say(msg);
  }
  let running = false, timer = null, observer = null, debounce = null, scanning = false;
  function scan() {
    if (!running || scanning) return;
    scanning = true;
    const t0 = performance.now();
    let unitCount = 0;
    try {
      stats.scans++;
      ingestScripts();
      ensureStyle();
      try { cleanLinks(stats.scans % 40 === 1); } catch (e) { log('link error', e); }
      const units = collectUnits();
      unitCount = units.length;
      for (const u of units) {
        try { processUnit(u); } catch (e) { log('unit error', e, u); }
      }
      if (CFG.hideRightRail && stats.scans % 4 === 1) { try { scanRightRail(); } catch (e) { log('rail error', e); } }
    } finally {
      scanning = false;
      stats.lastScanMs = Math.round((performance.now() - t0) * 10) / 10;
    }
    try { tickLine(unitCount); } catch (e) { /* ignore */ }
  }
  function schedule() {
    if (!running || debounce) return;
    debounce = setTimeout(() => { debounce = null; scan(); }, 50);
  }
  // MutationObserver callbacks run before the browser paints: units whose data is already
  // known are hidden here, so an ad never gets a single frame on screen. Links are cleaned here too,
  // which also undoes Facebook's click-time href swap (it happens in a click handler, the observer
  // runs right after it, before the browser follows the link).
  function onMutations(records) {
    if (!running) return;
    let budget = 40;
    const done = new Set();
    for (const r of records) {
      if (r.type === 'attributes') {
        const t = r.target;
        try {
          if (r.attributeName === 'href') { if (t.tagName === 'A') cleanAnchor(t); }
          else t.removeAttribute(r.attributeName);          // ping / attributionsrc
        } catch (e) { /* ignore */ }
        continue;
      }
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        try { cleanAnchorsIn(node); } catch (e) { /* ignore */ }
        if (budget-- <= 0) continue;
        const v = node.closest ? node.closest('div[data-virtualized]') || node.querySelector('div[data-virtualized]') : null;
        if (!v) continue;
        const u = unitOf(v);
        if (done.has(u) || !u.parentElement || u.parentElement.children.length < 2) continue;
        done.add(u);
        if (u.querySelectorAll('[data-virtualized]').length > 1) continue;
        const st = state.get(u);
        if (st && st.status === 'known') continue;
        try { ensureStyle(); processUnit(u); } catch (e) { log('mutation error', e); }
      }
    }
    schedule();
  }
  function start() {
    if (running) return;
    running = true;
    refreshLabels();
    hookXHR(); hookFetch(); hookBeacon(); hookOpen(); observeResources();
    observer = new MutationObserver(onMutations);
    observer.observe(D.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'ping', 'attributionsrc'] });
    W.addEventListener('click', onClickCapture, true);
    W.addEventListener('auxclick', onClickCapture, true);
    timer = setInterval(scan, CFG.tick);
    scan();
    say('running — hiding ads, "Suggested for you", Reels & AI content, cleaning tracking links and answering tracker beacons ' +
        'locally. One line per tick below (repeats collapse); __killAds.cfg.verbose = 0 silences it, = 2 adds scan#/ms.  ' +
        'API: __killAds.stats() .hidden() .net() .stop() .start() .unhide() .inspect($0) .cleanUrl(url)');
  }
  function stop() {
    running = false;
    if (observer) observer.disconnect();
    W.removeEventListener('click', onClickCapture, true);
    W.removeEventListener('auxclick', onClickCapture, true);
    clearInterval(timer);
    clearTimeout(debounce); debounce = null;
  }
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n || 40).map(([k, v]) => `${String(v).padStart(5)}  ${k}`);

  const api = W.__killAds = {
    cfg: CFG,
    stats: () => ({ ...stats, hiddenNow: [...hiddenUnits].filter(u => u.isConnected).length, tokensKnown: byToken.size,
      linksCleaned, requestsSeen: net.total, requestsBlocked: net.blockedTotal }),
    hidden: () => [...hiddenUnits].filter(u => u.isConnected).map(u => ({ el: u, ...state.get(u) })),
    // what this tab talks to: blocked tracker endpoints, GraphQL operation names, other request endpoints
    net(n) {
      const out = { blocked: top(net.blocked, n), graphql: top(net.gql, n), endpoints: top(net.seen, n), total: net.total, blockedTotal: net.blockedTotal };
      console.log(TAG + ' blocked tracker requests:\n' + (out.blocked.join('\n') || '  (none)') +
        '\n\n' + TAG + ' GraphQL operations seen (blocked ones match cfg.blockGraphql):\n' + out.graphql.join('\n') +
        '\n\n' + TAG + ' other endpoints:\n' + out.endpoints.join("\n"), TAG_CSS, RESET_CSS, TAG_CSS, RESET_CSS, TAG_CSS, RESET_CSS);
      return out;
    },
    cleanUrl: url => { const c = cleanUrl(String(url)); return c ? c.href : String(url); },
    inspect(el) {
      const unit = collectUnits().find(u => u.contains(el)) || unitOf(el);
      const dv = dataVerdict(unit);
      const vis = makeVis(unit);
      return {
        unit, state: state.get(unit), qualifies: qualifies(unit, false),
        tokens: [...unitTokens(unit)].map(t => ({ len: t.length, known: byToken.has(t), info: byToken.get(t) })),
        data: dv.info, adsLink: !!unit.querySelector(ADS_LINK),
        headerLines: visibleLines(unit, CFG.headerHeight, vis).map(l => l.text),
        svgTexts: svgTexts(unit, CFG.headerHeight, vis), visual: visualVerdict(unit),
      };
    },
    units: collectUnits,
    rescan: () => { for (const u of collectUnits()) { const s = state.get(u); if (s && s.status !== 'hidden') { s.tries = 0; s.vtries = 0; s.status = 'new'; } } return scan(); },
    unhide: () => { for (const u of [...hiddenUnits]) unhideOne(u, '__killAds.unhide() called'); },
    start, stop,
    _ingest: ingestText, _stats: stats, _data: { byToken, byPost, groups }, _net: netDecision, _cleanUrl: cleanUrl, _say: say,
    version: '2.3.0',
  };
  start();
})();
