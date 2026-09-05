'use strict';

/**
 * Imagine studio — the xAI request builders and the price table.
 *
 * Pure functions, no I/O. server.js is the only runtime caller; test/ exercises
 * these directly so a change to the request shape is caught before a paid
 * request goes out. Everything about "what do we send to xAI" lives here.
 */

// ---------------------------------------------------------------------------
// Prices, in USD.
//
// VERIFY THESE against https://docs.x.ai/developers/pricing before trusting the
// running total — xAI can change them without changing the API, and nothing here
// reads back a real balance. Since the API started reporting cost on every
// image response (usage.cost_in_usd_ticks) these numbers are used ONLY for the
// estimate shown before a run, and as a fallback if a response carries no
// usage block. They are never sent to xAI.
//
//   input   charged once per source image, so it applies to edits only.
//   tiers   output price per image, by resolution.
//
// grok-imagine-image-2.0 is the only model that accepts a quality parameter.
// Leaving quality on auto bills low for generation and medium for editing, which
// is what autoQuality records.
// ---------------------------------------------------------------------------
const PRICES = {
  'grok-imagine-image-quality': {
    label: 'Imagine 1.5 Quality',
    isDefault: true,
    retiresAt: '2026-11-02T00:00:00Z',
    input: 0.01,
    tiers: { default: { '1k': 0.05, '2k': 0.07 } }
  },
  'grok-imagine-image-2.0': {
    label: 'Imagine 2.0',
    input: 0.01,
    tiers: {
      low: { '1k': 0.04, '2k': 0.06 },
      medium: { '1k': 0.06, '2k': 0.08 }
    },
    autoQuality: { generate: 'low', edit: 'medium' }
  },
  'grok-imagine-image': {
    label: 'Imagine 1.0',
    input: 0.002,
    tiers: { default: { '1k': 0.02, '2k': 0.02 } }
  }
};

// Models that accept `quality`. Sending it to any other model is a 400, so the
// client reads this array rather than hardcoding the condition.
const QUALITY_MODELS = Object.keys(PRICES).filter(function (id) {
  return !PRICES[id].tiers.default;
});

const ASPECT_RATIOS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '21:9'];
const RESOLUTIONS = ['1k', '2k'];
const QUALITIES = ['low', 'medium', 'auto'];

// Limits of the edits endpoint, from the docs: up to five source images in one
// request. Variants are capped lower than generation's ten because every
// variant re-sends every source image.
const MAX_EDIT_SOURCES = 5;
const MAX_EDIT_VARIANTS = 4;
const MAX_GENERATE_FRAMES = 10;

// xAI reports cost as cost_in_usd_ticks on image and chat responses. The docs
// confirm the tick value: a $0.02 generation reports 200000000 ticks.
const USD_PER_TICK = 1e-10;

// ---------------------------------------------------------------------------
// Likeness rule.
//
// A reference edit puts a real person's face into a new picture, so two things
// are required in code rather than left to whoever is at the keyboard: the
// person submitting attests they have permission for every likeness involved,
// and a reference edit whose instruction sexualises the result is refused
// outright. This screen reads the instruction only — it cannot see what is in
// the photographs, which is why it is a floor and not the whole policy.
// ---------------------------------------------------------------------------
const SEXUAL_TERMS = /\b(nude|nudity|naked|topless|bottomless|undress\w*|strip(?:ped|ping|s)?|lingerie|underwear|panties|bra|thong|bikini|swimsuit|nsfw|porn\w*|sex\w*|erotic\w*|seduc\w*|lewd|explicit|xxx|nipple\w*|breasts?|boobs?|cleavage|genital\w*|crotch|buttocks|ass|booty|fetish\w*|bdsm|orgasm\w*|masturbat\w*|intimate|sultry|provocative|onlyfans)\b/i;

