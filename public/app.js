/* ==========================================================================
   Imagine studio — client
   Vanilla JS, no framework, no build step.

   The page is a gallery with one composer docked at the bottom. Everything a
   person types or attaches lives in that composer: the prompt, the photos (as
   chips, in sending order), and the settings (as pills). There are no modes to
   pick — with no photos attached it generates; attach one and it edits.

   Prices are never hardcoded here. They arrive from /api/config and every
   estimate is recomputed from that object. If a model has no price entry the UI
   says the cost is unknown rather than showing a wrong one.
   ========================================================================== */
'use strict';

(function () {

  // -------------------------------------------------------------------------
  // Constants that are UI copy, not money and not API behaviour
  // -------------------------------------------------------------------------
  var SHAPES = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '21:9'];
  var RESOLUTIONS = ['1k', '2k'];

  // Limits of the edits endpoint. Overwritten from /api/config at boot so the
  // server stays the single source of truth.
  var MAX_EDIT_SOURCES = 5;
  var MAX_EDIT_VARIANTS = 4;
  var MAX_FRAMES = 10;
  // The most photos in the composer at once: ten edits in one run.
  var MAX_SOURCES = 10;

  // A reference crop is upscaled so its short side is at least this, with
  // smoothing off — the treatment that transferred a likeness best. Upscale only.
  var CROP_TARGET_SHORT = 1536;

  var MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  var ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  var STORE_KEY = 'imagine-studio/settings';
  var SPEND_KEY = 'imagine-studio/spend';
  var PASS_KEY = 'imagine-studio/password';
  var THEME_KEY = 'imagine-studio/theme';
  var ACCENT_KEY = 'imagine-studio/accent';
  var NOTIFY_KEY = 'imagine-studio/notify';
  var NEWS_KEY = 'imagine-studio/news-seen';
  var studioName = 'Imagine studio';

  var ICONS = {
    download: '<path d="M8 2.5v8M4.8 7.6L8 10.8l3.2-3.2M3 13.5h10"/>',
    reference: '<path d="M8.5 2.5h-4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-4M2.5 10.5l3-3 3 3 2-2 3 3M12 1.5v5M9.5 4h5"/>',
    again: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 1h3.8a1 1 0 0 0 1-1l.6-8"/>',
    star: '<path d="M8 1.8l1.9 3.85 4.25.62-3.08 3 .73 4.23L8 11.5l-3.8 2 .73-4.23-3.08-3 4.25-.62z"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    crop: '<path d="M4.5 1.5v10h10M1.5 4.5h10v10"/>',
    copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>',
    user: '<path d="M8 8a2.75 2.75 0 1 0 0-5.5A2.75 2.75 0 0 0 8 8ZM2.8 13.5c.6-2.3 2.7-3.5 5.2-3.5s4.6 1.2 5.2 3.5"/>'
  };

  // -------------------------------------------------------------------------
  // Element handles
  // -------------------------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };

  var gate = $('gate'), gateForm = $('gate-form'), gatePassword = $('gate-password'),
      gateError = $('gate-error'), gateSubmit = $('gate-submit'),
      gateToggle = $('gate-password-toggle');
  var app = $('app');
  var filtersEl = $('filters');
  var thumbEl = $('thumb');
  var spendAmount = $('spend-amount'), spendRuns = $('spend-runs'), balanceEl = $('balance');
  var newsDialog = $('news-dialog'), newsBody = $('news-body'), newsTitle = $('news-title'), newsDate = $('news-date'),
      newsOk = $('news-ok'), newsClose = $('news-close'), newsOpen = $('news-open');
  var accentEl = $('accent'), notifyEl = $('notify'), keysDialog = $('keys-dialog'),
      keysOpen = $('keys-open'), keysClose = $('keys-close');
  var whoBtn = $('who-btn'), whoPop = $('who-pop'), userName = $('user-name'), themeEl = $('theme');
  var results = $('results'), empty = $('empty'), emptyTitle = $('empty-title'),
      emptyBody = $('empty-body'), emptySeeds = $('empty-seeds');
  var dock = $('dock'), runError = $('run-error'), retirementEl = $('retirement'),
      chipPanel = $('chip-panel'), mentionMenu = $('mention-menu'), dropveil = $('dropveil');
  var rail = $('rail'), sourceList = $('source-list'), addBtn = $('dropzone'), fileInput = $('file-input');
  var planSwitch = $('plan'), planReference = $('plan-reference'), planEach = $('plan-each');
  var promptEl = $('prompt'), promptLabel = $('prompt-label'), hintEl = $('composer-hint');
  var modelPill = $('model-pill'), modelText = $('model-text');
  var shapePill = $('shape-pill'), shapeText = $('shape-text'), shapeIcon = $('shape-icon');
  var sizePill = $('size-pill'), sizeText = $('size-text');
  var qualityField = $('quality-field'), qualityText = $('quality-text');
  var pillMenu = $('pill-menu'), promptBack = $('prompt-back'), summaryEl = $('composer-summary'),
      historyMenu = $('history-menu');
  var PROMPTS_KEY = 'imagine-studio/prompts';
  var framesField = $('frames-field'), framesLabel = $('frames-label'), framesValue = $('frames-value'),
      framesMinus = $('frames-minus'), framesPlus = $('frames-plus');
  var costValue = $('cost-value'), cancelBtn = $('cancel-run'), actionBtn = $('action');
  var lightbox = $('lightbox'), lbCount = $('lb-count'), lbMeta = $('lb-meta'),
      lbImage = $('lb-image'), lbPrompt = $('lb-prompt'),
      lbDownload = $('lb-download'), lbEdit = $('lb-edit'), lbReuse = $('lb-reuse'),
      lbAgain = $('lb-again'), lbClose = $('lb-close'), lbPrev = $('lb-prev'), lbNext = $('lb-next'),
      lbSources = $('lb-sources'), lbSourcesBlock = $('lb-sources-block'), lbSourcesLabel = $('lb-sources-label'),
      lbDownloadAll = $('lb-download-all'), lbFav = $('lb-fav'), lbDelete = $('lb-delete');
  var lbStage = $('lb-stage'), lbCanvas = $('lb-canvas'), lbCompare = $('lb-compare'), lbBase = $('lb-base'),
      lbDivider = $('lb-divider'), lbTagBefore = $('lb-tag-before'), lbTagAfter = $('lb-tag-after'),
      lbZoomIn = $('lb-zoom-in'), lbZoomOut = $('lb-zoom-out'), lbZoomReset = $('lb-zoom-reset'),
      lbCompareBtn = $('lb-compare-btn'), lbCompareRule = $('lb-compare-rule'), lbWide = $('lb-wide'),
      lbStrip = $('lb-strip'), lbSheet = $('lb-sheet'), lbSide = document.querySelector('.lightbox__side'),
      lbCopy = $('lb-copy'), lbCopyImage = $('lb-copy-image'), toastsEl = $('toasts');
  var consentDialog = $('consent-dialog'), consentOk = $('consent-ok'), consentCancel = $('consent-cancel');

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  var config = null;
  var password = '';
  var state = {
    model: '',
    quality: 'auto',
    // Generating and editing each keep their own shape, size and count, so
    // attaching a photo never silently re-crops or re-prices the other.
    shape: '9:16',
    resolution: '1k',
    frames: 1,
    editShape: 'auto',
    editResolution: '1k',
    variants: 1,
    // With two or more photos: 'reference' combines them into one image, the
    // first being the base; 'each' applies the instruction to every photo.
    plan: 'reference',
    name: '',
    filter: 'all',
    thumb: 3,          // picture size, 1 (dense) to 5 (large)
    // [{ dataUri, original, originalSize, name, size, width, height, crop }] in
    // the order they will be sent. dataUri is what goes out — the crop, if any.
    sources: []
  };
  // Confirmed once per session before the first combined edit, and sent with
  // every such request so the server can refuse one that lacks it.
  var likenessConsent = false;

  var runs = [];
  var selected = new Set();
  var busy = false;
  var rateLimitUntil = 0;
  var rateLimitTimer = null;
  var runTimer = null;
  var lightboxState = null;
  var activeRun = null;
  var retiredFallback = null;
  var lastFocused = null;
  var seq = 0;
  var attention = '';      // why the last press of the button did nothing
  var openChip = -1;       // index of the photo whose panel is open, or -1
  var chipView = 'menu';   // 'menu' or 'crop'
  var dragFrom = -1;       // index of the chip being dragged, or -1
  var mention = null;      // { start, items, index } while the @ menu is open

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------
  function money(n) { return '$' + Number(n).toFixed(2); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function icon(name, size) {
    var s = size || 15;
    var holder = document.createElement('span');
    holder.innerHTML = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
    return holder.firstChild;
  }

  function clockTime(date) {
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }

  function duration(ms) {
    var total = Math.max(0, Math.round(ms / 1000));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  function bytes(n) {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  // xAI does not return one format: 1k comes back as JPEG, 2k as PNG, and that
  // is not something the request states. Read it off the bytes rather than
  // assuming, or downloads get the wrong extension.
  function sniffImage(b64) {
    var head = '';
    try { head = atob(b64.slice(0, 16)); } catch (err) { head = ''; }
    if (head.charCodeAt(0) === 0x89 && head.slice(1, 4) === 'PNG') return { mime: 'image/png', ext: 'png' };
    if (head.charCodeAt(0) === 0xFF && head.charCodeAt(1) === 0xD8) return { mime: 'image/jpeg', ext: 'jpg' };
    if (head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
    return { mime: 'image/png', ext: 'png' };
  }

  function wordCount(text) {
    var t = String(text || '').trim();
    return t ? t.split(/\s+/).length : 0;
  }

  function readStore(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) { return null; }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (err) { /* private window, or storage full — the app still works, it just forgets */ }
  }

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  function sameName(a, b) {
    return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  }

  // -------------------------------------------------------------------------
  // Shape and size. Sizes are shown as pixels, never as an API enum.
  //
  // These are xAI's real output sizes, measured one image per combination on
  // 4 September 2026. They are not derivable from a formula. If xAI changes
  // what it returns, re-measure — do not try to compute these.
  // -------------------------------------------------------------------------
  var SIZE_TABLE = {
    '1:1':  { '1k': [1024, 1024], '2k': [2048, 2048] },
    '16:9': { '1k': [1280,  720], '2k': [2816, 1584] },
    '9:16': { '1k': [ 720, 1280], '2k': [1584, 2816] },
    '4:3':  { '1k': [1152,  864], '2k': [2368, 1776] },
    '3:4':  { '1k': [ 864, 1152], '2k': [1776, 2368] },
    '3:2':  { '1k': [1248,  832], '2k': [2496, 1664] },
    '2:3':  { '1k': [ 832, 1248], '2k': [1664, 2496] },
    '2:1':  { '1k': [1408,  704], '2k': [2912, 1456] },
    '21:9': { '1k': [1568,  672], '2k': [3136, 1344] }
  };

  function sizeLabel(shape, res) {
    var row = SIZE_TABLE[shape];
    if (row && row[res]) return row[res][0] + '×' + row[res][1];
    // On "auto" the model picks the shape, so the pixels depend on what it
    // chooses. Quote the budget it works to instead of inventing a pair.
    return res === '2k' ? 'about 4 MP' : 'about 1 MP';
  }

  // Null for "auto": the model chooses the frame.
  function aspectRatioCss(shape) {
    if (!shape || shape === 'auto') return null;
    var parts = String(shape).split(':');
    return (Number(parts[0]) || 1) + ' / ' + (Number(parts[1]) || 1);
  }

  // -------------------------------------------------------------------------
  // What the composer is about to do
  // -------------------------------------------------------------------------
  function mode() { return state.sources.length ? 'edit' : 'generate'; }
  function currentShape() { return mode() === 'edit' ? state.editShape : state.shape; }
  function currentResolution() { return mode() === 'edit' ? state.editResolution : state.resolution; }
  function currentCount() { return mode() === 'edit' ? state.variants : state.frames; }
  function maxCount() { return mode() === 'edit' ? MAX_EDIT_VARIANTS : MAX_FRAMES; }
  function isReference() { return state.sources.length > 1 && state.plan === 'reference'; }
  function isEditEach() { return state.sources.length > 1 && state.plan === 'each'; }

  // -------------------------------------------------------------------------
  // Cost. Mirrors the server, from the same price object.
  // -------------------------------------------------------------------------
  function priceEntry(model) { return config && config.prices ? config.prices[model] : null; }

  function acceptsQuality(model) {
    return Boolean(config && config.qualityModels && config.qualityModels.indexOf(model) !== -1);
  }

  function tierFor(model, quality, m) {
    var p = priceEntry(model);
    if (!p || !p.tiers) return null;
    if (p.tiers['default']) return p.tiers['default'];
    if (!p.autoQuality) return null;
    var q = (!quality || quality === 'auto') ? p.autoQuality[m === 'edit' ? 'edit' : 'generate'] : quality;
    return p.tiers[q] || null;
  }

  // Per-image output price. Returns null when we genuinely do not know.
  function perImage(model, quality, resolution, m) {
    var tier = tierFor(model, quality, m);
    if (!tier) return null;
    var v = tier[resolution];
    return typeof v === 'number' ? v : null;
  }

  function estimate() {
    var m = mode();
    var per = perImage(state.model, state.quality, currentResolution(), m);
    if (per == null) return null;
    var p = priceEntry(state.model);
    var input = p && typeof p.input === 'number' ? p.input : 0;
    if (m !== 'edit') return { total: per * state.frames, per: per, count: state.frames };
    var sources = Math.max(1, state.sources.length);
    // One request per photo, each paying its own input charge.
    if (isEditEach()) return { total: (per + input) * sources, per: per + input, count: sources };
    // One request per variant, and every request re-sends every source image.
    var perRequest = per + input * sources;
    return { total: perRequest * state.variants, per: perRequest, count: state.variants };
  }

  // -------------------------------------------------------------------------
  // Spend — this browser's runs today, reset at local midnight.
  // -------------------------------------------------------------------------
  function todayStamp() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function loadSpend() {
    var s = readStore(SPEND_KEY);
    if (!s || s.date !== todayStamp()) return { date: todayStamp(), amount: 0, runs: 0 };
    return s;
  }

  var spend = loadSpend();

  function renderSpend() {
    spend = spend.date === todayStamp() ? spend : { date: todayStamp(), amount: 0, runs: 0 };
    spendAmount.textContent = money(spend.amount);
    spendRuns.hidden = !(spend.runs > 0);
    if (spend.runs > 0) spendRuns.textContent = '· ' + spend.runs + (spend.runs === 1 ? ' run' : ' runs');
  }

  // What is left of the prepaid credit, read by the server from xAI's
  // Management API. Shown only when the server has the key for it; when it has
  // not, or xAI is not answering, the element stays hidden and nothing is
  // implied about the balance.
  var LOW_BALANCE = 5;
  async function refreshBalance() {
    if (!config || app.hidden) return;
    try {
      var res = await fetch('/api/balance', { headers: authHeaders({}) });
      if (!res.ok) { balanceEl.hidden = true; return; }
      var b = await res.json();
      if (!b || !b.available) { balanceEl.hidden = true; return; }
      balanceEl.hidden = false;
      balanceEl.innerHTML = '';
      balanceEl.appendChild(document.createTextNode('· '));
      // A tilde when this billing cycle's spend could not be read: the true
      // figure may be lower.
      balanceEl.appendChild(el('b', null, (b.exact ? '' : '≈') + money(b.remaining)));
      balanceEl.appendChild(document.createTextNode(' left'));
      balanceEl.classList.toggle('is-low', b.remaining < LOW_BALANCE);
      balanceEl.title = 'Prepaid credit left on the xAI account' +
        (b.cycleSpend != null ? ' — ' + money(b.ledger) + ' on the ledger, less ' + money(b.cycleSpend) + ' used this billing cycle.' : '.') +
        (b.exact ? '' : ' This cycle’s spend could not be read, so the real figure may be lower.') +
        ' Refreshed about once a minute.';
    } catch (err) {
      balanceEl.hidden = true;
    }
  }

  // Spend increments only when an image arrives, never on a failure.
  function addSpend(amount, isNewRun) {
    if (typeof amount !== 'number' || !isFinite(amount)) return;
    spend.amount = Math.round((spend.amount + amount) * 1e6) / 1e6;
    if (isNewRun) spend.runs += 1;
    writeStore(SPEND_KEY, spend);
    renderSpend();
  }

  // -------------------------------------------------------------------------
  // Retirement. Computed from the local date against the model's retirement
  // instant and re-read on load and on window focus — never hardcoded.
  // -------------------------------------------------------------------------
  function retirementFor(model) {
    var p = priceEntry(model);
    if (!p || !p.retiresAt) return null;
    var at = Date.parse(p.retiresAt);
    if (isNaN(at)) return null;
    var msLeft = at - Date.now();
    var successor = null;
    var prices = config.prices;
    for (var id in prices) {
      if (id !== model && !prices[id].retiresAt) { successor = prices[id]; break; }
    }
    return {
      msLeft: msLeft,
      retired: msLeft <= 0,
      hours: Math.max(0, Math.ceil(msLeft / 3600000)),
      days: Math.max(0, Math.ceil(msLeft / 86400000)),
      dateLabel: new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
      label: p.label,
      successor: successor ? successor.label : 'another model'
    };
  }

  function modelIsRetired(model) {
    var r = retirementFor(model);
    return Boolean(r && r.retired);
  }

  function renderRetirement() {
    retirementEl.innerHTML = '';
    // The retired model cannot be selected, so its notice is shown against
    // whatever replaced it until the user picks a model themselves.
    var r = retirementFor(state.model) || (retiredFallback ? retirementFor(retiredFallback) : null);
    if (!r) { retirementEl.hidden = true; return; }
    retirementEl.hidden = false;
    var box = el('div', 'notice ' + (r.retired ? 'notice--danger' : 'notice--warning'));
    var title, body;
    if (r.retired) {
      title = r.label + ' retired on ' + r.dateLabel;
      body = 'It no longer accepts requests, so ' + r.successor + ' is selected. Existing images stay downloadable.';
    } else if (r.msLeft <= 48 * 3600000) {
      title = r.label + ' retires in ' + r.hours + (r.hours === 1 ? ' hour' : ' hours');
      body = 'It stops working at midnight UTC. Anything queued after that fails. Switch to ' + r.successor + '.';
    } else {
      title = r.label + ' retires in ' + r.days + ' days';
      body = 'It stops working on ' + r.dateLabel + '. Switch to ' + r.successor +
        ' for new work — different look, so re-check anything you have already approved.';
    }
    box.appendChild(el('div', 'notice__title num', title));
    box.appendChild(el('div', 'notice__body', body));
    retirementEl.appendChild(box);
  }

  // -------------------------------------------------------------------------
  // The pills. Each is a real <select> lying invisibly over a label that shows
  // the current value, so the options can carry detail (prices, pixel sizes)
  // while the pill itself stays short.
  // -------------------------------------------------------------------------
  // Which model is in use. A retired one cannot be, so the default takes over
  // — and that is remembered, so the notice can explain why.
  function buildModelOptions() {
    var prices = config.prices || {};
    var ids = Object.keys(prices);
    var live = ids.filter(function (id) { return !modelIsRetired(id); });
    if (!prices[state.model] || modelIsRetired(state.model)) {
      if (prices[state.model] && modelIsRetired(state.model)) retiredFallback = state.model;
      state.model = live.filter(function (id) { return prices[id].isDefault; })[0] || live[0] || ids[0];
    }
  }

  function ratioBox(node, shape) {
    var parts = shape === 'auto' ? [1, 1] : shape.split(':').map(Number);
    var long = 14;
    node.style.width = (parts[0] >= parts[1] ? long : Math.max(5, Math.round(long * parts[0] / parts[1]))) + 'px';
    node.style.height = (parts[1] >= parts[0] ? long : Math.max(5, Math.round(long * parts[1] / parts[0]))) + 'px';
    node.style.borderStyle = shape === 'auto' ? 'dashed' : 'solid';
  }

  function qualityTiers() {
    var p = priceEntry(state.model);
    return p && p.tiers && !p.tiers['default'] && acceptsQuality(state.model) ? Object.keys(p.tiers) : null;
  }

  function renderPills() {
    var m = mode();
    var p = priceEntry(state.model);
    modelText.textContent = p ? p.label : state.model;

    // On an edit, auto means the shape of the first photo — say so, because
    // that is the one case where "auto" is a specific answer.
    var shape = currentShape();
    shapeText.textContent = shape === 'auto' ? (m === 'edit' ? 'As base' : 'Auto') : shape;
    ratioBox(shapeIcon, shape);

    var res = currentResolution();
    sizeText.textContent = res.toUpperCase();
    // 1k was the weakest transfer of the resolutions tried.
    sizePill.classList.toggle('is-warning', isReference() && res === '1k');

    // Quality — only for models that accept it; sending it to any other is a 400.
    var tiers = qualityTiers();
    qualityField.hidden = !tiers;
    if (tiers) {
      if (['auto'].concat(tiers).indexOf(state.quality) === -1) state.quality = 'auto';
      qualityText.textContent = state.quality.charAt(0).toUpperCase() + state.quality.slice(1) + ' quality';
    }
    [modelPill, shapePill, sizePill, qualityField].forEach(function (b) { b.disabled = busy; });

    // Frames on a generation, variants on an edit. Absent when several photos
    // are edited apart — that is one image per photo.
    framesField.hidden = isEditEach();
    var count = currentCount();
    var word = m === 'edit' ? 'variant' : 'frame';
    framesLabel.textContent = m === 'edit' ? 'Variants' : 'Frames';
    framesValue.textContent = count + ' ' + word + (count === 1 ? '' : 's');
    framesMinus.disabled = busy || count <= 1;
    framesPlus.disabled = busy || count >= maxCount();
    framesMinus.setAttribute('aria-label', 'Fewer ' + word + 's');
    framesPlus.setAttribute('aria-label', 'More ' + word + 's');

    summaryEl.textContent = (p ? p.label : state.model) + ' · ' + (shape === 'auto' ? 'Auto' : shape) + ' · ' + res.toUpperCase();
  }

  // -------------------------------------------------------------------------
  // The menu a pill opens. Every row says what it costs, so the choice is made
  // with the price in view rather than discovered afterwards.
  // -------------------------------------------------------------------------
  var openMenu = null;   // the pill whose menu is open, or null

  function menuRow(opt) {
    var row = el('button', 'pillmenu__row');
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(Boolean(opt.current)));
    row.disabled = Boolean(opt.disabled);
    var main = el('span', 'pillmenu__main');
    main.appendChild(el('span', 'pillmenu__label', opt.label));
    if (opt.note) main.appendChild(el('span', 'pillmenu__note' + (opt.warn ? ' is-warning' : ''), opt.note));
    row.appendChild(main);
    if (opt.price) row.appendChild(el('span', 'pillmenu__price num', opt.price));
    row.addEventListener('click', function () { opt.pick(); });
    return row;
  }

  function buildMenu(kind) {
    var m = mode(), res = currentResolution();
    var per = function (model, q, r) { var v = perImage(model, q, r, m); return v == null ? '' : money(v); };
    pillMenu.innerHTML = '';

    if (kind === 'model') {
      pillMenu.appendChild(el('div', 'pillmenu__title', 'Model'));
      var prices = config.prices || {};
      var ids = Object.keys(prices);
      ids.filter(function (id) { return !modelIsRetired(id); }).concat(ids.filter(modelIsRetired)).forEach(function (id) {
        var p = prices[id], r = retirementFor(id);
        var note = r && r.retired ? 'Retired on ' + r.dateLabel
          : r ? 'Retires in ' + r.days + ' days, on ' + r.dateLabel
          : p.isDefault ? 'The default — the model xAI is keeping, and the only one that combines photos'
          : '';
        var from = per(id, 'auto', res);
        pillMenu.appendChild(menuRow({
          label: p.label, note: note, warn: Boolean(r), price: from ? from + ' an image' : '',
          current: id === state.model, disabled: Boolean(r && r.retired),
          pick: function () { retiredFallback = null; state.model = id; buildModelOptions(); closeMenu(true); renderRail(); }
        }));
      });
    }

    if (kind === 'shape') {
      pillMenu.appendChild(el('div', 'pillmenu__title', m === 'edit' ? 'Shape of the result' : 'Shape'));
      var grid = el('div', 'pillmenu__grid');
      SHAPES.forEach(function (s) {
        var tile = el('button', 'pillmenu__tile');
        tile.type = 'button';
        tile.setAttribute('role', 'option');
        tile.setAttribute('aria-selected', String(s === currentShape()));
        var box = el('span', 'ratio');
        ratioBox(box, s);
        // Drawn larger here than in the pill.
        box.style.width = (parseFloat(box.style.width) * 1.6) + 'px';
        box.style.height = (parseFloat(box.style.height) * 1.6) + 'px';
        tile.appendChild(box);
        var text = s === 'auto' ? (m === 'edit' ? 'As base' : 'Auto') : s;
        tile.appendChild(el('span', 'num', text));
        tile.title = s === 'auto' ? (m === 'edit' ? 'The same shape as the base photo' : 'The model chooses') : sizeLabel(s, res) + ' at ' + res.toUpperCase();
        tile.addEventListener('click', function () {
          if (m === 'edit') state.editShape = s; else state.shape = s;
          closeMenu(true); renderRail();
        });
        grid.appendChild(tile);
      });
      pillMenu.appendChild(grid);
    }

    if (kind === 'size') {
      pillMenu.appendChild(el('div', 'pillmenu__title', 'Size'));
      RESOLUTIONS.forEach(function (r) {
        var weak = r === '1k' && isReference();
        pillMenu.appendChild(menuRow({
          label: r.toUpperCase() + ' · ' + sizeLabel(currentShape(), r),
          note: weak ? 'Kept the least of a likeness in testing' : r === '2k' ? 'Sharper, and holds a face better' : 'Quicker and cheaper — good for exploring',
          warn: weak, price: per(state.model, state.quality, r) ? per(state.model, state.quality, r) + ' an image' : '',
          current: r === res,
          pick: function () { if (m === 'edit') state.editResolution = r; else state.resolution = r; closeMenu(true); renderRail(); }
        }));
      });
    }

    if (kind === 'quality') {
      pillMenu.appendChild(el('div', 'pillmenu__title', 'Quality'));
      var p2 = priceEntry(state.model);
      ['auto'].concat(qualityTiers() || []).forEach(function (q) {
        var auto = q === 'auto' && p2 && p2.autoQuality ? p2.autoQuality[m === 'edit' ? 'edit' : 'generate'] : null;
        pillMenu.appendChild(menuRow({
          label: q.charAt(0).toUpperCase() + q.slice(1),
          note: auto ? 'xAI decides — bills as ' + auto + ' for ' + (m === 'edit' ? 'an edit' : 'a generation') : q === 'low' ? 'Faster; fine for drafts' : 'Slower; more detail',
          price: per(state.model, q, res) ? per(state.model, q, res) + ' an image' : '',
          current: q === state.quality,
          pick: function () { state.quality = q; closeMenu(true); renderRail(); }
        }));
      });
    }
  }

  function showMenu(pill) {
    if (busy) return;
    closeMention(); closeHistory();
    if (openChip >= 0) { openChip = -1; renderChipPanel(); renderSource(); }
    openMenu = pill;
    buildMenu(pill.dataset.menu);
    pillMenu.hidden = false;
    pill.setAttribute('aria-expanded', 'true');
    // Just above the pill, kept inside the composer.
    var host = rail.getBoundingClientRect(), at = pill.getBoundingClientRect();
    pillMenu.style.left = Math.max(8, Math.min(at.left - host.left, host.width - pillMenu.offsetWidth - 8)) + 'px';
    pillMenu.style.bottom = (host.bottom - at.top + 8) + 'px';
    var cur = pillMenu.querySelector('[aria-selected="true"]:not(:disabled)') || pillMenu.querySelector('button:not(:disabled)');
    if (cur) cur.focus();
  }

  function closeMenu(refocus) {
    if (!openMenu) return;
    var pill = openMenu;
    openMenu = null;
    pillMenu.hidden = true;
    pill.setAttribute('aria-expanded', 'false');
    if (refocus) pill.focus();
  }

  [modelPill, shapePill, sizePill, qualityField].forEach(function (pill) {
    pill.addEventListener('click', function () { if (openMenu === pill) closeMenu(true); else { closeMenu(false); showMenu(pill); } });
  });
  pillMenu.addEventListener('keydown', function (e) {
    var items = Array.prototype.slice.call(pillMenu.querySelectorAll('button:not(:disabled)'));
    var at = items.indexOf(document.activeElement);
    var grid = Boolean(pillMenu.querySelector('.pillmenu__grid'));
    var step = { ArrowDown: grid ? 5 : 1, ArrowUp: grid ? -5 : -1, ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (step) {
      e.preventDefault();
      e.stopPropagation();
      var next = items[Math.max(0, Math.min(items.length - 1, at + step))];
      if (next) next.focus();
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(false);
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  });
  document.addEventListener('mousedown', function (e) {
    if (openMenu && !pillMenu.contains(e.target) && !openMenu.contains(e.target)) closeMenu(false);
  });

  // -------------------------------------------------------------------------
  // Photo chips
  // -------------------------------------------------------------------------
  function dimsText(src) {
    if (src.crop) return 'cropped to ' + src.crop.w + '×' + src.crop.h + ', sent at ' + src.crop.outW + '×' + src.crop.outH;
    return (src.width ? src.width + '×' + src.height + ' · ' : '') + bytes(src.size);
  }

  function chipLabel(i) {
    if (isReference()) return i === 0 ? 'Base' : String(i + 1);
    return state.sources.length > 1 ? String(i + 1) : '';
  }

  function closeChipPanel(refocus) {
    var was = openChip;
    openChip = -1;
    chipView = 'menu';
    renderChipPanel();
    renderSource();
    if (refocus && was >= 0) {
      var btn = sourceList.querySelectorAll('.chip__thumb')[Math.min(was, state.sources.length - 1)];
      (btn || addBtn).focus();
    }
  }

  function moveSource(from, to) {
    if (to < 0 || to >= state.sources.length || from === to) return;
    // Where every chip is now, so each can be slid from there to its new place.
    var was = new Map();
    Array.prototype.slice.call(sourceList.querySelectorAll('.chip')).forEach(function (n, i) {
      was.set(state.sources[i], n.getBoundingClientRect());
    });
    var item = state.sources.splice(from, 1)[0];
    state.sources.splice(to, 0, item);
    if (openChip === from) openChip = to;
    else if (openChip !== -1) openChip = -1;
    // Only the base may stay uncropped-by-rule; a crop made on a reference is
    // still a valid crop if it becomes the base, so it is left alone.
    renderRail();
    Array.prototype.slice.call(sourceList.querySelectorAll('.chip')).forEach(function (n, i) {
      var old = was.get(state.sources[i]);
      if (!old || !n.animate) return;
      var now = n.getBoundingClientRect();
      var dx = old.left - now.left, dy = old.top - now.top;
      if (dx || dy) n.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], { duration: 220, easing: 'ease-out' });
    });
  }

  function removeSource(i) {
    state.sources.splice(i, 1);
    openChip = -1;
    chipView = 'menu';
    clearError();
    renderRail();
    var next = sourceList.querySelectorAll('.chip__thumb')[Math.min(i, state.sources.length - 1)];
    (next || addBtn).focus();
  }

  function renderSource() {
    sourceList.innerHTML = '';
    var count = state.sources.length;
    rail.classList.toggle('has-photos', count > 0);

    state.sources.forEach(function (src, i) {
      var isBase = isReference() && i === 0;
      var chip = el('div', 'chip' + (isBase ? ' chip--base' : ''));
      chip.setAttribute('role', 'listitem');
      chip.draggable = !busy && count > 1;

      var thumb = el('button', 'chip__thumb');
      thumb.type = 'button';
      thumb.disabled = busy;
      thumb.setAttribute('aria-expanded', String(openChip === i));
      thumb.setAttribute('aria-label', (isBase ? 'Base photo' : 'Photo ' + (i + 1)) + ': ' + src.name + '. Open its options.');
      thumb.title = src.name;
      var img = document.createElement('img');
      img.src = src.dataUri;
      img.alt = '';
      img.draggable = false;
      thumb.appendChild(img);
      thumb.addEventListener('click', function () {
        openChip = openChip === i ? -1 : i;
        chipView = 'menu';
        closeMention();
        renderSource();
        renderChipPanel();
        var first = chipPanel.querySelector('button');
        if (openChip === i && first) first.focus();
      });
      // Alt + arrows reorder from the keyboard without opening anything.
      thumb.addEventListener('keydown', function (e) {
        if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        var to = i + (e.key === 'ArrowRight' ? 1 : -1);
        if (to < 0 || to >= count) return;
        moveSource(i, to);
        var moved = sourceList.querySelectorAll('.chip__thumb')[to];
        if (moved) moved.focus();
      });
      chip.appendChild(thumb);

      var label = chipLabel(i);
      if (label) chip.appendChild(el('span', 'chip__badge', label));

      var preview = el('div', 'chip__preview');
      preview.setAttribute('aria-hidden', 'true');
      var big = document.createElement('img');
      big.src = src.dataUri;
      big.alt = '';
      preview.appendChild(big);
      preview.appendChild(el('b', null, (isBase ? 'Base · ' : count > 1 ? 'Photo ' + (i + 1) + ' · ' : '') + src.name));
      preview.appendChild(el('span', 'num', dimsText(src)));
      chip.appendChild(preview);
      if (src.crop) {
        var mark = el('span', 'chip__crop');
        mark.title = 'Cropped';
        mark.appendChild(icon('crop', 9));
        chip.appendChild(mark);
      }

      var remove = el('button', 'chip__remove');
      remove.type = 'button';
      remove.disabled = busy;
      remove.setAttribute('aria-label', 'Remove ' + src.name);
      remove.appendChild(icon('x', 10));
      remove.addEventListener('click', function () { removeSource(i); });
      chip.appendChild(remove);

      if (count > 1) wireChipDrag(chip, i);
      sourceList.appendChild(chip);
    });

    addBtn.disabled = busy || count >= MAX_SOURCES;
    addBtn.setAttribute('aria-label', count ? 'Add another photo' : 'Add photos');

    // Two or more photos is ambiguous — one image out, or one per photo — and
    // the page cannot guess, so it asks.
    planSwitch.hidden = count < 2;
    planReference.setAttribute('aria-checked', String(state.plan === 'reference'));
    planEach.setAttribute('aria-checked', String(state.plan === 'each'));
    planReference.tabIndex = state.plan === 'reference' ? 0 : -1;
    planEach.tabIndex = state.plan === 'each' ? 0 : -1;
    planReference.disabled = planEach.disabled = busy;
  }

  function wireChipDrag(chip, i) {
    chip.addEventListener('dragstart', function (e) {
      if (busy) { e.preventDefault(); return; }
      dragFrom = i;
      chip.classList.add('is-dragging');
      try { e.dataTransfer.setData('text/plain', String(i)); } catch (err) { /* older engines */ }
      e.dataTransfer.effectAllowed = 'move';
    });
    chip.addEventListener('dragover', function (e) {
      if (dragFrom === -1) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      var r = chip.getBoundingClientRect();
      var after = e.clientX > r.left + r.width / 2;
      chip.classList.toggle('is-target-before', !after);
      chip.classList.toggle('is-target-after', after);
    });
    chip.addEventListener('dragleave', function () {
      chip.classList.remove('is-target-before', 'is-target-after');
    });
    chip.addEventListener('drop', function (e) {
      if (dragFrom === -1) return;
      e.preventDefault();
      e.stopPropagation();
      var r = chip.getBoundingClientRect();
      var to = i + (e.clientX > r.left + r.width / 2 ? 1 : 0);
      if (dragFrom < to) to -= 1;
      var from = dragFrom;
      dragFrom = -1;
      moveSource(from, to);
    });
    chip.addEventListener('dragend', function () {
      dragFrom = -1;
      Array.prototype.slice.call(sourceList.querySelectorAll('.chip')).forEach(function (n) {
        n.classList.remove('is-dragging', 'is-target-before', 'is-target-after');
      });
    });
  }

  function panelButton(text, fn, danger) {
    var b = el('button', 'btn-quiet', text);
    b.type = 'button';
    if (danger) b.style.color = 'var(--danger)';
    b.addEventListener('click', fn);
    return b;
  }

  function renderChipPanel() {
    chipPanel.innerHTML = '';
    var i = openChip;
    var src = state.sources[i];
    if (i < 0 || !src || busy) { chipPanel.hidden = true; openChip = -1; return; }
    chipPanel.hidden = false;

    var reference = isReference();
    var isBase = reference && i === 0;
    var count = state.sources.length;

    var head = el('div', 'panel__head');
    var title = el('div', 'panel__title', (isBase ? 'Base · ' : count > 1 ? 'Photo ' + (i + 1) + ' · ' : '') + src.name);
    title.appendChild(el('span', 'panel__sub num', dimsText(src)));
    head.appendChild(title);
    var close = el('button', 'icon-btn');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.appendChild(icon('x', 14));
    close.addEventListener('click', function () { closeChipPanel(true); });
    head.appendChild(close);
    chipPanel.appendChild(head);

    if (chipView === 'crop') {
      chipPanel.appendChild(renderCropper(src, i));
      return;
    }

    var actions = el('div', 'panel__actions');
    if (reference && i > 0) actions.appendChild(panelButton('Make this the base', function () { moveSource(i, 0); closeChipPanel(true); }));
    if (count > 1 && i > 0) actions.appendChild(panelButton('Move left', function () { moveSource(i, i - 1); focusPanel(); }));
    if (count > 1 && i < count - 1) actions.appendChild(panelButton('Move right', function () { moveSource(i, i + 1); focusPanel(); }));
    // The base is never cropped — it is the picture being kept.
    if (!isBase) {
      actions.appendChild(panelButton(src.crop ? 'Crop again' : 'Crop', function () {
        chipView = 'crop';
        renderChipPanel();
        var stage = chipPanel.querySelector('.cropper__stage');
        if (stage) stage.focus();
      }));
    }
    if (src.crop) actions.appendChild(panelButton('Use the whole photo', function () { clearCrop(src); renderRail(); renderChipPanel(); }));
    actions.appendChild(panelButton('Remove', function () { removeSource(i); }, true));
    chipPanel.appendChild(actions);

    chipPanel.appendChild(el('p', 'panel__note', isBase
      ? 'Everything is kept from the base — pose, clothing, background, framing and light — unless the prompt says otherwise.'
      : reference
        ? 'This photo lends only what the prompt asks for. Crop it to just that part — a face, a garment — and it carries over more faithfully.'
        : 'Crop to edit just part of the photo. Add another photo to combine them into one picture.'));
  }

  // -------------------------------------------------------------------------
  // Cropping. Drag a box on the photo; arrow keys nudge it, Shift with arrows
  // resizes it, Enter applies, Escape closes. The crop is cut from the
  // untouched original and upscaled with smoothing off, so nothing is blurred
  // on the way in.
  // -------------------------------------------------------------------------
  function clearCrop(src) {
    if (!src.crop) return;
    src.dataUri = src.original;
    src.size = src.originalSize;
    src.crop = null;
  }

  function applyCrop(src, rect) {
    return new Promise(function (resolve) {
      var im = new Image();
      im.onload = function () {
        var x = Math.max(0, Math.round(rect.x)), y = Math.max(0, Math.round(rect.y));
        var w = Math.max(8, Math.min(im.naturalWidth - x, Math.round(rect.w)));
        var h = Math.max(8, Math.min(im.naturalHeight - y, Math.round(rect.h)));
        var scale = Math.max(1, CROP_TARGET_SHORT / Math.min(w, h));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        var ctx = canvas.getContext('2d');
        // Nearest-neighbour. A smoothed upscale softens exactly the detail a
        // reference is there to supply.
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(im, x, y, w, h, 0, 0, canvas.width, canvas.height);
        var out;
        try { out = canvas.toDataURL('image/jpeg', 0.95); }
        catch (err) { resolve(false); return; }
        src.dataUri = out;
        src.size = Math.round((out.length - out.indexOf(',') - 1) * 0.75);
        src.crop = { x: x, y: y, w: w, h: h, outW: canvas.width, outH: canvas.height };
        resolve(true);
      };
      im.onerror = function () { resolve(false); };
      im.src = src.original;
    });
  }

  function renderCropper(src, i) {
    var wrap = el('div', 'cropper');
    var stage = el('div', 'cropper__stage');
    stage.tabIndex = 0;
    stage.setAttribute('role', 'application');
    stage.setAttribute('aria-label', 'Crop photo ' + (i + 1) + '. Drag to draw a box. ' +
      'Arrow keys move the box, Shift with arrows resizes it, Enter applies, Escape closes.');
    var img = document.createElement('img');
    img.className = 'cropper__img';
    img.src = src.original;
    img.alt = '';
    img.draggable = false;
    stage.appendChild(img);
    var box = el('div', 'cropper__box');
    box.hidden = true;
    stage.appendChild(box);
    wrap.appendChild(stage);

    var note = el('div', 'cropper__note num');
    wrap.appendChild(note);

    var actions = el('div', 'cropper__actions');
    var apply = el('button', 'btn-primary', 'Use this crop');
    apply.type = 'button';
    var back = el('button', 'btn-quiet', 'Back');
    back.type = 'button';
    actions.appendChild(apply);
    actions.appendChild(back);
    wrap.appendChild(actions);

    // The box lives in the photo's own pixels; only painting converts to screen.
    var natW = src.width || 0, natH = src.height || 0;
    var rect = src.crop ? { x: src.crop.x, y: src.crop.y, w: src.crop.w, h: src.crop.h } : null;

    function k() { return img.clientWidth && natW ? img.clientWidth / natW : 1; }

    function paint() {
      var has = Boolean(rect && rect.w >= 8 && rect.h >= 8);
      box.hidden = !has;
      apply.disabled = !has;
      if (has) {
        var s = k();
        // The image may be letterboxed inside the stage; offset to match.
        var ox = img.offsetLeft, oy = img.offsetTop;
        box.style.left = (ox + rect.x * s) + 'px';
        box.style.top = (oy + rect.y * s) + 'px';
        box.style.width = (rect.w * s) + 'px';
        box.style.height = (rect.h * s) + 'px';
        var up = Math.max(1, CROP_TARGET_SHORT / Math.min(Math.round(rect.w), Math.round(rect.h)));
        note.textContent = Math.round(rect.w) + '×' + Math.round(rect.h) + ' px' +
          (up > 1 ? ', sharpened up ' + (Math.round(up * 10) / 10) + '× when sent.' : ', sent as it is.');
      } else {
        note.textContent = 'Drag a box around just the part you want — for a face, head and shoulders and nothing else.';
      }
    }

    function clamp() {
      if (!rect) return;
      rect.w = Math.max(8, Math.min(natW, rect.w));
      rect.h = Math.max(8, Math.min(natH, rect.h));
      rect.x = Math.max(0, Math.min(natW - rect.w, rect.x));
      rect.y = Math.max(0, Math.min(natH - rect.h, rect.y));
    }

    function toImage(e) {
      var r = img.getBoundingClientRect();
      var s = k();
      return {
        x: Math.max(0, Math.min(natW, (e.clientX - r.left) / s)),
        y: Math.max(0, Math.min(natH, (e.clientY - r.top) / s))
      };
    }

    // Pointer: press inside the box to move it, anywhere else to draw a new one.
    var gesture = null;
    stage.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || !natW) return;
      e.preventDefault();
      stage.focus();
      var p = toImage(e);
      var inside = rect && p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
      gesture = inside ? { kind: 'move', px: p.x, py: p.y, ox: rect.x, oy: rect.y } : { kind: 'draw', px: p.x, py: p.y };
      if (!inside) rect = { x: p.x, y: p.y, w: 0, h: 0 };
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
    });
    stage.addEventListener('pointermove', function (e) {
      if (!gesture) return;
      var p = toImage(e);
      if (gesture.kind === 'move') {
        rect.x = gesture.ox + (p.x - gesture.px);
        rect.y = gesture.oy + (p.y - gesture.py);
      } else {
        rect = { x: Math.min(gesture.px, p.x), y: Math.min(gesture.py, p.y),
                 w: Math.abs(p.x - gesture.px), h: Math.abs(p.y - gesture.py) };
      }
      clamp();
      paint();
    });
    function endGesture() { gesture = null; paint(); }
    stage.addEventListener('pointerup', endGesture);
    stage.addEventListener('pointercancel', endGesture);

    stage.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); chipView = 'menu'; renderChipPanel(); focusPanel(); return; }
      if (e.key === 'Enter') { e.preventDefault(); if (!apply.disabled) apply.click(); return; }
      var dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      var dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      var step = Math.max(1, Math.round(natW / 100));
      if (!rect) {
        // Start from a centred box a third of the photo wide.
        var w0 = Math.round(natW / 3), h0 = Math.min(natH, Math.round(w0 * 1.15));
        rect = { x: Math.round((natW - w0) / 2), y: Math.round((natH - h0) / 2), w: w0, h: h0 };
      } else if (e.shiftKey) {
        rect.w += dx * step;
        rect.h += dy * step;
      } else {
        rect.x += dx * step;
        rect.y += dy * step;
      }
      clamp();
      paint();
    });

    apply.addEventListener('click', function () {
      if (!rect) return;
      apply.disabled = true;
      apply.textContent = 'Cropping';
      applyCrop(src, rect).then(function (ok) {
        chipView = 'menu';
        renderRail();
        renderChipPanel();
        focusPanel();
        if (!ok) {
          showError('That crop could not be made',
            'The photo did not draw onto a canvas — it may be damaged. Try exporting it again.', 'danger');
        }
      });
    });
    back.addEventListener('click', function () { chipView = 'menu'; renderChipPanel(); focusPanel(); });

    img.addEventListener('load', function () {
      if (!natW) { natW = img.naturalWidth; natH = img.naturalHeight; src.width = natW; src.height = natH; }
      paint();
    });
    paint();
    return wrap;
  }

  function focusPanel() {
    var first = chipPanel.querySelector('button:not(:disabled)');
    if (first) first.focus();
  }

  // -------------------------------------------------------------------------
  // The one line of guidance, the button, the cost
  // -------------------------------------------------------------------------
  function blockingReason() {
    if (!config) return 'Loading the studio.';
    if (modelIsRetired(state.model)) return 'Pick a model that still accepts requests.';
    if (isReference() && state.sources.length > MAX_EDIT_SOURCES) {
      var extra = state.sources.length - MAX_EDIT_SOURCES;
      return 'Combining takes up to ' + MAX_EDIT_SOURCES + ' photos. Remove ' + extra +
        (extra === 1 ? '' : ' of them') + ', or switch to Edit each.';
    }
    if (!promptEl.value.trim()) {
      return isReference() ? 'Say what to take from the other photos.'
        : mode() === 'edit' ? 'Describe the change you want.'
        : 'Describe the image first. Nothing is charged until you generate.';
    }
    if (wordCount(promptEl.value) < 3) return 'A prompt needs at least three words.';
    return null;
  }

  function renderHint() {
    var text, tone = '';
    if (attention) { text = attention; tone = 'is-danger'; }
    else if (busy) text = 'Locked while a run is in flight.';
    else if (isReference() && currentResolution() === '1k') {
      text = '1K kept the least of the likeness in testing. 2K costs a little more and holds the face noticeably better.';
      tone = 'is-warning';
    }
    else if (mode() === 'edit' && !isEditEach() && state.variants > 1) {
      text = 'Variants of an edit come back very similar. If a result is wrong, change the prompt or the crop instead.';
    }
    else if (isReference()) text = 'Photo 1 is the base and is kept as it is. Name the others by number — type @ to pick one — and say exactly what to take from each.';
    else if (isEditEach()) text = 'The same change is applied to each photo — ' + state.sources.length + ' images back, one per photo.';
    else if (mode() === 'edit') text = 'Describe the change. Add another photo to combine them into one picture.';
    else text = 'Plain description works better than keywords. Ctrl + Enter generates.';
    hintEl.textContent = text;
    hintEl.className = 'composer__hint ' + tone;
  }

  function actionLabel() {
    if (mode() === 'edit') {
      if (isEditEach()) return 'Edit ' + state.sources.length + ' photos';
      return isReference() ? 'Combine' : 'Apply edit';
    }
    return 'Generate';
  }

  function renderAction() {
    // A reason that no longer applies stops being shown the moment it is fixed.
    if (attention && blockingReason() !== attention) attention = '';
    renderHint();
    renderCost();
    if (busy) return; // the busy state owns the button until the run settles

    var rateLeft = Math.max(0, Math.ceil((rateLimitUntil - Date.now()) / 1000));
    actionBtn.classList.remove('is-busy');
    if (rateLeft > 0) {
      actionBtn.disabled = true;
      actionBtn.textContent = 'Wait ' + duration(rateLeft * 1000);
      actionBtn.classList.add('num');
      return;
    }
    actionBtn.classList.remove('num');
    // Never a dead grey button without a word of explanation: it stays live and
    // says what is missing when pressed. Only a server with no key disables it.
    actionBtn.disabled = !config || !config.hasKey;
    actionBtn.textContent = actionLabel();
  }

  function renderCost() {
    var est = estimate();
    if (!est) {
      // No price entry for this model: say the cost is unknown, never guess.
      costValue.textContent = 'cost unknown';
      costValue.title = 'This model has no price on record.';
      return;
    }
    costValue.textContent = money(est.total);
    costValue.title = 'Estimated cost: ' + money(est.total) +
      (est.count > 1 ? ' — ' + est.count + ' × ' + money(est.per) : '') + '. Charged as images arrive.';
    costValue.setAttribute('aria-label', costValue.title);
  }

  function autosize() {
    promptEl.style.height = 'auto';
    promptEl.style.height = Math.min(200, Math.max(44, promptEl.scrollHeight)) + 'px';
    paintPromptBack();
  }

  // The copy of the prompt that lies behind it, with every "photo N" given a
  // ground. A number with no photo behind it is marked differently: the model
  // would be told to look at something that is not there.
  function paintPromptBack() {
    var esc = function (t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    var count = state.sources.length;
    var html = esc(promptEl.value).replace(/\b(photo|image)\s?(\d{1,2})\b/gi, function (whole, word, n) {
      if (!count) return whole;
      return '<mark' + (Number(n) >= 1 && Number(n) <= count ? '' : ' class="is-missing"') + '>' + whole + '</mark>';
    });
    // A trailing newline needs something after it to take up its line.
    promptBack.innerHTML = html + (/\n$/.test(promptEl.value) ? '&nbsp;' : '');
    promptBack.scrollTop = promptEl.scrollTop;
  }

  // Resting as a slim bar: nothing typed, nothing attached, nothing open, and
  // the focus somewhere else.
  function isIdle() {
    return !busy && !state.sources.length && !promptEl.value.trim() && !attention && !openMenu &&
      !dock.contains(document.activeElement) && lightbox.hidden;
  }
  function renderIdle() {
    var idle = isIdle();
    if (rail.classList.contains('is-idle') === idle) return;
    rail.classList.toggle('is-idle', idle);
    dock.classList.toggle('is-idle', idle);
    if (!idle) autosize();
  }

  // Recompute on every change.
  function renderRail() {
    var reference = isReference();
    promptLabel.textContent = reference ? 'What should it take from them?'
      : mode() === 'edit' ? 'What should change?' : 'What should it make?';
    promptEl.placeholder = reference
      ? 'Keep photo 1 as it is. Replace the head with the person in photo 2…'
      : mode() === 'edit'
        ? 'Describe the change — “make the background a plain warm grey”'
        : 'Describe the image — subject, setting, light, mood';
    renderPills();
    renderRetirement();
    renderSource();
    renderChipPanel();
    renderAction();
    paintPromptBack();
    renderIdle();
    persist();
  }

  function persist() {
    writeStore(STORE_KEY, {
      model: state.model, quality: state.quality,
      shape: state.shape, resolution: state.resolution, frames: state.frames,
      editShape: state.editShape, editResolution: state.editResolution, variants: state.variants,
      name: state.name, filter: state.filter, thumb: state.thumb
    });
  }

  // -------------------------------------------------------------------------
  // Errors. Warning for things that clear on their own or with a retry, danger
  // for things that need a person. They persist until the next successful
  // action — no auto-dismiss, no toasts anywhere in this product.
  // -------------------------------------------------------------------------
  function clearError() { runError.innerHTML = ''; }

  function showError(title, body, tone) {
    runError.innerHTML = '';
    var box = el('div', 'notice notice--' + (tone === 'warning' ? 'warning' : 'danger'));
    box.appendChild(el('div', 'notice__title num', title));
    box.appendChild(el('div', 'notice__body num', body));
    runError.appendChild(box);
  }

  // A small confirmation, bottom left, gone in a moment. Never used for an
  // error — those stay as notices until dealt with. `action` adds one link,
  // such as Undo, and keeps the toast up for as long as the link is good.
  function toast(text, action) {
    var node = el('div', 'toast');
    node.appendChild(el('span', null, text));
    var gone = false;
    function leave() {
      if (gone) return;
      gone = true;
      node.classList.add('is-leaving');
      setTimeout(function () { node.remove(); }, 220);
    }
    if (action) {
      var b = el('button', 'btn-text', action.label);
      b.type = 'button';
      b.addEventListener('click', function () { leave(); action.run(); });
      node.appendChild(b);
    }
    toastsEl.appendChild(node);
    while (toastsEl.children.length > 3) toastsEl.firstChild.remove();
    setTimeout(leave, action && action.ms ? action.ms : 2200);
    return leave;
  }

  function describeFailure(payload, status) {
    var code = payload && payload.code;
    var message = (payload && payload.error) || ('xAI returned status ' + status + '.');

    if (code === 'no_key') {
      return ['danger', 'No API key on the server',
        'Generating is switched off until someone adds the team key to the server environment. Post in #design-ops — nothing you change here will fix it.'];
    }
    if (code === 'moderation') {
      return ['danger', 'The prompt was blocked, no images returned',
        'Moderation at xAI rejected this wording, most often over a named person, a brand or violence. Rewrite the subject in plainer terms and run it again. You were not charged.'];
    }
    if (code === 'rate_limited') {
      var wait = payload && payload.retryAfter ? payload.retryAfter : 30;
      return ['warning', 'Too many runs in a row',
        'The shared key hit its limit. The button unlocks in ' + wait + ' seconds — someone else on the team may be generating right now. Nothing was charged.'];
    }
    if (code === 'no_credits') {
      return ['danger', 'The prepaid credits ran out',
        'The team account has no balance left, so no new runs will start. Ask in #design-ops to top it up. Images already on this page still download.'];
    }
    if (code === 'key_rejected') {
      return ['danger', 'xAI rejected the team key',
        message + ' Someone needs to check XAI_API_KEY on the server. Nothing was charged.'];
    }
    if (code === 'timeout') {
      var secs = (payload && payload.seconds) || 180;
      return ['warning', 'Timed out after ' + secs + ' seconds',
        'Nothing came back, so nothing was charged. Large sizes and high frame counts time out most often — retry, or drop the size and the number of frames.'];
    }
    if (code === 'network') {
      return ['danger', 'Could not reach xAI',
        message + ' This is the server’s connection, not yours. Retry, and if it keeps failing post in #design-ops.'];
    }
    if (code === 'consent_required') {
      return ['danger', 'Confirm permission first',
        'Combining photos uses real people’s likenesses. Press Combine again and confirm you have permission. Nothing was charged.'];
    }
    if (code === 'likeness_policy') {
      return ['danger', 'This studio will not make that', message + ' Nothing was charged.'];
    }
    if (code === 'model_unavailable') {
      // xAI's own wording ("does not exist or your team does not have access")
      // reads like a permissions or billing problem. It has been neither: the
      // model stopped being served for a few minutes and came back.
      var prices = (config && config.prices) || {};
      var failed = payload && payload.model;
      var failedLabel = prices[failed] ? prices[failed].label : 'That model';
      var others = Object.keys(prices).filter(function (id) { return id !== failed && !modelIsRetired(id); });
      var pick = others.filter(function (id) { return prices[id].isDefault; })[0] || others[0];
      return ['warning', failedLabel + ' is not answering right now',
        'xAI turned the request away before making anything, so nothing was charged. This is usually temporary. ' +
        (pick ? 'Switch to ' + prices[pick].label + ' in the Model list, or try again in a few minutes. '
              : 'Try again in a few minutes. ') +
        'Your credits and the team key are fine.'];
    }
    if (code === 'too_large') return ['danger', 'That photo is too large', message];
    if (code === 'bad_request') return ['danger', 'xAI would not accept that request', message];
    // Unmapped: show the status code and what to do with it. Never "something
    // went wrong".
    return ['danger', 'xAI returned ' + status, message + ' Retry, then post the code in #design-ops.'];
  }

  function startRateLimit(seconds) {
    rateLimitUntil = Date.now() + seconds * 1000;
    if (rateLimitTimer) clearInterval(rateLimitTimer);
    rateLimitTimer = setInterval(function () {
      if (Date.now() >= rateLimitUntil) {
        clearInterval(rateLimitTimer);
        rateLimitTimer = null;
        rateLimitUntil = 0;
      }
      renderAction();
    }, 1000);
    renderAction();
  }

  // -------------------------------------------------------------------------
  // The gallery
  // -------------------------------------------------------------------------
  function doneImages(run) {
    var out = [];
    run.frames.forEach(function (f) { if (f.image) out.push(f.image); });
    return out;
  }

  function dayLabel(ms) {
    var d = new Date(ms), now = new Date();
    var startOf = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((startOf(now) - startOf(d)) / 86400000);
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // Which frames of a run the current filter shows.
  function visibleIndexes(run) {
    var idx = [];
    run.frames.forEach(function (f, i) {
      if (state.filter === 'fav' && !(f.image && f.image.favourite)) return;
      idx.push(i);
    });
    if (state.filter === 'mine' && !sameName(run.user, state.name)) return [];
    if (state.filter === 'mine' && !state.name.trim()) return [];
    return idx;
  }

  // Every run that still holds a favourite, however old — not only the recent
  // ones the page loaded at the start. Asked for when the Library is opened.
  var libraryLoaded = false;
  async function loadLibrary() {
    if (!config || !config.savesImages) return;
    try {
      var res = await fetch('/api/runs?favourites=1&limit=500', { headers: authHeaders({}) });
      if (!res.ok) return;
      var payload = await res.json();
      libraryLoaded = true;
      // Favourites from long ago must not move the paging mark: that tracks
      // how far back the ordinary gallery has been read.
      var mark = oldestStamp;
      var added = takeRestored(payload.runs || []);
      oldestStamp = mark;
      if (added && state.filter === 'fav') renderRuns();
    } catch (err) { /* the library shows what is already loaded */ }
  }

  // Picture sizes for the slider, as the narrowest a column may be.
  var THUMB_PX = [0, 170, 230, 300, 380, 480];
  function applyThumb() {
    document.documentElement.style.setProperty('--thumb', THUMB_PX[state.thumb] + 'px');
    thumbEl.value = state.thumb;
    scheduleLayout();
  }

  // Masonry. The wall is a grid of 4px rows; each frame is told how many rows
  // its height needs. Reading order stays left-to-right, newest first, and no
  // picture is cropped to fit its neighbours.
  var ROW = 4;
  var layoutQueued = false;
  function scheduleLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(function () {
      layoutQueued = false;
      Array.prototype.slice.call(results.querySelectorAll('.wall .frame')).forEach(function (f) {
        f.style.gridRowEnd = 'auto';
      });
      Array.prototype.slice.call(results.querySelectorAll('.wall .frame')).forEach(function (f) {
        var h = f.getBoundingClientRect().height;
        var gap = parseFloat(getComputedStyle(f).marginBottom) || 0;
        f.style.gridRowEnd = 'span ' + Math.max(1, Math.ceil((h + gap) / ROW));
      });
    });
  }
  if (window.ResizeObserver) new ResizeObserver(scheduleLayout).observe(results);

  function wall(pairs) {
    var node = el('div', 'wall');
    pairs.forEach(function (p) { node.appendChild(renderFrame(p[0], p[1])); });
    return node;
  }

  function renderLibrary() {
    var pairs = [];
    runs.forEach(function (run) {
      run.frames.forEach(function (f, i) { if (f.image && f.image.favourite) pairs.push([run, i]); });
    });
    if (!pairs.length) return 0;
    var head = el('div', 'library__head');
    head.appendChild(el('h2', 'library__title', 'Library'));
    head.appendChild(el('span', 'library__note num', pairs.length + (pairs.length === 1 ? ' favourite' : ' favourites') +
      ' · kept for good, never cleared to make room'));
    results.insertBefore(head, empty);
    results.insertBefore(wall(pairs), empty);
    return pairs.length;
  }

  // Grey frames while the history is on its way, so the page is never blank.
  var historyLoading = false;
  function renderSkeleton() {
    var node = el('div', 'wall');
    ['3 / 4', '1 / 1', '9 / 16', '4 / 3', '1 / 1', '3 / 4', '16 / 9', '9 / 16'].forEach(function (r) {
      var f = el('div', 'frame frame--skeleton');
      f.style.setProperty('--ratio', r);
      node.appendChild(f);
    });
    results.insertBefore(node, empty);
  }

  // -------------------------------------------------------------------------
  // Prompts — /asset. Every prompt the team has used, kept on the server, a
  // card each: use it, copy it, star it, delete it.
  // -------------------------------------------------------------------------
  var prompts = null;          // null until first loaded
  var promptSearch = '';
  var promptFavOnly = false;
  var openCards = {};

  async function loadPrompts() {
    try {
      var res = await fetch('/api/prompts', { headers: authHeaders({}) });
      if (res.status === 401) { lockOut(); return; }
      if (!res.ok) throw new Error('failed');
      prompts = (await res.json()).prompts || [];
    } catch (err) {
      prompts = prompts || [];
      showError('The prompts could not be loaded', 'The server did not answer. Check it is still running, then open Prompts again.', 'warning');
    }
    if (state.filter === 'assets') renderRuns();
  }

  function promptAction(path, body) {
    return fetch('/api/prompts/' + path, {
      method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 401) { lockOut(); throw new Error('locked'); }
      if (!res.ok) throw new Error('failed');
      return res.json();
    });
  }

  function sortPrompts() {
    prompts.sort(function (x, y) {
      return (Number(y.favourite) - Number(x.favourite)) || String(y.lastUsedAt).localeCompare(String(x.lastUsedAt));
    });
  }

  function copyText(text, said) {
    var ok = function () { toast(said); };
    var no = function () { toast('This browser would not allow copying'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, no);
    else no();
  }

  function promptCard(p) {
    var card = el('article', 'pcard' + (p.favourite ? ' is-fav' : '') + (openCards[p.id] ? ' is-open' : ''));
    card.appendChild(el('p', 'pcard__text', p.text));
    if (p.text.length > 260) {
      var more = el('button', 'btn-text pcard__more', openCards[p.id] ? 'Show less' : 'Show all');
      more.type = 'button';
      more.addEventListener('click', function () { openCards[p.id] = !openCards[p.id]; renderRuns(); });
      card.appendChild(more);
    }
    var used = new Date(Date.parse(p.lastUsedAt) || Date.now());
    card.appendChild(el('div', 'pcard__meta num',
      (p.mode === 'edit' ? 'Edit' : 'Generate') + ' · used ' + (p.uses === 1 ? 'once' : p.uses + ' times') +
      ' · ' + dayLabel(used.getTime()) + (p.user ? ' · ' + p.user : '')));

    var acts = el('div', 'pcard__acts');
    var use = el('button', 'btn-quiet pcard__use', 'Use this prompt');
    use.type = 'button';
    use.addEventListener('click', function () {
      if (busy) return;
      promptEl.value = p.text;
      autosize();
      renderAction();
      renderIdle();
      promptEl.focus();
      promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
      toast(p.mode === 'edit' ? 'Prompt added — attach the photos it refers to' : 'Prompt added to the box');
    });
    acts.appendChild(use);

    var copy = el('button', 'icon-btn');
    copy.type = 'button';
    copy.title = 'Copy';
    copy.setAttribute('aria-label', 'Copy this prompt');
    copy.appendChild(icon('copy', 16));
    copy.addEventListener('click', function () { copyText(p.text, 'Prompt copied'); });
    acts.appendChild(copy);

    var star = el('button', 'icon-btn icon-btn--star');
    star.type = 'button';
    star.setAttribute('aria-pressed', String(Boolean(p.favourite)));
    star.setAttribute('aria-label', p.favourite ? 'Remove from favourites' : 'Add to favourites');
    star.title = p.favourite ? 'A favourite — kept first, and never cleared' : 'Add to favourites';
    star.appendChild(icon('star', 16));
    star.addEventListener('click', function () {
      promptAction('favourite', { id: p.id, favourite: !p.favourite }).then(function () {
        p.favourite = !p.favourite;
        sortPrompts();
        renderRuns();
        toast(p.favourite ? 'Added to favourites' : 'Removed from favourites');
      }, function () { toast('That change could not be saved'); });
    });
    acts.appendChild(star);

    var del = el('button', 'icon-btn icon-btn--danger');
    del.type = 'button';
    del.title = 'Delete — you can undo for a few seconds';
    del.setAttribute('aria-label', 'Delete this prompt');
    del.appendChild(icon('trash', 16));
    del.addEventListener('click', function () {
      promptAction('delete', { id: p.id }).then(function () {
        prompts = prompts.filter(function (x) { return x.id !== p.id; });
        renderRuns();
        toast('Prompt deleted', { label: 'Undo', ms: UNDO_MS, run: function () {
          promptAction('restore', { prompt: p }).then(function (out) {
            if (out.prompt) { prompts.push(out.prompt); sortPrompts(); renderRuns(); toast('Prompt restored'); }
          }, function () { toast('The prompt could not be restored'); });
        } });
      }, function () { toast('The prompt could not be deleted'); });
    });
    acts.appendChild(del);
    card.appendChild(acts);
    return card;
  }

  function renderAssets() {
    if (prompts === null) { loadPrompts(); return 1; }   // cards arrive in a moment
    var head = el('div', 'assets__head');
    head.appendChild(el('h2', 'assets__title', 'Prompts'));
    var needle = promptSearch.trim().toLowerCase();
    var list = prompts.filter(function (p) {
      return (!promptFavOnly || p.favourite) && (!needle || p.text.toLowerCase().indexOf(needle) !== -1 || String(p.user || '').toLowerCase().indexOf(needle) !== -1);
    });
    head.appendChild(el('span', 'assets__note num', list.length === prompts.length
      ? prompts.length + (prompts.length === 1 ? ' prompt' : ' prompts') + ' · saved each time one is used'
      : list.length + ' of ' + prompts.length));

    var tools = el('div', 'assets__tools');
    var search = document.createElement('input');
    search.type = 'search';
    search.className = 'input assets__search';
    search.placeholder = 'Search prompts';
    search.setAttribute('aria-label', 'Search prompts');
    search.value = promptSearch;
    search.addEventListener('input', function () {
      promptSearch = search.value;
      var at = search.selectionStart;
      renderRuns();
      var again = results.querySelector('.assets__search');
      if (again) { again.focus(); again.setSelectionRange(at, at); }
    });
    tools.appendChild(search);
    var seg = el('div', 'seg seg--small');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Which prompts');
    [['All', false], ['Favourites', true]].forEach(function (pair) {
      var b = el('button', 'seg__btn', pair[0]);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(promptFavOnly === pair[1]));
      b.addEventListener('click', function () { promptFavOnly = pair[1]; renderRuns(); });
      seg.appendChild(b);
    });
    tools.appendChild(seg);
    head.appendChild(tools);
    results.insertBefore(head, empty);

    if (!list.length) return prompts.length ? -1 : 0;
    var grid = el('div', 'assets');
    list.forEach(function (p) { grid.appendChild(promptCard(p)); });
    results.insertBefore(grid, empty);
    return list.length;
  }

  function renderRuns() {
    Array.prototype.slice.call(results.querySelectorAll('.wall, .day, .library__head, .more, .assets, .assets__head')).forEach(function (n) { n.remove(); });

    // Forget anything selected that is no longer on the page, so the count in
    // the bar can never claim more than exists.
    var live = {};
    runs.forEach(function (run) {
      run.frames.forEach(function (f) { if (f.image && f.image.id) live[f.image.id] = true; });
    });
    Array.from(selected).forEach(function (id) { if (!live[id]) selected.delete(id); });

    var shown = 0;
    if (state.filter === 'assets') {
      shown = renderAssets();
      empty.hidden = shown !== 0 && shown !== -1;
      emptySeeds.hidden = true;
      emptyTitle.textContent = shown === -1 ? 'No prompt matches' : 'No prompts yet';
      emptyBody.textContent = shown === -1
        ? 'Try fewer words, or switch back to All.'
        : 'Every prompt you generate or edit with is saved here, for the whole team, ready to copy or use again.';
      renderSelectionBar();
      return;
    }
    if (state.filter === 'fav') shown = renderLibrary();
    else {
      // One wall per day: every frame of every run made that day, in order.
      var days = [], byDay = {};
      runs.forEach(function (run) {
        var idx = visibleIndexes(run);
        if (!idx.length) return;
        var day = dayLabel(run.startedAt);
        if (!byDay[day]) { byDay[day] = []; days.push(day); }
        idx.forEach(function (i) { byDay[day].push([run, i]); });
        shown++;
      });
      days.forEach(function (day) {
        results.insertBefore(el('div', 'day', day), empty);
        results.insertBefore(wall(byDay[day]), empty);
      });
      if (shown && !historyDone) {
        var more = el('div', 'more', loadingOlder ? 'Loading older pictures' : '');
        results.insertBefore(more, empty);
        if (moreWatcher) moreWatcher.observe(more);
      }
    }

    if (!shown && historyLoading) { renderSkeleton(); shown = 1; }

    empty.hidden = shown > 0;
    if (!shown) {
      var filtered = state.filter === 'fav' || (runs.length > 0 && state.filter !== 'all');
      emptySeeds.hidden = filtered;
      if (state.filter === 'fav' && filtered) {
        emptyTitle.textContent = 'Your library is empty';
        emptyBody.textContent = 'Star a frame and it is kept here for good. Favourites are never cleared to make room for new images.';
      } else if (state.filter === 'mine' && filtered) {
        emptyTitle.textContent = state.name.trim() ? 'No runs under your name' : 'Add your name to see your runs';
        emptyBody.textContent = state.name.trim()
          ? 'Runs you make as “' + state.name.trim() + '” appear here.'
          : 'Open the menu at the top right and fill in Working as. Runs you make from then on are yours.';
      } else {
        emptyTitle.textContent = 'Describe an image to begin';
        emptyBody.textContent = 'Type below and generate up to ten frames at once. Add photos to edit them, or to combine several into one picture. Every run stays on this page.';
      }
    }
    renderSelectionBar();
    scheduleLayout();
  }

  // Point at a picture and its run-mates outline themselves. One listener on
  // the gallery, not one per frame.
  function kin(target, on) {
    var f = target && target.closest ? target.closest('.frame') : null;
    if (!f || !f.dataset.run) return;
    var mates = results.querySelectorAll('.frame[data-run="' + f.dataset.run + '"]');
    if (mates.length < 2) return;
    Array.prototype.slice.call(mates).forEach(function (m) { m.classList.toggle('is-kin', on && m !== f); });
  }
  results.addEventListener('mouseover', function (e) { kin(e.target, true); });
  results.addEventListener('mouseout', function (e) { kin(e.target, false); });
  results.addEventListener('focusin', function (e) { kin(e.target, true); });
  results.addEventListener('focusout', function (e) { kin(e.target, false); });

  // Older history arrives as the bottom of the page comes into view.
  var historyDone = true, loadingOlder = false, oldestStamp = null;
  var PAGE = 40;
  var moreWatcher = window.IntersectionObserver ? new IntersectionObserver(function (entries) {
    if (entries.some(function (en) { return en.isIntersecting; })) loadOlder();
  }, { rootMargin: '600px' }) : null;

  async function loadOlder() {
    if (historyDone || loadingOlder || !oldestStamp || state.filter === 'fav') return;
    loadingOlder = true;
    try {
      var res = await fetch('/api/runs?limit=' + PAGE + '&before=' + encodeURIComponent(oldestStamp), { headers: authHeaders({}) });
      if (!res.ok) { historyDone = true; return; }
      var list = (await res.json()).runs || [];
      takeRestored(list);
      if (list.length < PAGE) historyDone = true;
    } catch (err) {
      historyDone = true;
    } finally {
      loadingOlder = false;
      renderRuns();
    }
  }

  // Adds runs read from the server, skipping any already on the page, and
  // remembers how far back the page now reaches.
  function takeRestored(list) {
    var have = {};
    runs.forEach(function (r) { have[r.id] = true; have['saved-' + r.id] = true; });
    list.forEach(function (r) {
      if (r.timestamp && (!oldestStamp || r.timestamp < oldestStamp)) oldestStamp = r.timestamp;
    });
    var fresh = list.map(restoreRun).filter(function (r) { return !have[r.id]; });
    if (fresh.length) runs = runs.concat(fresh).sort(function (x, y) { return y.startedAt - x.startedAt; });
    return fresh.length;
  }

  function renderFrame(run, index) {
    var frame = run.frames[index];
    var wrap = el('div', 'frame');
    wrap.dataset.frameFor = run.id + ':' + index;
    wrap.dataset.run = run.id;
    // What the picture really measured, once known, beats what was asked for.
    var ratio = (frame.image && frame.image.ratio) || run.ratio || aspectRatioCss(run.shape);
    if (ratio) wrap.style.setProperty('--ratio', ratio);
    var n = index + 1;

    // Waiting. Only the frame actually being worked on pulses.
    if (frame.status === 'running' || frame.status === 'queued') {
      var running = frame.status === 'running';
      var ph = el('div', 'frame__placeholder' + (running ? ' is-running' : ''));
      if (running) {
        var ring = document.createElement('span');
        ring.innerHTML = '<svg class="ring" viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="12"/><path d="M15 3a12 12 0 0 1 10.4 18"/></svg>';
        ph.appendChild(ring.firstChild);
      }
      ph.appendChild(el('span', null, running ? 'Rendering' : 'Queued'));
      wrap.appendChild(ph);
      return wrap;
    }

    // A single frame failed inside an otherwise good run. Offer to retry just
    // this one rather than making the whole run again.
    if (frame.status === 'failed') {
      wrap.classList.add('frame--failed');
      var box = el('div', 'frame__failed');
      box.appendChild(el('b', null, 'Frame ' + n + ' failed'));
      box.appendChild(el('span', null, frame.error || 'The other frames arrived.'));
      var retry = el('button', 'btn-quiet', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', function () { retryFrame(run, index); });
      box.appendChild(retry);
      wrap.appendChild(box);
      return wrap;
    }

    if (frame.status === 'deleted' || frame.status === 'cancelled') {
      wrap.appendChild(el('div', 'frame__placeholder', frame.status === 'deleted' ? 'Deleted' : 'Not started'));
      return wrap;
    }

    var image = frame.image;
    if (!image) return wrap;

    var btn = el('button', 'frame__button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open frame ' + n + ': details, download and reuse');
    var img = document.createElement('img');
    img.src = image.src;
    img.alt = run.prompt;   // alt text on generated images is the prompt
    img.loading = 'lazy';
    // Record what xAI actually produced: the only truthful source for the size.
    img.addEventListener('load', function () {
      img.classList.add('is-in');
      var real = img.naturalWidth + ' / ' + img.naturalHeight;
      if (image.ratio !== real) {
        image.ratio = real;
        wrap.style.setProperty('--ratio', real);
        scheduleLayout();
      }
      if (image.width) return;
      image.width = img.naturalWidth;
      image.height = img.naturalHeight;
      refreshRunCaption(run);
    });
    btn.appendChild(img);
    btn.addEventListener('click', function () { openLightbox(run, image); });
    wrap.appendChild(btn);

    // Selecting, favouriting and deleting need the server to have kept a copy.
    if (isStored(image)) {
      var sel = el('label', 'frame__select');
      var box2 = document.createElement('input');
      box2.type = 'checkbox';
      box2.checked = selected.has(image.id);
      box2.setAttribute('aria-label', 'Select frame ' + n);
      box2.addEventListener('change', function () {
        if (box2.checked) selected.add(image.id); else selected.delete(image.id);
        renderSelectionBar();
      });
      sel.appendChild(box2);
      wrap.appendChild(sel);

      var fav = el('button', 'frame__fav');
      fav.type = 'button';
      fav.appendChild(icon('star', 14));
      var paintFav = function (on) {
        fav.setAttribute('aria-pressed', String(on));
        fav.setAttribute('aria-label', on ? 'Remove frame ' + n + ' from favourites' : 'Favourite frame ' + n);
        fav.title = on ? 'Favourite — kept when old images are cleared' : 'Favourite';
      };
      paintFav(Boolean(image.favourite));
      fav.addEventListener('click', async function () {
        var next = fav.getAttribute('aria-pressed') !== 'true';
        if (!(await toggleFavourite(image, next))) return;
        paintFav(next);
        if (state.filter === 'fav') renderRuns();
      });
      wrap.appendChild(fav);
    }

    return wrap;
  }

  // Repaint one frame in place, so a frame landing does not move the others.
  function refreshFrame(run, index) {
    var node = results.querySelector('[data-frame-for="' + run.id + ':' + index + '"]');
    if (node) node.replaceWith(renderFrame(run, index));
    scheduleLayout();
  }

  // Nothing in the gallery shows a run's size or cost any more; if the viewer
  // is open on this run, its card is what needs refreshing.
  function refreshRunCaption(run) {
    if (lightboxState && lightboxState.run === run) renderLightbox();
  }

  function tickElapsed() { /* elapsed time is no longer shown in the gallery */ }

  // -------------------------------------------------------------------------
  // Selecting, favouriting, deleting
  // -------------------------------------------------------------------------
  function authHeaders(extra) {
    var h = extra || {};
    if (password) h['x-team-password'] = password;
    return h;
  }

  function isStored(image) { return Boolean(image && image.id); }

  async function toggleFavourite(image, on) {
    if (!isStored(image)) return false;
    try {
      var res = await fetch('/api/favourite', {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ id: image.id, favourite: on })
      });
      if (res.status === 401) { lockOut(); return false; }
      if (!res.ok) throw new Error('failed');
      image.favourite = on;
      return true;
    } catch (err) {
      showError('Could not save that favourite',
        'The server did not accept the change. Check it is still running, then try again.', 'warning');
      return false;
    }
  }

  // Drop images from the in-memory runs once the server has really deleted them.
  // Takes images out of the page, and hands back what is needed to put them
  // back exactly as they were.
  function forgetImages(ids) {
    var gone = {}, record = [];
    ids.forEach(function (id) { gone[id] = true; selected.delete(id); });
    runs.forEach(function (run) {
      run.frames.forEach(function (f, i) {
        if (f.image && gone[f.image.id]) {
          record.push({ run: run, index: i, image: f.image });
          f.image = null;
          f.status = 'deleted';
        }
      });
    });
    // A run with nothing left in it is not worth a place on the wall.
    runs = runs.filter(function (run) {
      return run.status === 'running' || run.frames.some(function (f) { return f.image || f.status === 'failed'; });
    });
    renderRuns();
    return record;
  }

  // Deleting is immediate and can be taken back for ten seconds. The server
  // moves the file aside rather than destroying it, so Undo is a real undo —
  // the same picture, the same place, its star intact.
  var UNDO_MS = 10000;
  async function deleteImages(ids) {
    var real = ids.filter(Boolean);
    if (!real.length) return;
    try {
      var res = await fetch('/api/images/delete', {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ ids: real })
      });
      if (res.status === 401) { lockOut(); return; }
      var payload = await res.json().catch(function () { return null; });
      if (!res.ok) {
        showError('Could not delete', (payload && payload.error) || 'The server refused the request. Try again.', 'danger');
        return;
      }
      // Treat missing files as gone too — the goal was for them not to be there.
      var record = forgetImages((payload.deleted || []).concat(payload.missing || []));
      clearError();
      var n = record.length;
      if (!n) return;
      toast('Deleted ' + n + (n === 1 ? ' picture' : ' pictures'), {
        label: 'Undo', ms: UNDO_MS,
        run: function () { undoDelete(record, payload.deleted || [], payload.wasFavourite || []); }
      });
    } catch (err) {
      showError('Could not reach the studio server',
        'Nothing was deleted. Check the server is still running, then try again.', 'danger');
    }
  }

  async function undoDelete(record, ids, favourites) {
    try {
      var res = await fetch('/api/images/restore', {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ ids: ids, favourites: favourites })
      });
      if (res.status === 401) { lockOut(); return; }
      var back = {};
      ((await res.json()).restored || []).forEach(function (id) { back[id] = true; });
      var n = 0;
      record.forEach(function (r) {
        if (!back[r.image.id]) return;
        r.run.frames[r.index].image = r.image;
        r.run.frames[r.index].status = 'done';
        if (runs.indexOf(r.run) === -1) runs.push(r.run);
        n++;
      });
      runs.sort(function (x, y) { return y.startedAt - x.startedAt; });
      renderRuns();
      if (n < record.length) {
        showError('Some pictures could not be brought back',
          (record.length - n) + ' had already been cleared from the server. The rest are back where they were.', 'warning');
      } else toast(n === 1 ? 'Picture restored' : n + ' pictures restored');
    } catch (err) {
      showError('Could not reach the studio server', 'The pictures were not restored. Try Undo again within a few minutes.', 'danger');
    }
  }

  function renderSelectionBar() {
    var existing = results.querySelector('.selection-bar');
    if (!selected.size) { if (existing) existing.remove(); return; }
    var bar = existing || el('div', 'selection-bar');
    bar.innerHTML = '';
    bar.appendChild(el('span', 'selection-bar__count num',
      selected.size + (selected.size === 1 ? ' image selected' : ' images selected')));
    var actions = el('div', 'selection-bar__actions');

    var dl = el('button', 'btn-text', 'Download');
    dl.type = 'button';
    dl.addEventListener('click', function () {
      var i = 0;
      runs.forEach(function (run) {
        run.frames.forEach(function (f) {
          if (f.image && selected.has(f.image.id)) {
            var img = f.image, r = run, delay = i++ * 150;
            setTimeout(function () { downloadImage(r, img); }, delay);
          }
        });
      });
    });
    actions.appendChild(dl);

    var del = el('button', 'btn-text btn-text--danger', 'Delete');
    del.type = 'button';
    del.addEventListener('click', function () { deleteImages(Array.from(selected)); });
    actions.appendChild(del);

    var clear = el('button', 'btn-text', 'Clear selection');
    clear.type = 'button';
    clear.addEventListener('click', function () { selected.clear(); renderRuns(); });
    actions.appendChild(clear);

    bar.appendChild(actions);
    if (!existing) results.insertBefore(bar, results.firstChild);
  }

  // -------------------------------------------------------------------------
  // Downloads
  // -------------------------------------------------------------------------
  function slug(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
  }

  function imageFileName(run, image) {
    return slug(run.prompt) + '-frame-' + (image.frame || 1) + '.' + (image.ext || 'png');
  }

  function downloadImage(run, image) {
    if (!image) return;
    var a = document.createElement('a');
    a.href = image.src;
    a.download = imageFileName(run, image);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function downloadRun(run) {
    doneImages(run).forEach(function (image, i) {
      setTimeout(function () { downloadImage(run, image); }, i * 150);
    });
  }

  // -------------------------------------------------------------------------
  // Use as reference / Again / Reuse prompt
  // -------------------------------------------------------------------------
  function toDataUri(src) {
    if (!src || src.indexOf('/api/') !== 0) return Promise.resolve(src);
    return fetch(src)
      .then(function (r) { if (!r.ok) throw new Error('gone'); return r.blob(); })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onload = function () { resolve(String(fr.result)); };
          fr.onerror = reject;
          fr.readAsDataURL(blob);
        });
      });
  }

  // Sends a result into the composer as a photo. With nothing attached it
  // becomes the photo being edited; otherwise it joins as the next reference.
  async function useAsReference(run, image) {
    if (!image || busy) return;
    closeLightbox();
    if (state.sources.length >= MAX_SOURCES) {
      showError('That is already ' + MAX_SOURCES + ' photos', 'Remove one to add another.', 'warning');
      return;
    }
    var dataUri;
    try {
      dataUri = await toDataUri(image.src);
    } catch (err) {
      showError('That image could not be loaded',
        'It may have been cleared from the server. Generate it again, or pick another frame.', 'danger');
      return;
    }
    var wasEmpty = state.sources.length === 0;
    // A prompt left over from generating this very image describes a picture,
    // which is the wrong instruction for an edit. Anything else typed is kept.
    if (wasEmpty && promptEl.value.trim() === String(run.prompt).trim()) { promptEl.value = ''; autosize(); }
    addSources([{
      dataUri: dataUri, original: dataUri, originalSize: image.bytes || 0, crop: null,
      name: imageFileName(run, image), size: image.bytes || 0,
      width: image.width || 0, height: image.height || 0
    }]);
    clearError();
    promptEl.focus();
  }

  // The photos an edit was made from. A run made in this tab still holds them;
  // one restored from the server names the copies the server kept.
  function sourceUrls(run) {
    if (run.mode !== 'edit') return [];
    if (run.sources && run.sources.length) return run.sources;
    return (run.sourceIds || []).map(function (id) { return '/api/source/' + id; });
  }

  // As data URIs, which is what a request carries. Fetched once and kept.
  async function sourceData(run) {
    if (run.sources && run.sources.length) return run.sources;
    if (!run.sourceIds || !run.sourceIds.length) return [];
    var list = await Promise.all(run.sourceIds.map(function (id) { return toDataUri('/api/source/' + id); }));
    run.sources = list;
    return list;
  }

  // An edit can be repeated only while its photos still exist somewhere.
  function canRunAgain(run) {
    return run.mode !== 'edit' || sourceUrls(run).length > 0;
  }

  function photosGone() {
    showError('The photos for that edit are no longer stored',
      'They were cleared from the server to make room. Attach them again to repeat it.', 'warning');
  }

  // Again re-runs that run's stored settings, not the composer's current ones.
  async function again(run) {
    if (busy || !canRunAgain(run)) return;
    closeLightbox();
    var sources;
    try { sources = await sourceData(run); } catch (err) { photosGone(); return; }
    var settings = {
      mode: run.mode, model: run.model, prompt: run.prompt, quality: run.quality,
      shape: run.shape, resolution: run.resolution,
      n: run.frames ? run.frames.length : run.n,
      plan: run.plan || 'reference', sources: sources, ratio: run.ratio || null
    };
    var go = function () { submitRun(settings); };
    if (settings.mode === 'edit' && settings.plan === 'reference' && sources.length > 1 && !likenessConsent) askConsent(go);
    else go();
  }

  function reuseLabel(run) {
    return run.mode === 'edit' && sourceUrls(run).length ? 'Reuse photos and prompt' : 'Reuse prompt';
  }

  function probe(dataUri, name) {
    return new Promise(function (resolve) {
      var size = Math.round((dataUri.length - dataUri.indexOf(',') - 1) * 0.75);
      var im = new Image();
      var done = function (w, h) {
        resolve({ dataUri: dataUri, original: dataUri, originalSize: size, crop: null, name: name, size: size, width: w, height: h });
      };
      im.onload = function () { done(im.naturalWidth, im.naturalHeight); };
      im.onerror = function () { done(0, 0); };
      im.src = dataUri;
    });
  }

  // Puts a past run back in the composer: its prompt, and for an edit its
  // photos in their original order with the same combine-or-each choice, so it
  // can be changed and run again without finding and attaching anything.
  async function reuseRun(run) {
    if (busy) return;
    closeLightbox();
    if (run.mode === 'edit' && sourceUrls(run).length) {
      var list;
      try { list = await sourceData(run); } catch (err) { photosGone(); return; }
      var loaded = await Promise.all(list.map(function (uri, i) {
        var ext = (/^data:image\/(\w+)/.exec(uri) || [0, 'png'])[1].replace('jpeg', 'jpg');
        return probe(uri, (i === 0 ? 'base' : 'photo-' + (i + 1)) + '.' + ext);
      }));
      state.sources = [];
      state.plan = run.plan === 'each' ? 'each' : 'reference';
      openChip = -1;
      addSources(loaded);
      clearError();
    }
    promptEl.value = run.prompt;
    autosize();
    renderAction();
    promptEl.focus();
    promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
  }

  // -------------------------------------------------------------------------
  // Lightbox. Opens on an image, not a slot: a run can have gaps where frames
  // failed, and the arrows move through what actually arrived.
  // -------------------------------------------------------------------------
  function openLightbox(run, image) {
    var list = doneImages(run);
    var pos = list.indexOf(image);
    if (pos === -1) return;
    lastFocused = document.activeElement;
    lightboxState = { run: run, list: list, index: pos };
    renderLightbox();
    lightbox.hidden = false;
    fitViewer();
    lbClose.focus();
    document.addEventListener('keydown', lightboxKeys, true);
  }

  function fact(label, value) {
    if (value == null || value === '') return;
    lbMeta.appendChild(el('dt', null, label));
    lbMeta.appendChild(el('dd', null, String(value)));
  }

  function paintLbFav(image) {
    var on = Boolean(image.favourite);
    lbFav.hidden = lbDelete.hidden = !isStored(image);
    lbFav.setAttribute('aria-pressed', String(on));
    var label = on ? 'In your library — remove' : 'Add to library';
    lbFav.setAttribute('aria-label', label);
    lbFav.title = on ? 'In your library. Click to remove.' : 'Add to library — kept for good, never cleared to make room';
  }

  function renderLightbox() {
    if (!lightboxState) return;
    var run = lightboxState.run;
    var image = lightboxState.list[lightboxState.index];
    if (!image) return;

    // Names the frame's own number against the run total, so a partial run
    // reads truthfully — "Frame 5 of 6" even when only three came back.
    lbCount.textContent = 'Frame ' + (image.frame || 1) + ' of ' + run.frames.length;
    lbImage.src = image.src;
    lbImage.alt = run.prompt;
    lbPrompt.textContent = image.revised_prompt || run.prompt;

    // The photos it was made from, base first.
    var photos = sourceUrls(run);
    lbSourcesBlock.hidden = !photos.length;
    lbSources.innerHTML = '';
    if (photos.length) {
      lbSourcesLabel.textContent = run.plan === 'each' && photos.length > 1
        ? 'Photos edited in this run' : photos.length > 1 ? 'Made from these photos' : 'Made from this photo';
      photos.forEach(function (u, i) {
        var box = el('div', 'lb-source');
        var t = document.createElement('img');
        t.src = u;
        t.alt = '';
        box.appendChild(t);
        if (photos.length > 1) box.appendChild(el('span', null, run.plan === 'each' ? String(i + 1) : i === 0 ? 'Base' : String(i + 1)));
        lbSources.appendChild(box);
      });
    }

    var p = priceEntry(run.model);
    var made = new Date(run.finishedAt || run.startedAt);
    var n = run.sourceCount || (run.sources ? run.sources.length : 0);
    lbMeta.innerHTML = '';
    fact('Model', p ? p.label : run.model);
    if (run.quality && acceptsQuality(run.model)) fact('Quality', run.quality.charAt(0).toUpperCase() + run.quality.slice(1));
    fact('Kind', run.mode !== 'edit' ? 'Generated' : run.plan === 'reference' && n > 1 ? 'Combined from ' + n + ' photos'
      : n > 1 ? 'One of ' + n + ' photos edited' : 'Edit of one photo');
    fact('Size', image.width ? image.width + ' × ' + image.height : (run.resolution || '1k').toUpperCase());
    if (run.shape && run.shape !== 'auto') fact('Shape', run.shape);
    if (run.degraded) fact('Note', 'Optional settings were dropped');
    var got = doneImages(run).length;
    fact('Run', got === run.frames.length ? got + (got === 1 ? ' image' : ' images') : got + ' of ' + run.frames.length + ' images');
    if (typeof run.cost === 'number' && run.cost > 0) fact('Run cost', (run.costEstimated ? '≈ ' : '') + money(run.cost));
    fact('Made', dayLabel(made.getTime()) + ' at ' + clockTime(made) +
      (run.restored || run.status === 'running' ? '' : ' · took ' + duration((run.finishedAt || Date.now()) - run.startedAt)));
    if (run.user) fact('By', run.user);

    lbReuse.textContent = reuseLabel(run);
    lbAgain.hidden = !canRunAgain(run);
    lbDownloadAll.hidden = got < 2;
    lbDownloadAll.textContent = 'Download all ' + got;
    lbEdit.title = 'Send this picture into the composer as a photo';
    lbAgain.title = 'Repeat this run exactly as it was';
    lbReuse.title = 'Put this back in the composer to change and run again';
    paintLbFav(image);
    var many = lightboxState.list.length > 1;
    lbPrev.hidden = lbNext.hidden = !many;
    viewerShow(run, image);
  }

  function stepLightbox(step) {
    if (!lightboxState) return;
    var n = lightboxState.list.length;
    lightboxState.index = (lightboxState.index + step + n) % n;
    renderLightbox();
  }

  function closeLightbox() {
    if (lightbox.hidden) return;
    lightbox.hidden = true;
    document.removeEventListener('keydown', lightboxKeys, true);
    var was = lightboxState;
    lightboxState = null;
    viewing = null;
    pointers = {};
    gesture = null;
    lbSide.classList.remove('is-open');
    // Focus returns to the picture that was open. The frame may have been
    // redrawn meanwhile (favouriting does that), so find it again by its place
    // in the run rather than trusting the old element.
    var back = lastFocused && document.contains(lastFocused) ? lastFocused : null;
    if (!back && was) {
      var image = was.list[was.index];
      var at = was.run.frames.findIndex(function (f) { return f.image === image; });
      back = results.querySelector('[data-frame-for="' + was.run.id + ':' + at + '"] .frame__button');
    }
    if (back) back.focus();
    lastFocused = null;
  }

  function trapTab(e, container) {
    var focusables = Array.prototype.slice.call(container.querySelectorAll('button:not([hidden]):not(:disabled)'));
    if (!focusables.length) return;
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function lightboxKeys(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); return; }
    // The divider is a slider: its arrows move it, not the run.
    if (document.activeElement === lbDivider && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      setSplit(view.split + (e.key === 'ArrowRight' ? 2 : -2));
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      var k = e.key.toLowerCase();
      if (k === '+' || k === '=') { e.preventDefault(); zoomBy(1.35); return; }
      if (k === '-' || k === '_') { e.preventDefault(); zoomBy(1 / 1.35); return; }
      if (k === '0') { e.preventDefault(); zoomTo(1); return; }
      if (k === 'b' && !lbCompareBtn.hidden) { e.preventDefault(); setCompare(!view.compare); return; }
      if (k === 'i') { e.preventDefault(); setWide(!lightbox.classList.contains('is-wide')); return; }
      if (k === 'f' && !lbFav.hidden) { e.preventDefault(); lbFav.click(); return; }
      if (k === 'd') { e.preventDefault(); lbDownload.click(); return; }
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); stepLightbox(e.key === 'ArrowRight' ? 1 : -1); return; }
    if (e.key === 'Tab') trapTab(e, lightbox);
  }

  lbClose.addEventListener('click', closeLightbox);
  lbPrev.addEventListener('click', function () { stepLightbox(-1); });
  lbNext.addEventListener('click', function () { stepLightbox(1); });
  // A click on the empty stage closes — but only a click, never the end of a
  // drag that began on the picture.
  var stageDownOn = null;
  lightbox.addEventListener('mousedown', function (e) { stageDownOn = e.target; });
  lightbox.addEventListener('click', function (e) {
    if (e.target !== stageDownOn) return;
    if (e.target === lightbox || e.target === lbStage) closeLightbox();
  });

  // -------------------------------------------------------------------------
  // The viewer's picture: fit, zoom, pan, compare, filmstrip
  // -------------------------------------------------------------------------
  var view = { s: 1, x: 0, y: 0, compare: false, split: 50 };
  var MAX_ZOOM = 8;

  // How much room the picture may take: the stage, less the bar above it and
  // the filmstrip below. Set as CSS variables the image's max size reads.
  function fitViewer() {
    if (lightbox.hidden) return;
    var strip = lbStrip.hidden ? 0 : 66;
    lbStage.style.setProperty('--lb-w', Math.max(120, lbStage.clientWidth - (lbPrev.hidden ? 24 : 124)) + 'px');
    lbStage.style.setProperty('--lb-h', Math.max(120, lbStage.clientHeight - 56 - strip) + 'px');
  }
  window.addEventListener('resize', fitViewer);

  function paintView(settle) {
    lbCanvas.classList.toggle('is-settling', Boolean(settle));
    lbCanvas.classList.toggle('is-zoomed', view.s > 1.001);
    lbCanvas.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.s + ')';
    lbZoomReset.textContent = Math.round(view.s * 100) + '%';
    lbZoomOut.disabled = view.s <= 1.001;
    lbZoomIn.disabled = view.s >= MAX_ZOOM - 0.001;
  }

  // Keep at least a good part of the picture on the stage.
  function clampPan() {
    var w = lbCanvas.offsetWidth * view.s, h = lbCanvas.offsetHeight * view.s;
    var mx = Math.max(0, (w - lbStage.clientWidth) / 2 + 60), my = Math.max(0, (h - lbStage.clientHeight) / 2 + 60);
    if (view.s <= 1.001) { view.x = 0; view.y = 0; return; }
    view.x = Math.max(-mx, Math.min(mx, view.x));
    view.y = Math.max(-my, Math.min(my, view.y));
  }

  // Zoom about a point on the stage (client coordinates), so what is under the
  // pointer stays under the pointer.
  function zoomTo(s, cx, cy, settle) {
    s = Math.max(1, Math.min(MAX_ZOOM, s));
    var r = lbStage.getBoundingClientRect();
    var px = (cx == null ? r.left + r.width / 2 : cx) - (r.left + r.width / 2);
    var py = (cy == null ? r.top + r.height / 2 : cy) - (r.top + r.height / 2);
    var k = s / view.s;
    view.x = px - (px - view.x) * k;
    view.y = py - (py - view.y) * k;
    view.s = s;
    clampPan();
    paintView(settle !== false);
  }
  function zoomBy(f, cx, cy, settle) { zoomTo(view.s * f, cx, cy, settle); }

  lbZoomIn.addEventListener('click', function () { zoomBy(1.5); });
  lbZoomOut.addEventListener('click', function () { zoomBy(1 / 1.5); });
  lbZoomReset.addEventListener('click', function () { zoomTo(1); });
  lbStage.addEventListener('wheel', function (e) {
    e.preventDefault();
    zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0022)), e.clientX, e.clientY, false);
  }, { passive: false });
  lbCanvas.addEventListener('dblclick', function (e) {
    if (view.s > 1.001) zoomTo(1); else zoomTo(2.5, e.clientX, e.clientY);
  });

  // One pointer pans (or, unzoomed on a touch screen, swipes); two pinch.
  var pointers = {}, gesture = null;
  function points() { return Object.keys(pointers).map(function (id) { return pointers[id]; }); }
  lbCanvas.addEventListener('pointerdown', function (e) {
    if (e.target === lbDivider || (e.pointerType === 'mouse' && e.button !== 0)) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    try { lbCanvas.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
    var p = points();
    if (p.length === 2) {
      gesture = { kind: 'pinch', d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), s: view.s };
    } else {
      gesture = { kind: view.s > 1.001 ? 'pan' : 'swipe', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, touch: e.pointerType !== 'mouse' };
      if (gesture.kind === 'pan') lbCanvas.classList.add('is-panning');
    }
  });
  lbCanvas.addEventListener('pointermove', function (e) {
    if (!pointers[e.pointerId] || !gesture) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var p = points();
    if (gesture.kind === 'pinch' && p.length === 2) {
      var d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      zoomTo(gesture.s * d / gesture.d, (p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2, false);
    } else if (gesture.kind === 'pan') {
      view.x = gesture.ox + (e.clientX - gesture.sx);
      view.y = gesture.oy + (e.clientY - gesture.sy);
      clampPan();
      paintView(false);
    } else if (gesture.kind === 'swipe' && gesture.touch) {
      // Follow the finger a little, so the swipe feels like it has hold of something.
      view.x = (e.clientX - gesture.sx) * 0.6;
      view.y = Math.max(0, e.clientY - gesture.sy) * 0.6;
      paintView(false);
    }
  });
  function endPointer(e) {
    if (!pointers[e.pointerId]) return;
    delete pointers[e.pointerId];
    lbCanvas.classList.remove('is-panning');
    var g = gesture;
    if (points().length) { gesture = null; return; }
    gesture = null;
    if (!g || g.kind !== 'swipe' || !g.touch) return;
    var dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    view.x = 0; view.y = 0;
    paintView(true);
    if (dy > 110 && Math.abs(dy) > Math.abs(dx)) closeLightbox();
    else if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) && lightboxState && lightboxState.list.length > 1) stepLightbox(dx < 0 ? 1 : -1);
  }
  lbCanvas.addEventListener('pointerup', endPointer);
  lbCanvas.addEventListener('pointercancel', endPointer);

  // Before and after. The photo an edit was made from is laid over the result
  // and clipped at the divider.
  function baseFor(run, image) {
    var photos = sourceUrls(run);
    if (!photos.length) return null;
    return run.plan === 'each' && photos.length > 1 ? (photos[(image.frame || 1) - 1] || null) : photos[0];
  }

  function setSplit(pct) {
    view.split = Math.max(0, Math.min(100, pct));
    lbCompare.style.clipPath = 'inset(0 ' + (100 - view.split) + '% 0 0)';
    lbDivider.style.left = view.split + '%';
    lbDivider.setAttribute('aria-valuenow', String(Math.round(view.split)));
  }

  function setCompare(on) {
    view.compare = Boolean(on) && !lbCompareBtn.hidden;
    lbCompareBtn.setAttribute('aria-pressed', String(view.compare));
    lbCompare.hidden = lbDivider.hidden = lbTagBefore.hidden = lbTagAfter.hidden = !view.compare;
    if (view.compare) setSplit(50);
  }
  lbCompareBtn.addEventListener('click', function () { setCompare(!view.compare); if (view.compare) lbDivider.focus(); });

  var dividing = false;
  lbDivider.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    e.stopPropagation();
    dividing = true;
    lbDivider.focus();
    try { lbDivider.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
  });
  lbDivider.addEventListener('pointermove', function (e) {
    if (!dividing) return;
    var r = lbCanvas.getBoundingClientRect();
    setSplit((e.clientX - r.left) / r.width * 100);
  });
  ['pointerup', 'pointercancel'].forEach(function (t) { lbDivider.addEventListener(t, function () { dividing = false; }); });

  function setWide(on) {
    lightbox.classList.toggle('is-wide', on);
    lbWide.setAttribute('aria-pressed', String(on));
    lbWide.setAttribute('aria-label', on ? 'Show the details card' : 'Hide the details card');
    fitViewer();
  }
  lbWide.addEventListener('click', function () { setWide(!lightbox.classList.contains('is-wide')); });

  lbSheet.addEventListener('click', function () {
    var open = !lbSide.classList.contains('is-open');
    lbSide.classList.toggle('is-open', open);
    lbSheet.setAttribute('aria-expanded', String(open));
    lbSheet.setAttribute('aria-label', open ? 'Hide details' : 'Show details');
    fitViewer();
  });

  function paintStrip() {
    var list = lightboxState.list;
    lbStrip.hidden = list.length < 2;
    lbStrip.innerHTML = '';
    if (lbStrip.hidden) return;
    list.forEach(function (im, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', 'Frame ' + (im.frame || i + 1));
      b.setAttribute('aria-current', String(i === lightboxState.index));
      var t = document.createElement('img');
      t.src = im.src;
      t.alt = '';
      b.appendChild(t);
      b.addEventListener('click', function () { lightboxState.index = i; renderLightbox(); });
      lbStrip.appendChild(b);
    });
    var cur = lbStrip.querySelector('[aria-current="true"]');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  // Called whenever the viewer shows a picture. A new picture starts fitted
  // and uncompared; the same picture redrawn (after favouriting, say) keeps
  // whatever zoom it had.
  var viewing = null;
  function viewerShow(run, image) {
    var base = baseFor(run, image);
    lbCompareBtn.hidden = lbCompareRule.hidden = !base;
    if (base && lbBase.getAttribute('src') !== base) lbBase.src = base;
    paintStrip();
    if (viewing !== image) {
      viewing = image;
      view.s = 1; view.x = 0; view.y = 0;
      setCompare(false);
    } else {
      setCompare(view.compare);
    }
    fitViewer();
    paintView(false);
  }

  lbCopy.addEventListener('click', function () {
    var text = lbPrompt.textContent;
    var done = function () { toast('Prompt copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { toast('This browser would not allow copying'); });
    else toast('This browser cannot copy from here');
  });

  // Pictures can only be put on the clipboard as PNG, so a JPEG is redrawn.
  lbCopyImage.addEventListener('click', async function () {
    if (!lightboxState) return;
    if (!navigator.clipboard || !window.ClipboardItem) { toast('This browser cannot copy pictures'); return; }
    try {
      var blob = await (await fetch(lightboxState.list[lightboxState.index].src)).blob();
      if (blob.type !== 'image/png') {
        var bmp = await createImageBitmap(blob);
        var cv = document.createElement('canvas');
        cv.width = bmp.width; cv.height = bmp.height;
        cv.getContext('2d').drawImage(bmp, 0, 0);
        blob = await new Promise(function (ok) { cv.toBlob(ok, 'image/png'); });
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Picture copied — paste it anywhere');
    } catch (err) {
      toast('The picture could not be copied');
    }
  });
  lbDownload.addEventListener('click', function () {
    if (lightboxState) downloadImage(lightboxState.run, lightboxState.list[lightboxState.index]);
  });
  lbEdit.addEventListener('click', function () {
    if (lightboxState) useAsReference(lightboxState.run, lightboxState.list[lightboxState.index]);
  });
  lbReuse.addEventListener('click', function () { if (lightboxState) reuseRun(lightboxState.run); });
  lbAgain.addEventListener('click', function () { if (lightboxState) again(lightboxState.run); });
  lbDownloadAll.addEventListener('click', function () { if (lightboxState) downloadRun(lightboxState.run); });
  lbFav.addEventListener('click', async function () {
    if (!lightboxState) return;
    var run = lightboxState.run, image = lightboxState.list[lightboxState.index];
    if (!(await toggleFavourite(image, !image.favourite))) return;
    paintLbFav(image);
    toast(image.favourite ? 'Added to your library' : 'Removed from your library');
    // The star on the frame behind, and the library wall, follow.
    if (state.filter === 'fav') renderRuns();
    else run.frames.forEach(function (f, i) { if (f.image === image) refreshFrame(run, i); });
  });
  lbDelete.appendChild(icon('trash', 16));
  lbDelete.title = 'Delete — you can undo for a few seconds';
  lbDelete.addEventListener('click', function () {
    if (!lightboxState) return;
    var image = lightboxState.list[lightboxState.index];
    closeLightbox();
    deleteImages([image.id]);
  });

  // -------------------------------------------------------------------------
  // Submitting a run
  // -------------------------------------------------------------------------
  function currentSettings() {
    var base = state.sources[0];
    var shape = currentShape();
    return {
      mode: mode(),
      model: state.model,
      prompt: promptEl.value.trim(),
      quality: acceptsQuality(state.model) ? state.quality : null,
      shape: shape,
      resolution: currentResolution(),
      n: currentCount(),
      // One photo is a combined edit of one — the same request shape, with the
      // singular field chosen by the server.
      plan: isEditEach() ? 'each' : 'reference',
      sources: state.sources.map(function (s) { return s.dataUri; }),
      // On an edit left at "as base" the result takes the first photo's shape,
      // so the placeholder can be drawn to it and nothing jumps on arrival.
      ratio: aspectRatioCss(shape) || (base && base.width && !isEditEach() ? base.width + ' / ' + base.height : null)
    };
  }

  function setBusy(on, label) {
    busy = on;
    promptEl.disabled = on;
    if (on) { closeMenu(false); closeHistory(); }
    actionBtn.disabled = on;
    actionBtn.classList.toggle('is-busy', on);
    cancelBtn.hidden = !on;
    if (on) { openChip = -1; closeMention(); setBusyLabel(label); }
    // Re-render the chips and pills so their controls follow the busy state —
    // pulling a photo out from under a run in flight would strand it.
    renderRail();
  }

  // Progress in the browser tab, so a run can be watched from another one.
  function paintTitle(run) {
    document.title = run && run.status === 'running'
      ? '(' + doneImages(run).length + '/' + run.frames.length + ') ' + studioName
      : studioName;
  }

  function notifyFinished(run) {
    if (!notifyEl.checked || !document.hidden || !window.Notification || Notification.permission !== 'granted') return;
    var got = doneImages(run).length;
    try {
      var n = new Notification(studioName, {
        body: run.cancelled ? 'Run cancelled.' : got === run.frames.length
          ? (got === 1 ? 'Your picture is ready.' : 'All ' + got + ' pictures are ready.')
          : got + ' of ' + run.frames.length + ' pictures arrived.',
        tag: 'imagine-run'
      });
      n.onclick = function () { window.focus(); n.close(); };
    } catch (err) { /* some browsers only allow this from a service worker */ }
  }

  function setBusyLabel(label) {
    actionBtn.innerHTML = '';
    actionBtn.appendChild(el('span', 'pulse'));
    actionBtn.appendChild(el('span', null, label));
  }

  // Frames are requested one at a time, so the button can name the one being
  // worked on rather than the batch.
  function busyLabelFor(run) {
    var total = run.frames.length;
    var at = Math.min(doneImages(run).length + 1, total);
    if (run.mode === 'edit') {
      if (run.plan === 'each' && total > 1) return 'Editing ' + at + ' of ' + total;
      var combining = run.sources && run.sources.length > 1;
      if (total === 1) return combining ? 'Combining' : 'Applying edit';
      return 'Variant ' + at + ' of ' + total;
    }
    return total === 1 ? 'Generating' : 'Frame ' + at + ' of ' + total;
  }

  // Ask xAI for one image per request rather than one request for many.
  //
  // Inside a single request xAI works through `n` images one after another, so
  // a six-frame batch shows nothing until the last is done — and at 2k a full
  // batch runs past the server's timeout, losing work that has almost certainly
  // been billed. One image per request keeps every call short, lets frames
  // appear as they land, and confines a failure to the frame it happened to.
  var FRAME_CONCURRENCY = 3;

  function requestOneFrame(run, index) {
    // The body is built in request-body.js, shared with the tests, so what is
    // sent for one photo, several combined, or several edited apart is checked
    // without a browser.
    var body = window.ImagineRequest.buildFrameBody(run, index, {
      user: state.name || '',
      consent: likenessConsent
    });
    var controller = new AbortController();
    run.controllers.push(controller);
    return fetch('/api/images', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      signal: controller.signal
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (payload) {
        return { ok: res.ok, status: res.status, payload: payload };
      });
    });
  }

  function applyFrameResult(run, index, result) {
    var frame = run.frames[index];
    if (frame.status === 'cancelled') return;

    if (!result.ok) {
      var payload = result.payload;
      if (result.status === 401 && payload && payload.code === 'unauthorized') {
        run.authFailed = true;
        frame.status = 'failed';
        frame.error = '';
        return;
      }
      if (payload && payload.code === 'rate_limited') run.rateLimit = payload.retryAfter || 30;
      var described = describeFailure(payload, result.status);
      frame.status = 'failed';
      // Two lines everywhere else; inside a frame there is only room for one.
      frame.error = described[1] + '.';
      run.lastFailure = described;
      refreshFrame(run, index);
      refreshRunCaption(run);
      return;
    }

    var item = (result.payload.images || [])[0];
    if (!item) {
      frame.status = 'failed';
      frame.error = 'Nothing came back for this frame.';
      refreshFrame(run, index);
      return;
    }

    var kind = item.b64 ? sniffImage(item.b64) : { mime: null, ext: 'png' };
    frame.image = {
      id: item.id || null,
      src: item.id ? '/api/image/' + item.id
        : (item.b64 ? 'data:' + kind.mime + ';base64,' + item.b64 : item.url),
      ext: kind.ext,
      bytes: item.b64 ? Math.round(item.b64.length * 0.75) : 0,
      width: 0, height: 0,    // filled in from the image itself once it loads
      frame: index + 1,
      favourite: false,
      revised_prompt: item.revised_prompt || null
    };
    frame.status = 'done';

    var cost = typeof result.payload.cost === 'number' ? result.payload.cost : 0;
    run.cost = (run.cost || 0) + cost;
    if (result.payload.costEstimated) run.costEstimated = true;
    // Money is spent the moment a frame arrives, so it is counted then. The run
    // itself is only counted once, on its first frame.
    addSpend(cost, !run.counted);
    run.counted = true;
    if (result.payload.degraded) run.degraded = true;

    refreshFrame(run, index);
    refreshRunCaption(run);
    if (busy) setBusyLabel(busyLabelFor(run));
    paintTitle(run);
  }

  function cancelRun(run) {
    if (!run || run.status !== 'running') return;
    run.cancelled = true;
    run.frames.forEach(function (f) { if (f.status === 'queued') f.status = 'cancelled'; });
    run.controllers.forEach(function (c) { try { c.abort(); } catch (err) { /* already settled */ } });
  }

  async function submitRun(settings) {
    if (busy) return;
    if (Date.now() < rateLimitUntil) return;
    rememberPrompt(settings.prompt);
    prompts = null;   // the library has a new entry, or a new use: read it afresh

    // Editing each of several photos is one request per photo; everything else
    // — generation, one photo, photos combined — is one per frame asked for.
    var total = settings.mode === 'edit' && settings.plan === 'each'
      ? Math.max(1, settings.sources.length)
      : Math.max(1, settings.n || 1);
    var frames = [];
    for (var i = 0; i < total; i++) frames.push({ status: 'queued', image: null, error: null });

    var run = {
      id: 'run-' + (++seq) + '-' + Date.now().toString(36),
      mode: settings.mode, model: settings.model, prompt: settings.prompt,
      quality: settings.quality, shape: settings.shape, resolution: settings.resolution,
      n: total, plan: settings.plan || 'reference', sources: settings.sources || [],
      ratio: settings.ratio || null, user: state.name.trim() || null,
      frames: frames, controllers: [], status: 'running',
      startedAt: Date.now(), finishedAt: null,
      cost: 0, costEstimated: false, counted: false, cancelled: false, degraded: false
    };

    clearError();
    // A new run is always shown, whatever the gallery was filtered to.
    if (state.filter !== 'all' && !(state.filter === 'mine' && run.user)) setFilter('all');
    runs.unshift(run);
    renderRuns();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (runTimer) clearInterval(runTimer);
    runTimer = setInterval(tickElapsed, 1000);

    activeRun = run;
    setBusy(true, busyLabelFor(run));
    paintTitle(run);

    var next = 0;
    async function worker() {
      while (true) {
        if (run.cancelled) return;
        var index = next++;
        if (index >= total) return;
        var frame = run.frames[index];
        if (frame.status === 'cancelled') continue;
        frame.status = 'running';
        refreshFrame(run, index);
        try {
          applyFrameResult(run, index, await requestOneFrame(run, index));
        } catch (err) {
          if (run.cancelled || (err && err.name === 'AbortError')) {
            frame.status = 'cancelled';
          } else {
            frame.status = 'failed';
            frame.error = 'Could not reach the studio server.';
            run.reachFailed = true;
          }
          refreshFrame(run, index);
        }
      }
    }

    var pool = [];
    for (var w = 0; w < Math.min(FRAME_CONCURRENCY, total); w++) pool.push(worker());

    try {
      await Promise.all(pool);
    } finally {
      run.status = run.cancelled ? 'cancelled' : 'done';
      run.finishedAt = Date.now();
      activeRun = null;
      // Restore the button in a finally, so a failure never leaves it stuck.
      setBusy(false);
      paintTitle(null);
      notifyFinished(run);
      refreshBalance();
      if (runTimer && !runs.some(function (r) { return r.status === 'running'; })) {
        clearInterval(runTimer);
        runTimer = null;
      }
    }

    var got = doneImages(run).length;

    // Every frame failed: there is nothing to show, so the row goes and the
    // error sits above the composer.
    if (got === 0 && !run.cancelled) {
      runs = runs.filter(function (r) { return r !== run; });
      renderRuns();
      if (run.authFailed) { lockOut(); return; }
      if (run.reachFailed) {
        showError('Could not reach the studio server',
          'The request to this app’s own server failed. Check the server is still running, then retry. Nothing was charged.', 'danger');
      } else if (run.lastFailure) {
        showError(run.lastFailure[1], run.lastFailure[2], run.lastFailure[0]);
      }
      if (run.rateLimit) startRateLimit(run.rateLimit);
      return;
    }

    renderRuns();

    if (run.cancelled) {
      showError('Run cancelled',
        got > 0
          ? 'Stopped after ' + got + ' of ' + run.frames.length + ' frames. You were charged ' +
            money(run.cost) + ' for the ' + (got === 1 ? 'one that arrived' : got + ' that arrived') + '.'
          : 'Stopped before any frame arrived, so nothing was charged.',
        'warning');
      return;
    }
    if (got < run.frames.length) {
      showError('Some frames did not arrive',
        got + ' of ' + run.frames.length + ' came back. Use Try again on a failed frame to retry just that one. You were charged ' +
        money(run.cost) + ' for what arrived.', 'warning');
      if (run.rateLimit) startRateLimit(run.rateLimit);
      return;
    }
    if (run.degraded) {
      showError('Run completed with fewer settings',
        'xAI would not accept one of the optional settings, so it was retried with just the prompt. Shape, size and quality were dropped for this run.',
        'warning');
    }
  }

  // Retry one failed frame in place, without re-running the whole run.
  async function retryFrame(run, index) {
    if (busy) return;
    var frame = run.frames[index];
    if (!frame || frame.status === 'done') return;
    run.controllers = [];
    run.cancelled = false;
    run.status = 'running';
    frame.status = 'running';
    frame.error = null;
    refreshFrame(run, index);

    activeRun = run;
    setBusy(true, 'Retrying frame ' + (index + 1));
    try {
      applyFrameResult(run, index, await requestOneFrame(run, index));
    } catch (err) {
      frame.status = 'failed';
      frame.error = 'Could not reach the studio server.';
      refreshFrame(run, index);
    } finally {
      run.status = 'done';
      run.finishedAt = Date.now();
      activeRun = null;
      setBusy(false);
      renderRuns();
    }
  }

  // -------------------------------------------------------------------------
  // Likeness permission. Combining photos carries a real person's face into
  // another picture, so it is confirmed once a session, before the first such
  // run. The server refuses a combined edit that does not carry it.
  // -------------------------------------------------------------------------
  var consentThen = null;

  function askConsent(then) {
    consentThen = then;
    lastFocused = document.activeElement;
    consentDialog.hidden = false;
    consentCancel.focus();
    document.addEventListener('keydown', consentKeys, true);
  }

  function closeConsent(agreed) {
    consentDialog.hidden = true;
    document.removeEventListener('keydown', consentKeys, true);
    var then = consentThen;
    consentThen = null;
    if (agreed) { likenessConsent = true; if (then) then(); return; }
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  }

  function consentKeys(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeConsent(false); }
    else if (e.key === 'Tab') trapTab(e, consentDialog);
  }

  consentOk.addEventListener('click', function () { closeConsent(true); });
  consentCancel.addEventListener('click', function () { closeConsent(false); });
  consentDialog.addEventListener('mousedown', function (e) { if (e.target === consentDialog) closeConsent(false); });

  rail.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy || Date.now() < rateLimitUntil || !config || !config.hasKey) return;
    var reason = blockingReason();
    if (reason) {
      // The button is never silently dead: say what is missing, in place.
      attention = reason;
      renderAction();
      promptEl.focus();
      return;
    }
    var settings = currentSettings();
    var go = function () { submitRun(settings); };
    if (settings.mode === 'edit' && settings.plan === 'reference' && settings.sources.length > 1 && !likenessConsent) {
      askConsent(go);
      return;
    }
    go();
  });

  // Ctrl/Cmd + Enter fires the button from anywhere in the composer.
  rail.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!actionBtn.disabled) rail.requestSubmit();
    }
  });

  cancelBtn.addEventListener('click', function () { if (activeRun) cancelRun(activeRun); });

  // -------------------------------------------------------------------------
  // Adding photos: the + tile, a drop anywhere on the page, or a paste
  // -------------------------------------------------------------------------
  function fileKind(file) {
    if (file.type && file.type.indexOf('image/') === 0) return file.type.split('/')[1].toUpperCase();
    if (file.type) return file.type.split('/').pop().toUpperCase();
    var dot = file.name.lastIndexOf('.');
    return dot === -1 ? 'file' : file.name.slice(dot + 1).toUpperCase();
  }

  function readOneFile(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () {
        var dataUri = String(reader.result);
        var probe = new Image();
        var done = function (w, h) {
          resolve({ dataUri: dataUri, original: dataUri, originalSize: file.size, crop: null,
                    name: file.name || 'pasted image', size: file.size, width: w, height: h });
        };
        probe.onload = function () { done(probe.naturalWidth, probe.naturalHeight); };
        probe.onerror = function () { done(0, 0); };
        probe.src = dataUri;
      };
      reader.onerror = function () { resolve(null); };
      reader.readAsDataURL(file);
    });
  }

  // The moment a second photo lands, the settings that transferred a likeness
  // best become the defaults: Imagine 2.0 at 2K. Only on that crossing — a
  // choice made afterwards stands.
  function adoptReferenceDefaults() {
    var prices = config && config.prices ? config.prices : {};
    var preferred = 'grok-imagine-image-2.0';
    if (prices[preferred] && !modelIsRetired(preferred)) {
      state.model = preferred;
      retiredFallback = null;
      buildModelOptions();
    }
    state.editResolution = '2k';
  }

  function addSources(list) {
    var before = state.sources.length;
    list.forEach(function (src) { if (src && state.sources.length < MAX_SOURCES) state.sources.push(src); });
    if (before < 2 && state.sources.length >= 2 && state.plan === 'reference') adoptReferenceDefaults();
    renderRail();
  }

  // Takes whatever was dropped, chosen or pasted, keeps the usable photos and
  // explains the first thing it had to turn away. Already-attached photos are
  // never lost to a bad file in the same batch.
  async function takeFiles(fileList) {
    if (busy) return;
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    var room = MAX_SOURCES - state.sources.length;
    var rejected = null;
    if (room <= 0) {
      showError('That is already ' + MAX_SOURCES + ' photos',
        'Ten is the most in one run. Remove one to add another, or run these first.', 'warning');
      return;
    }
    var accepted = [];
    files.forEach(function (f) {
      if (ACCEPTED_TYPES.indexOf(f.type) === -1) {
        rejected = rejected || ['That file is a ' + fileKind(f), 'Photos need to be JPG, PNG or WebP.'];
      } else if (f.size > MAX_UPLOAD_BYTES) {
        rejected = rejected || ['That photo is ' + bytes(f.size),
          'The limit is 10 MB. Export it smaller, or scale it to 2048px on the long edge and add it again.'];
      } else if (accepted.length >= room) {
        rejected = rejected || ['That is more than ' + MAX_SOURCES + ' photos', 'Ten is the most in one run, so the rest were left out.'];
      } else accepted.push(f);
    });

    var loaded = await Promise.all(accepted.map(readOneFile));
    if (loaded.some(function (s) { return !s; }) && !rejected) {
      rejected = ['A photo could not be read', 'The file may be damaged. Try exporting it again, then add it here.'];
    }
    addSources(loaded.filter(Boolean));
    if (rejected) showError(rejected[0], rejected[1], 'warning'); else clearError();
    promptEl.focus();
  }

  addBtn.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files.length) takeFiles(fileInput.files);
    fileInput.value = '';
  });

  function dragHasFiles(e) {
    var t = e.dataTransfer && e.dataTransfer.types;
    return Boolean(t) && Array.prototype.indexOf.call(t, 'Files') !== -1;
  }
  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) {
    if (!dragHasFiles(e) || app.hidden || busy) return;
    e.preventDefault();
    dragDepth++;
    dropveil.hidden = false;
    rail.classList.add('is-over');
  });
  window.addEventListener('dragover', function (e) { if (dragHasFiles(e) && !app.hidden) e.preventDefault(); });
  function endDrag() { dragDepth = 0; dropveil.hidden = true; rail.classList.remove('is-over'); }
  window.addEventListener('dragleave', function (e) {
    if (!dragHasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) endDrag();
  });
  window.addEventListener('drop', function (e) {
    if (!dragHasFiles(e) || app.hidden) return;
    e.preventDefault();
    endDrag();
    if (e.dataTransfer.files && e.dataTransfer.files.length) takeFiles(e.dataTransfer.files);
  });

  // A pasted screenshot or copied image is a photo like any other. Pasted text
  // is left alone to land in whatever field has the caret.
  document.addEventListener('paste', function (e) {
    if (app.hidden || !e.clipboardData) return;
    var files = Array.prototype.filter.call(e.clipboardData.files || [], function (f) {
      return f.type && f.type.indexOf('image/') === 0;
    });
    if (!files.length) return;
    e.preventDefault();
    takeFiles(files);
  });

  // -------------------------------------------------------------------------
  // Two or more photos: combine into one, or edit each
  // -------------------------------------------------------------------------
  function setPlan(plan) {
    if (busy) return;
    state.plan = plan === 'each' ? 'each' : 'reference';
    openChip = -1;
    renderRail();
  }
  [planReference, planEach].forEach(function (btn) {
    btn.addEventListener('click', function () { setPlan(btn.dataset.plan); btn.focus(); });
  });
  planSwitch.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    var next = state.plan === 'reference' ? 'each' : 'reference';
    setPlan(next);
    (next === 'reference' ? planReference : planEach).focus();
  });

  // -------------------------------------------------------------------------
  // @ in the prompt offers the attached photos. It inserts plain words —
  // "photo 2" — because that is what the model reads.
  // -------------------------------------------------------------------------
  function closeMention() {
    mention = null;
    mentionMenu.hidden = true;
    mentionMenu.innerHTML = '';
    promptEl.removeAttribute('aria-activedescendant');
  }

  function updateMention() {
    if (busy || !state.sources.length) { closeMention(); return; }
    var caret = promptEl.selectionStart;
    var m = /(^|\s)@([\w ]{0,8})$/.exec(promptEl.value.slice(0, caret));
    if (!m) { closeMention(); return; }
    var typed = m[2].toLowerCase().replace(/\s+/g, ' ');
    var items = state.sources.map(function (src, i) {
      return { index: i, word: 'photo ' + (i + 1), src: src };
    }).filter(function (it) {
      return !typed || it.word.indexOf(typed) === 0 || String(it.index + 1) === typed.trim();
    });
    if (!items.length) { closeMention(); return; }
    mention = { start: caret - m[2].length - 1, items: items, index: Math.min(mention ? mention.index : 0, items.length - 1) };
    openChip = -1;
    renderChipPanel();
    renderSource();
    paintMention();
  }

  function paintMention() {
    mentionMenu.innerHTML = '';
    mentionMenu.hidden = false;
    mention.items.forEach(function (it, n) {
      var row = el('button', 'mention');
      row.type = 'button';
      row.id = 'mention-' + n;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(n === mention.index));
      row.tabIndex = -1;
      var img = document.createElement('img');
      img.src = it.src.dataUri;
      img.alt = '';
      row.appendChild(img);
      row.appendChild(el('span', null, it.word));
      if (isReference() && it.index === 0) row.appendChild(el('span', 'mention__sub', 'the base'));
      // mousedown, not click: the textarea must not lose its caret first.
      row.addEventListener('mousedown', function (e) { e.preventDefault(); pickMention(n); });
      mentionMenu.appendChild(row);
    });
    promptEl.setAttribute('aria-activedescendant', 'mention-' + mention.index);
  }

  function pickMention(n) {
    if (!mention) return;
    var it = mention.items[n];
    var caret = promptEl.selectionStart;
    var before = promptEl.value.slice(0, mention.start), after = promptEl.value.slice(caret);
    var insert = it.word + (/^\s/.test(after) ? '' : ' ');
    promptEl.value = before + insert + after;
    var pos = (before + insert).length;
    closeMention();
    promptEl.focus();
    promptEl.setSelectionRange(pos, pos);
    autosize();
    renderAction();
  }

  promptEl.addEventListener('keydown', function (e) {
    if (!mention) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      var n = mention.items.length;
      mention.index = (mention.index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      paintMention();
    } else if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
      e.preventDefault();
      pickMention(mention.index);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMention();
    }
  });
  promptEl.addEventListener('blur', function () { setTimeout(closeMention, 120); });
  promptEl.addEventListener('click', updateMention);

  // -------------------------------------------------------------------------
  // Composer wiring
  // -------------------------------------------------------------------------
  promptEl.addEventListener('input', function () {
    // Text in the box means it is in use, however it got there.
    renderIdle();
    autosize();
    updateMention();
    renderAction();
  });

  promptEl.addEventListener('scroll', function () { promptBack.scrollTop = promptEl.scrollTop; });

  // The composer opens the moment it is touched and rests again once left
  // empty. focusout fires before the new focus lands, hence the short wait.
  dock.addEventListener('focusin', renderIdle);
  dock.addEventListener('focusout', function () { setTimeout(renderIdle, 60); });
  rail.addEventListener('click', function (e) {
    if (rail.classList.contains('is-idle') && e.target !== addBtn && !addBtn.contains(e.target)) promptEl.focus();
  });

  // -------------------------------------------------------------------------
  // Recent prompts. The up arrow in an empty prompt brings back what was asked
  // for before — the last twenty, kept in this browser.
  // -------------------------------------------------------------------------
  var historyAt = -1;
  function rememberPrompt(text) {
    var t = String(text || '').trim();
    if (!t) return;
    var list = (readStore(PROMPTS_KEY) || []).filter(function (p) { return p !== t; });
    list.unshift(t);
    writeStore(PROMPTS_KEY, list.slice(0, 20));
  }

  function closeHistory() {
    historyAt = -1;
    historyMenu.hidden = true;
    historyMenu.innerHTML = '';
  }

  function paintHistory() {
    var list = readStore(PROMPTS_KEY) || [];
    historyMenu.innerHTML = '';
    if (!list.length) { closeHistory(); return; }
    historyMenu.hidden = false;
    historyMenu.appendChild(el('div', 'pillmenu__title', 'Recent prompts'));
    list.slice(0, 8).forEach(function (text, n) {
      var row = el('button', 'mention', text);
      row.type = 'button';
      row.tabIndex = -1;
      row.title = text;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(n === historyAt));
      row.addEventListener('mousedown', function (e) { e.preventDefault(); pickHistory(n); });
      historyMenu.appendChild(row);
    });
  }

  function pickHistory(n) {
    var list = readStore(PROMPTS_KEY) || [];
    if (!list[n]) return;
    promptEl.value = list[n];
    closeHistory();
    autosize();
    renderAction();
    promptEl.focus();
    promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
  }

  promptEl.addEventListener('keydown', function (e) {
    if (mention) return;
    var open = !historyMenu.hidden;
    var max = Math.min(8, (readStore(PROMPTS_KEY) || []).length);
    if (e.key === 'ArrowUp' && (open || !promptEl.value)) {
      if (!max) return;
      e.preventDefault();
      historyAt = open ? (historyAt <= 0 ? max - 1 : historyAt - 1) : 0;
      paintHistory();
    } else if (open && e.key === 'ArrowDown') {
      e.preventDefault();
      historyAt = (historyAt + 1) % max;
      paintHistory();
    } else if (open && (e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      pickHistory(Math.max(0, historyAt));
    } else if (open && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeHistory();
    } else if (open && e.key.length === 1) {
      closeHistory();
    }
  });
  promptEl.addEventListener('blur', function () { setTimeout(closeHistory, 120); });

  function setCount(n) {
    n = Math.min(maxCount(), Math.max(1, n));
    if (mode() === 'edit') state.variants = n; else state.frames = n;
    renderRail();
  }
  framesMinus.addEventListener('click', function () { setCount(currentCount() - 1); if (framesMinus.disabled) framesPlus.focus(); });
  framesPlus.addEventListener('click', function () { setCount(currentCount() + 1); if (framesPlus.disabled) framesMinus.focus(); });

  Array.prototype.slice.call(document.querySelectorAll('.seed')).forEach(function (btn) {
    btn.addEventListener('click', function () {
      promptEl.value = btn.dataset.seed;
      autosize();
      renderAction();
      promptEl.focus();
      promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
    });
  });

  // Escape closes whichever panel is open above the composer.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !lightbox.hidden || !consentDialog.hidden) return;
    if (openChip >= 0) { e.preventDefault(); closeChipPanel(true); }
    else if (!whoPop.hidden) { e.preventDefault(); closeWho(true); }
  });

  // A narrower window wraps the prompt differently; measure it again.
  window.addEventListener('resize', autosize);

  // The gallery keeps clear of the dock, however tall it has grown.
  if (window.ResizeObserver) {
    new ResizeObserver(function () {
      document.documentElement.style.setProperty('--dock-h', dock.offsetHeight + 'px');
    }).observe(dock);
  }

  // -------------------------------------------------------------------------
  // Top bar: filters, name, appearance
  // -------------------------------------------------------------------------
  function setFilter(f) {
    state.filter = f === 'fav' || f === 'mine' || f === 'assets' ? f : 'all';
    // Prompts has its own address, so it can be bookmarked and sent to someone.
    var want = state.filter === 'assets' ? '/asset' : '/';
    if (location.pathname !== want) { try { history.replaceState(null, '', want); } catch (err) { /* file:// */ } }
    if (state.filter === 'assets' && prompts !== null) loadPrompts();   // fresh each visit
    Array.prototype.slice.call(filtersEl.querySelectorAll('.seg__btn')).forEach(function (b) {
      var on = b.dataset.filter === state.filter;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    persist();
    renderRuns();
    if (state.filter === 'fav' && !libraryLoaded) loadLibrary();
  }

  function wireRadioKeys(group, attr, apply) {
    group.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var btns = Array.prototype.slice.call(group.querySelectorAll('.seg__btn'));
      var at = btns.findIndex(function (b) { return b.getAttribute('aria-checked') === 'true'; });
      var next = btns[(at + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
      apply(next.dataset[attr]);
      next.focus();
    });
    Array.prototype.slice.call(group.querySelectorAll('.seg__btn')).forEach(function (b) {
      b.addEventListener('click', function () { apply(b.dataset[attr]); });
    });
  }
  wireRadioKeys(filtersEl, 'filter', setFilter);

  thumbEl.addEventListener('input', function () {
    state.thumb = Math.min(5, Math.max(1, Number(thumbEl.value) || 3));
    applyThumb();
    persist();
  });

  function setTheme(t) {
    var theme = t === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    writeStore(THEME_KEY, theme);
    Array.prototype.slice.call(themeEl.querySelectorAll('.seg__btn')).forEach(function (b) {
      var on = b.dataset.themeChoice === theme;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }
  wireRadioKeys(themeEl, 'themeChoice', setTheme);

  // -------------------------------------------------------------------------
  // What's new. /whats-new.json lists each update, newest first. A few seconds
  // after signing in, anyone who has not seen the latest is shown it — once.
  // -------------------------------------------------------------------------
  var news = [];

  function paintNews(entries) {
    newsBody.innerHTML = '';
    entries.forEach(function (rel, n) {
      if (n > 0) newsBody.appendChild(el('div', 'news__earlier num', 'Earlier — ' + rel.title + (rel.date ? ', ' + rel.date : '')));
      (rel.items || []).forEach(function (it) {
        var row = el('div', 'news__item');
        row.appendChild(el('span', 'news__dot'));
        row.appendChild(el('b', null, it.title));
        row.appendChild(el('p', null, it.body));
        newsBody.appendChild(row);
      });
    });
    newsTitle.textContent = entries[0].title || 'What’s new';
    newsDate.textContent = 'What’s new' + (entries[0].date ? ' · ' + entries[0].date : '');
  }

  function openNews(entries) {
    if (!entries.length || !newsDialog.hidden) return;
    closeWho(false);
    paintNews(entries);
    lastFocused = document.activeElement;
    newsDialog.hidden = false;
    newsBody.scrollTop = 0;
    newsOk.focus();
  }

  function closeNews() {
    if (newsDialog.hidden) return;
    newsDialog.hidden = true;
    if (news.length) writeStore(NEWS_KEY, news[0].id);
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  }

  async function checkNews() {
    try {
      var res = await fetch('/whats-new.json', { cache: 'no-cache' });
      if (!res.ok) return;
      var list = await res.json();
      news = Array.isArray(list) ? list.filter(function (r) { return r && r.id && Array.isArray(r.items); }) : [];
    } catch (err) { return; }
    if (!news.length) return;
    var seen = readStore(NEWS_KEY);
    if (seen === news[0].id) return;
    // Everything since the one they last saw; for a first visit, just the latest.
    var at = news.findIndex(function (r) { return r.id === seen; });
    var unseen = at === -1 ? news.slice(0, 1) : news.slice(0, at);
    // A few seconds in, once the page has settled — and never on top of
    // something else that is open, or while a run is going.
    setTimeout(function wait() {
      if (app.hidden) return;
      if (busy || !lightbox.hidden || !consentDialog.hidden || !keysDialog.hidden) { setTimeout(wait, 4000); return; }
      openNews(unseen);
    }, 2500);
  }

  newsOk.addEventListener('click', closeNews);
  newsClose.addEventListener('click', closeNews);
  newsDialog.addEventListener('mousedown', function (e) { if (e.target === newsDialog) closeNews(); });
  newsOpen.addEventListener('click', function () { if (news.length) openNews(news); else toast('Nothing new to show yet'); });
  document.addEventListener('keydown', function (e) {
    if (newsDialog.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeNews(); }
    else if (e.key === 'Tab') trapTab(e, newsDialog);
  }, true);

  function setAccent(name) {
    var ok = ['coral', 'amber', 'green', 'blue', 'violet'];
    var accent = ok.indexOf(name) === -1 ? 'coral' : name;
    if (accent === 'coral') document.documentElement.removeAttribute('data-accent');
    else document.documentElement.setAttribute('data-accent', accent);
    writeStore(ACCENT_KEY, accent);
    Array.prototype.slice.call(accentEl.querySelectorAll('.swatch')).forEach(function (b) {
      var on = b.dataset.accentChoice === accent;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }
  Array.prototype.slice.call(accentEl.querySelectorAll('.swatch')).forEach(function (b) {
    b.addEventListener('click', function () { setAccent(b.dataset.accentChoice); });
  });
  accentEl.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    var btns = Array.prototype.slice.call(accentEl.querySelectorAll('.swatch'));
    var at = btns.findIndex(function (b) { return b.getAttribute('aria-checked') === 'true'; });
    var next = btns[(at + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
    setAccent(next.dataset.accentChoice);
    next.focus();
  });

  // Off unless asked for. The browser's own permission prompt appears the
  // first time it is switched on; a refusal switches it back off and says so.
  notifyEl.addEventListener('change', async function () {
    if (!notifyEl.checked) { writeStore(NOTIFY_KEY, false); return; }
    if (!window.Notification) {
      notifyEl.checked = false;
      toast('This browser has no desktop notifications');
      return;
    }
    var perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (perm !== 'granted') {
      notifyEl.checked = false;
      toast('Notifications are blocked for this site in the browser');
    }
    writeStore(NOTIFY_KEY, notifyEl.checked);
  });

  // The list of shortcuts. ? opens it; / goes to the prompt. Neither fires
  // while something is being typed.
  function typing() {
    var n = document.activeElement;
    return Boolean(n) && (n.tagName === 'TEXTAREA' || n.tagName === 'SELECT' || (n.tagName === 'INPUT' && n.type !== 'checkbox' && n.type !== 'range') || n.isContentEditable);
  }
  function openKeys() {
    if (!keysDialog.hidden) return;
    closeWho(false);
    lastFocused = document.activeElement;
    keysDialog.hidden = false;
    keysClose.focus();
  }
  function closeKeys() {
    if (keysDialog.hidden) return;
    keysDialog.hidden = true;
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  }
  keysOpen.addEventListener('click', openKeys);
  keysClose.addEventListener('click', closeKeys);
  keysDialog.addEventListener('mousedown', function (e) { if (e.target === keysDialog) closeKeys(); });
  document.addEventListener('keydown', function (e) {
    if (!keysDialog.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeKeys(); }
      else if (e.key === 'Tab') trapTab(e, keysDialog);
      return;
    }
    if (app.hidden || typing() || e.ctrlKey || e.metaKey || e.altKey || !consentDialog.hidden || !newsDialog.hidden) return;
    if (e.key === '?') { e.preventDefault(); openKeys(); }
    else if (e.key === '/' && lightbox.hidden) { e.preventDefault(); promptEl.focus(); }
  }, true);

  function renderAvatar() {
    whoBtn.innerHTML = '';
    var ini = initials(state.name);
    if (ini) whoBtn.textContent = ini; else whoBtn.appendChild(icon('user', 16));
    whoBtn.title = state.name.trim() ? 'Working as ' + state.name.trim() : 'Add your name';
  }

  function closeWho(refocus) {
    whoPop.hidden = true;
    whoBtn.setAttribute('aria-expanded', 'false');
    if (refocus) whoBtn.focus();
  }
  whoBtn.addEventListener('click', function () {
    var open = whoPop.hidden;
    whoPop.hidden = !open;
    whoBtn.setAttribute('aria-expanded', String(open));
    if (open) userName.focus();
  });
  document.addEventListener('mousedown', function (e) {
    if (!whoPop.hidden && !whoPop.contains(e.target) && !whoBtn.contains(e.target)) closeWho(false);
  });
  userName.addEventListener('input', function () {
    state.name = userName.value;
    renderAvatar();
    persist();
    if (state.filter === 'mine') renderRuns();
  });
  userName.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); closeWho(true); } });

  // The retirement count is re-read on window focus, never left stale.
  window.addEventListener('focus', function () {
    if (!config) return;
    buildModelOptions();
    renderRetirement();
    renderSpend();
    refreshBalance();
  });

  // -------------------------------------------------------------------------
  // Password gate
  // -------------------------------------------------------------------------
  function lockOut() {
    password = '';
    try { localStorage.removeItem(PASS_KEY); } catch (err) { /* ignore */ }
    app.hidden = true;
    gate.hidden = false;
    gateError.hidden = false;
    gateError.textContent = 'That password is no longer accepted. Enter it again.';
    gatePassword.value = '';
    gatePassword.focus();
  }

  async function tryPassword(candidate) {
    var res = await fetch('/api/usage', { headers: candidate ? { 'x-team-password': candidate } : {} });
    return res.ok;
  }

  // Reveal control. Keeping focus in the field means the caret does not jump.
  gateToggle.addEventListener('click', function () {
    var showing = gatePassword.type === 'text';
    var end = gatePassword.value.length;
    gatePassword.type = showing ? 'password' : 'text';
    gateToggle.setAttribute('aria-pressed', String(!showing));
    gateToggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    gateToggle.title = showing ? 'Show password' : 'Hide password';
    gatePassword.focus();
    try { gatePassword.setSelectionRange(end, end); } catch (err) { /* not supported while type=password */ }
  });

  // Never leave a password on screen once the gate is done with.
  function hidePassword() {
    if (gatePassword.type !== 'text') return;
    gatePassword.type = 'password';
    gateToggle.setAttribute('aria-pressed', 'false');
    gateToggle.setAttribute('aria-label', 'Show password');
    gateToggle.title = 'Show password';
  }

  gatePassword.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !gateSubmit.disabled) { e.preventDefault(); gateForm.requestSubmit(); }
  });

  gateForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var candidate = gatePassword.value;
    gateSubmit.disabled = true;
    gateSubmit.textContent = 'Checking';
    try {
      if (!(await tryPassword(candidate))) {
        gatePassword.classList.add('is-error');   // the field keeps its value
        gateError.hidden = false;
        gateError.textContent = 'Password not recognised. Check for a trailing space, then try again.';
        gatePassword.focus();
        return;
      }
      password = candidate;
      writeStore(PASS_KEY, candidate);
      hidePassword();
      gatePassword.classList.remove('is-error');
      gateError.hidden = true;
      enterStudio();
    } catch (err) {
      gateError.hidden = false;
      gateError.textContent = 'Could not reach the studio server. Check it is still running, then try again.';
    } finally {
      gateSubmit.disabled = false;
      gateSubmit.textContent = 'Unlock studio';
    }
  });

  function enterStudio() {
    gate.hidden = true;
    app.hidden = false;
    renderRail();
    autosize();
    promptEl.focus();
    loadSavedRuns();
    refreshBalance();
    checkNews();
    // The server knows when its disk is replaced on every deploy. Say so here,
    // where the people whose work it is will see it, not only in a deploy log.
    if (config.storageEphemeral) {
      showError('Results here will not survive the next update',
        'The server has no permanent storage attached, so saved images and favourites are wiped each time the app is redeployed. Download anything you need to keep, and ask whoever runs the server to attach a volume — the README says how.',
        'warning');
    }
  }

  // Runs saved by the server, rebuilt into the same shape a live run has so the
  // rest of the app cannot tell the difference.
  async function loadSavedRuns() {
    if (!config || !config.savesImages) return;
    historyLoading = true;
    renderRuns();
    try {
      var res = await fetch('/api/runs?limit=' + PAGE, { headers: authHeaders({}) });
      if (!res.ok) return;
      var list = (await res.json()).runs || [];
      historyDone = list.length < PAGE;
      // Anything made in this tab stays on top of what was restored.
      takeRestored(list);
    } catch (err) {
      // The gallery simply stays empty; nothing here is worth an error.
    } finally {
      historyLoading = false;
      renderRuns();
    }
  }

  function restoreRun(r) {
        var frames = r.images.map(function (img) {
          return { status: 'done', error: null, image: {
            id: img.id, src: '/api/image/' + img.id, ext: (img.id.split('.').pop() || 'png'),
            bytes: 0, width: 0, height: 0, frame: img.frame,
            favourite: Boolean(img.favourite), revised_prompt: null
          } };
        });
        var at = Date.parse(r.timestamp) || Date.now();
        var kept = Array.isArray(r.sourceFiles) ? r.sourceFiles : [];
        return {
          id: 'saved-' + r.id, mode: r.mode === 'edit' ? 'edit' : 'generate', model: r.model,
          prompt: r.prompt || '', quality: r.quality,
          shape: r.aspect_ratio || 'auto', resolution: r.resolution || '1k', n: frames.length,
          // Combined, or photos edited apart? A combined run says so. Otherwise
          // each log line carried one photo, so several kept photos means they
          // were edited apart, one image per photo.
          plan: r.reference ? 'reference'
            : kept.length > 1 ? 'each' : 'reference',
          sourceCount: r.reference ? (r.sources || kept.length) : Math.max(kept.length, typeof r.sources === 'number' ? r.sources : 0),
          // The photos it was made from, if the server still has every one.
          sources: [], sourceIds: kept,
          ratio: null, user: r.user || null,
          frames: frames, controllers: [], status: 'done', startedAt: at, finishedAt: at,
          cost: r.cost, counted: true, cancelled: false, degraded: false, restored: true
        };
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  function bootFailure(title, body) {
    document.body.innerHTML =
      '<div class="gate"><div class="gate__card"><div class="gate__title">' + title + '</div>' +
      '<p class="gate__sub">' + body + '</p></div></div>';
  }

  async function boot() {
    var saved = readStore(STORE_KEY) || {};

    if (!window.ImagineRequest) {
      bootFailure('Part of the studio did not load',
        'request-body.js is missing or failed to load, so nothing can be sent. Reload; if it persists, check the server is serving /public.');
      return;
    }
    try {
      config = await (await fetch('/api/config')).json();
    } catch (err) {
      bootFailure('The studio server is not answering',
        'This page loaded but /api/config did not. Check that node server.js is still running, then reload.');
      return;
    }

    if (typeof config.maxEditSources === 'number') MAX_EDIT_SOURCES = config.maxEditSources;
    if (typeof config.maxEditVariants === 'number') MAX_EDIT_VARIANTS = config.maxEditVariants;
    if (typeof config.maxFrames === 'number') MAX_FRAMES = config.maxFrames;

    state.model = saved.model || '';
    state.quality = saved.quality || 'auto';
    state.shape = SHAPES.indexOf(saved.shape) !== -1 ? saved.shape : '9:16';
    state.resolution = RESOLUTIONS.indexOf(saved.resolution) !== -1 ? saved.resolution : '1k';
    state.frames = Math.min(MAX_FRAMES, Math.max(1, Number(saved.frames) || 1));
    state.editShape = SHAPES.indexOf(saved.editShape) !== -1 ? saved.editShape : 'auto';
    state.editResolution = RESOLUTIONS.indexOf(saved.editResolution) !== -1 ? saved.editResolution : '1k';
    state.variants = Math.min(MAX_EDIT_VARIANTS, Math.max(1, Number(saved.variants) || 1));
    state.name = saved.name || '';
    state.filter = saved.filter === 'fav' || saved.filter === 'mine' ? saved.filter : 'all';
    if (/^\/assets?\/?$/.test(location.pathname)) state.filter = 'assets';
    state.thumb = Math.min(5, Math.max(1, Number(saved.thumb) || 3));
    applyThumb();

    // What this studio is called, everywhere it is named.
    studioName = (config.studioName || 'Imagine studio');
    $('brand-name').textContent = studioName;
    $('gate-title').textContent = studioName;
    document.title = studioName;
    setAccent(readStore(ACCENT_KEY));
    notifyEl.checked = readStore(NOTIFY_KEY) === true && window.Notification && Notification.permission === 'granted';

    userName.value = state.name;
    renderAvatar();
    setTheme(document.documentElement.getAttribute('data-theme'));
    buildModelOptions();
    renderSpend();
    setFilter(state.filter);

    // No key on the server blocks everything, and no password will change that.
    if (!config.hasKey) {
      gate.hidden = true;
      app.hidden = false;
      renderRail();
      showError('No API key on the server',
        'Generating is switched off until someone adds the team key to the server environment. Post in #design-ops — nothing you change here will fix it.',
        'danger');
      loadSavedRuns();
      return;
    }

    if (!config.requiresPassword) { enterStudio(); return; }

    var stored = readStore(PASS_KEY);
    if (stored) {
      try {
        if (await tryPassword(stored)) { password = stored; enterStudio(); return; }
      } catch (err) { /* fall through to the gate */ }
    }
    gate.hidden = false;
    gatePassword.focus();
  }

  boot();
})();