function violatesLikenessRule(prompt) {
  return SEXUAL_TERMS.test(String(prompt || ''));
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------
function tierFor(model, quality, mode) {
  const p = PRICES[model];
  if (!p) return null;
  if (p.tiers.default) return p.tiers.default;
  const q = !quality || quality === 'auto'
    ? p.autoQuality[mode === 'edit' ? 'edit' : 'generate']
    : quality;
  return p.tiers[q] || null;
}

// The local estimate. Used before a run, and after one only when the response
// carried no usage block. opts.sources is how many input images were sent —
// each is charged the input price once per request.
function estimateCost(opts) {
  const p = PRICES[opts.model];
  const tier = tierFor(opts.model, opts.quality, opts.mode);
  // Unknown model or tier: the caller must say the cost is unknown, not guess.
  if (!p || !tier) return null;
  const res = RESOLUTIONS.indexOf(opts.resolution) === -1 ? '1k' : opts.resolution;
  const per = tier[res];
  if (typeof per !== 'number') return null;
  const n = Math.max(1, Math.floor(opts.count || 1));
  const sources = opts.mode === 'edit' ? Math.max(1, Math.floor(opts.sources || 1)) : 0;
  return Math.round((per * n + p.input * sources) * 1e6) / 1e6;
}

function usdFromTicks(ticks) {
  if (typeof ticks !== 'number' || !Number.isFinite(ticks) || ticks < 0) return null;
  return Math.round(ticks * USD_PER_TICK * 1e6) / 1e6;
}

// What a response actually cost. Prefers the figure xAI reports; falls back to
// the price table and says so, because an estimate on the running total must
// never be mistaken for a bill.
function costFromResponse(json, fallback) {
  const usage = json && json.usage;
  const reported = usage ? usdFromTicks(usage.cost_in_usd_ticks) : null;
  if (reported !== null) return { cost: reported, estimated: false };
  return { cost: estimateCost(fallback), estimated: true };
}

// ---------------------------------------------------------------------------
// Request builder for POST /api/images → xAI.
//
// Takes the client's JSON as parsed and returns either { error, code } or the
// upstream endpoint, the full payload and the minimal payload used for the
// one retry after a 400. Never performs I/O.
// ---------------------------------------------------------------------------
function cleanSources(input) {
  let list = [];
  if (Array.isArray(input.sources)) list = input.sources;
  // The field the client sent before reference editing existed: one image as a
  // plain string. Still accepted so nothing that stored it breaks.
  else if (typeof input.image === 'string') list = [input.image];
  return list.filter(function (s) { return typeof s === 'string' && s.trim(); })
    .map(function (s) { return s.trim(); });
}

// Every source — a public URL, a data URI or a Files API file_id — goes in the
// same wrapper; the docs say a file_id is substituted for the url value.
function sourceEntry(url) {
  return { type: 'image_url', url: url };
}

function buildImageRequest(input) {
  input = input && typeof input === 'object' ? input : {};
  const mode = input.mode === 'edit' ? 'edit' : 'generate';
  const model = String(input.model || '');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';

  if (!PRICES[model]) {
    return {
      error: 'Unknown model "' + model + '". Pick one of: ' + Object.keys(PRICES).join(', ') + '.',
      code: 'bad_request'
    };
  }
  if (!prompt) {
    return {
      error: mode === 'edit' ? 'Describe the change you want before applying an edit.' : 'Write a prompt before generating.',
      code: 'bad_request'
    };
  }

  const acceptsQuality = QUALITY_MODELS.indexOf(model) !== -1;
  const quality = QUALITIES.indexOf(input.quality) === -1 ? 'auto' : input.quality;
  const aspect = ASPECT_RATIOS.indexOf(input.aspect_ratio) === -1 ? 'auto' : input.aspect_ratio;
  const resolution = RESOLUTIONS.indexOf(input.resolution) === -1 ? '1k' : input.resolution;

  const base = { model: model, prompt: prompt, response_format: 'b64_json' };
  let payload, minimal, sources = [];

  if (mode === 'edit') {
    sources = cleanSources(input);
    if (!sources.length) {
      return { error: 'Add a photo to edit — the edit endpoint needs at least one source image.', code: 'bad_request' };
    }
    if (sources.length > MAX_EDIT_SOURCES) {
      return {
        error: 'An edit takes at most ' + MAX_EDIT_SOURCES + ' source images; ' + sources.length + ' were sent.',
        code: 'bad_request'
      };
    }
    // Two or more sources is a reference edit: the first is the base and the
    // rest lend what the prompt asks for. That is the case the likeness rule
    // covers.
    if (sources.length > 1) {
      if (input.consent !== true) {
        return {
          error: 'A reference edit needs confirmation that you have permission to use every likeness in these photos.',
          code: 'consent_required'
        };
      }
      if (violatesLikenessRule(prompt)) {
        return {
          error: 'This studio does not put a real person’s face into sexualised material. Reword the instruction or use different photos.',
          code: 'likeness_policy'
        };
      }
    }

    const count = Math.min(MAX_EDIT_VARIANTS, Math.max(1, Math.floor(Number(input.n) || 1)));
    // `image` and `images` are mutually exclusive on the edits endpoint. One
    // source uses the singular field, more than one the plural, never both.
    const pictures = sources.length === 1
      ? { image: sourceEntry(sources[0]) }
      : { images: sources.map(sourceEntry) };

    payload = Object.assign({}, base, pictures, {
      n: count,
      aspect_ratio: aspect,
      resolution: resolution
    });
    // The retry after a 400 keeps only what the endpoint cannot do without.
    minimal = Object.assign({}, base, pictures);
  } else {
    const count = Math.min(MAX_GENERATE_FRAMES, Math.max(1, Math.floor(Number(input.n) || 1)));
    payload = Object.assign({}, base, { n: count, aspect_ratio: aspect, resolution: resolution });
    minimal = Object.assign({}, base, { n: count });
  }

  // Sending quality to a model that does not accept it is a 400.
  if (acceptsQuality && quality !== 'auto') payload.quality = quality;

  return {
    mode: mode,
    endpoint: mode === 'edit' ? '/images/edits' : '/images/generations',
    model: model,
    prompt: prompt,
    quality: quality,
    acceptsQuality: acceptsQuality,
    sources: sources.length,
    reference: sources.length > 1,
    payload: payload,
    minimalPayload: minimal
  };
}

module.exports = {
  PRICES: PRICES,
  QUALITY_MODELS: QUALITY_MODELS,
  ASPECT_RATIOS: ASPECT_RATIOS,
  RESOLUTIONS: RESOLUTIONS,
  QUALITIES: QUALITIES,
  MAX_EDIT_SOURCES: MAX_EDIT_SOURCES,
  MAX_EDIT_VARIANTS: MAX_EDIT_VARIANTS,
  MAX_GENERATE_FRAMES: MAX_GENERATE_FRAMES,
  USD_PER_TICK: USD_PER_TICK,
  tierFor: tierFor,
  estimateCost: estimateCost,
  usdFromTicks: usdFromTicks,
  costFromResponse: costFromResponse,
  violatesLikenessRule: violatesLikenessRule,
  buildImageRequest: buildImageRequest
};
