'use strict';

/**
 * Imagine studio — the Google request builders and response readers, for the
 * Nano Banana models. Pure functions, no I/O; server.js is the only runtime
 * caller and test/google.test.js exercises everything here directly.
 *
 * Google offers two ways to ask for a picture and both give the same picture:
 *
 *   'interactions'      POST /v1beta/interactions — what Google's docs now
 *                       describe (Api-Revision 2026-05-20).
 *   'generateContent'   POST /v1beta/models/{model}:generateContent — the
 *                       older call most examples show, still served.
 *
 * Which one the server uses is a setting (GOOGLE_API), so switching is a
 * variable and not a deploy. Each style has its own builder and reader; the
 * checks that matter — the source limit, consent, the likeness rule — are
 * shared with the xAI builder so there is exactly one rule for every engine.
 *
 * Money: Google bills by token, not per picture. A 1K or 2K image is 1,120
 * output-image tokens at $120 per million ($0.134), a 4K one 2,000 ($0.24),
 * every input image 560 tokens at $2 per million ($0.0011) — and Nano Banana
 * Pro thinks before it draws, and those thinking tokens are billed too, at
 * $12 per million. So the table price is a floor. When the response carries
 * token counts the real figure is computed from them; when it does not, the
 * table is used and the cost is flagged as an estimate.
 */
const imagine = require('./imagine.js');

const API_REVISION = '2026-05-20';

// Per million tokens, USD, for gemini-3-pro-image. VERIFY against
// https://aistudio.google.com/docs/pricing — read on 5 November 2026.
const TOKEN_PRICES = {
  'gemini-3-pro-image': { input: 2.0, outputImage: 120.0, outputText: 12.0 }
};

// Google's names for the sizes. The K must be upper case: "1k" is rejected.
const IMAGE_SIZE = { '1k': '1K', '2k': '2K', '4k': '4K' };

// What the studio offers, in the studio's own vocabulary. 'auto' sends no
// aspect ratio: the model then matches the first photo on an edit and picks
// for itself on a generation. 2:1 is xAI-only; Google has no such frame.
const ASPECT_RATIOS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'];
const RESOLUTIONS = ['1k', '2k', '4k'];

// A data URI, split into what Google wants: the bare base64 and its type.
// Returns null for anything else — Google does not fetch URLs for us.
function parseDataUri(uri) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(uri || '').trim());
  if (!m) return null;
  return { mime: m[1].toLowerCase(), data: m[2].replace(/\s+/g, '') };
}

// The part shared by both builders: which model, what prompt, how many photos,
// and whether the person may use the faces in them.
function prepare(input) {
  input = input && typeof input === 'object' ? input : {};
  const mode = input.mode === 'edit' ? 'edit' : 'generate';
  const model = String(input.model || '');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';

  if (!imagine.PRICES[model] || imagine.providerOf(model) !== 'google') {
    return { error: 'Unknown Google model "' + model + '".', code: 'bad_request' };
  }
  if (!prompt) {
    return {
      error: mode === 'edit' ? 'Describe the change you want before applying an edit.' : 'Write a prompt before generating.',
      code: 'bad_request'
    };
  }
  const aspect = ASPECT_RATIOS.indexOf(input.aspect_ratio) === -1 ? 'auto' : input.aspect_ratio;
  const resolution = RESOLUTIONS.indexOf(input.resolution) === -1 ? '1k' : input.resolution;

  let sources = [];
  if (mode === 'edit') {
    sources = imagine.cleanSources(input);
    if (!sources.length) {
      return { error: 'Add a photo to edit — an edit needs at least one source image.', code: 'bad_request' };
    }
    if (sources.length > imagine.MAX_EDIT_SOURCES) {
      return {
        error: 'An edit takes at most ' + imagine.MAX_EDIT_SOURCES + ' source images; ' + sources.length + ' were sent.',
        code: 'bad_request'
      };
    }
    if (sources.length > 1) {
      if (input.consent !== true) {
        return {
          error: 'A reference edit needs confirmation that you have permission to use every likeness in these photos.',
          code: 'consent_required'
        };
      }
      if (imagine.violatesLikenessRule(prompt)) {
        return {
          error: 'This studio does not put a real person’s face into sexualised material. Reword the instruction or use different photos.',
          code: 'likeness_policy'
        };
      }
    }
    for (const s of sources) {
      if (!parseDataUri(s)) {
        return { error: 'Google models take photos as data URIs only; one of the sources was something else.', code: 'bad_request' };
      }
    }
  }
  return { mode: mode, model: model, prompt: prompt, aspect: aspect, resolution: resolution, sources: sources };
}

// ---------------------------------------------------------------------------
// Builders. Both return the shape imagine.buildImageRequest does, so the
// server treats every engine alike: { endpoint, payload, minimalPayload, … }.
// `minimalPayload` is the retry after a 400 — the picture without the optional
// shape and size, which is what an unaccepted option should cost, not the run.
// ---------------------------------------------------------------------------
function buildInteractions(p) {
  const blocks = [{ type: 'text', text: p.prompt }];
  p.sources.forEach(function (s) {
    const d = parseDataUri(s);
    blocks.push({ type: 'image', data: d.data, mime_type: d.mime });
  });
  const format = { type: 'image', image_size: IMAGE_SIZE[p.resolution] };
  if (p.aspect !== 'auto') format.aspect_ratio = p.aspect;
  return {
    endpoint: '/v1beta/interactions',
    headers: { 'Api-Revision': API_REVISION },
    payload: { model: p.model, input: blocks, response_format: format },
    minimalPayload: { model: p.model, input: blocks, response_format: { type: 'image' } }
  };
}

function buildGenerateContent(p) {
  const parts = [{ text: p.prompt }];
  p.sources.forEach(function (s) {
    const d = parseDataUri(s);
    parts.push({ inlineData: { mimeType: d.mime, data: d.data } });
  });
  const imageConfig = { imageSize: IMAGE_SIZE[p.resolution] };
  if (p.aspect !== 'auto') imageConfig.aspectRatio = p.aspect;
  const contents = [{ role: 'user', parts: parts }];
  return {
    endpoint: '/v1beta/models/' + p.model + ':generateContent',
    headers: {},
    payload: { contents: contents, generationConfig: { responseModalities: ['IMAGE'], imageConfig: imageConfig } },
    minimalPayload: { contents: contents, generationConfig: { responseModalities: ['IMAGE'] } }
  };
}

function buildImageRequest(input, style) {
  const p = prepare(input);
  if (p.error) return p;
  const chosen = style === 'generateContent' ? 'generateContent' : 'interactions';
  const built = chosen === 'generateContent' ? buildGenerateContent(p) : buildInteractions(p);
  return Object.assign(built, {
    style: chosen,
    mode: p.mode,
    model: p.model,
    prompt: p.prompt,
    quality: 'auto',
    acceptsQuality: false,
    sources: p.sources.length,
    reference: p.sources.length > 1,
    sourceUris: p.sources,
    aspect: p.aspect,
    resolution: p.resolution
  });
}

// ---------------------------------------------------------------------------
// Readers.
// ---------------------------------------------------------------------------

// The pictures in a response, as base64 with their type, and any text the
// model said alongside. No pictures plus a `blocked` reason means it refused.
function imagesFromResponse(json, style) {
  const out = [];
  let text = '';
  let blocked = null;
  if (!json || typeof json !== 'object') return { images: out, text: text, blocked: 'empty' };

  if (style === 'generateContent') {
    const cands = Array.isArray(json.candidates) ? json.candidates : [];
    const pf = json.promptFeedback;
    if (pf && pf.blockReason) blocked = String(pf.blockReason);
    cands.forEach(function (c) {
      const parts = c && c.content && Array.isArray(c.content.parts) ? c.content.parts : [];
      parts.forEach(function (part) {
        if (part && part.inlineData && typeof part.inlineData.data === 'string' && part.inlineData.data) {
          out.push({ b64: part.inlineData.data, mime: String(part.inlineData.mimeType || 'image/png').toLowerCase() });
        } else if (part && typeof part.text === 'string' && !part.thought) {
          text += (text ? ' ' : '') + part.text.trim();
        }
      });
      if (!out.length && c && c.finishReason && c.finishReason !== 'STOP') blocked = String(c.finishReason);
    });
  } else {
    // Every picture the model produced sits in its model_output steps; the
    // thought steps hold the drafts, which nobody asked for.
    const steps = Array.isArray(json.steps) ? json.steps : [];
    steps.forEach(function (step) {
      if (!step || step.type !== 'model_output' || !Array.isArray(step.content)) return;
      step.content.forEach(function (block) {
        if (block && block.type === 'image' && typeof block.data === 'string' && block.data) {
          out.push({ b64: block.data, mime: String(block.mime_type || 'image/png').toLowerCase() });
        } else if (block && block.type === 'text' && typeof block.text === 'string') {
          text += (text ? ' ' : '') + block.text.trim();
        }
      });
    });
    // The convenience field, for a response sent without its steps.
    if (!out.length && json.output_image && typeof json.output_image.data === 'string' && json.output_image.data) {
      out.push({ b64: json.output_image.data, mime: String(json.output_image.mime_type || 'image/png').toLowerCase() });
    }
    if (!out.length && typeof json.output_text === 'string') text = text || json.output_text.trim();
    if (!out.length && json.status && /block|refus|safety|filter/i.test(String(json.status))) blocked = String(json.status);
  }
  return { images: out, text: text, blocked: blocked };
}

// Token counts, however the response spells them. Seen live on 8 November
// 2026: generateContent answers usageMetadata { promptTokenCount,
// candidatesTokenCount, thoughtsTokenCount, candidatesTokensDetails:
// [{ modality: 'IMAGE', tokenCount }] }; interactions answers usage {
// total_input_tokens, total_output_tokens, total_thought_tokens,
// output_tokens_by_modality: [{ modality: 'image', tokens }] }. The older
// spellings stay readable in case either changes back.
function usageFromResponse(json, style) {
  if (!json || typeof json !== 'object') return null;
  const u = style === 'generateContent' ? json.usageMetadata : (json.usage || json.usage_metadata || json.usageMetadata);
  if (!u || typeof u !== 'object') return null;
  const n = function (v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0; };
  const byModality = function (list, modality) {
    if (!Array.isArray(list)) return null;
    let sum = 0, any = false;
    list.forEach(function (d) {
      if (d && String(d.modality).toUpperCase() === modality) { sum += n(d.tokenCount || d.token_count || d.tokens); any = true; }
    });
    return any ? sum : null;
  };
  const input = n(u.promptTokenCount || u.total_input_tokens || u.input_tokens || u.prompt_tokens);
  const output = n(u.candidatesTokenCount || u.total_output_tokens || u.output_tokens || u.completion_tokens);
  const thoughts = n(u.thoughtsTokenCount || u.total_thought_tokens || u.thoughts_tokens || u.reasoning_tokens);
  const outputImage = byModality(u.candidatesTokensDetails || u.output_tokens_by_modality || u.output_tokens_details, 'IMAGE');
  if (!input && !output && !thoughts) return null;
  return {
    input: input,
    // When the split is not given, every output token is taken as image —
    // the dearer rate — so an unknown is never under-billed.
    outputImage: outputImage === null ? output : outputImage,
    outputText: outputImage === null ? 0 : Math.max(0, output - outputImage),
    thoughts: thoughts
  };
}

function usd(x) { return Math.round(x * 1e6) / 1e6; }

// The table price: output per picture by size plus the input charge per photo.
function estimateCost(opts) {
  const p = imagine.PRICES[opts.model];
  const tier = p && p.tiers && p.tiers.default;
  if (!tier) return null;
  const per = tier[RESOLUTIONS.indexOf(opts.resolution) === -1 ? '1k' : opts.resolution];
  if (typeof per !== 'number') return null;
  const n = Math.max(1, Math.floor(opts.count || 1));
  const sources = opts.mode === 'edit' ? Math.max(1, Math.floor(opts.sources || 1)) : 0;
  return usd(per * n + (p.input || 0) * sources);
}

// What a response cost: from its token counts when it has them, the table
// when it does not — and then said to be an estimate.
function costFromResponse(json, style, fallback) {
  fallback = fallback || {};
  const rates = TOKEN_PRICES[fallback.model];
  const use = usageFromResponse(json, style);
  if (use && rates) {
    const cost = (use.input * rates.input + use.outputImage * rates.outputImage + (use.outputText + use.thoughts) * rates.outputText) / 1e6;
    return { cost: usd(cost), estimated: false, tokens: use };
  }
  return { cost: estimateCost(fallback), estimated: true, tokens: use };
}

// Google's error body is { error: { code, message, status } }. Its status
// strings say more than the HTTP code does.
function classify(status, bodyText) {
  let message = '';
  let gstatus = '';
  try {
    const j = JSON.parse(bodyText);
    const e = j && j.error;
    if (e && typeof e.message === 'string') message = e.message;
    if (e && typeof e.status === 'string') gstatus = e.status;
    if (!message && j && typeof j.message === 'string') message = j.message;
  } catch { /* not JSON */ }
  if (!message) message = String(bodyText || '').trim().slice(0, 300) || ('Google returned status ' + status + ' with an empty body.');
  const m = message.toLowerCase();
  let code;
  if (status === 429 || gstatus === 'RESOURCE_EXHAUSTED') {
    code = /billing|free tier|enable billing|quota.*exceeded.*(limit: 0|free)/.test(m) ? 'no_credits' : 'rate_limited';
  } else if (status === 401 || status === 403 || gstatus === 'UNAUTHENTICATED' || gstatus === 'PERMISSION_DENIED' || /api key not valid|api_key_invalid|api key/.test(m)) {
    code = 'key_rejected';
  } else if (status === 404 || gstatus === 'NOT_FOUND') {
    code = 'model_unavailable';
  } else if (/safety|blocked|prohibited|content policy|violat/.test(m)) {
    code = 'moderation';
  } else {
    code = 'upstream';
  }
  return { code: code, message: message, googleStatus: gstatus || null };
}

module.exports = {
  API_REVISION: API_REVISION,
  ASPECT_RATIOS: ASPECT_RATIOS,
  RESOLUTIONS: RESOLUTIONS,
  TOKEN_PRICES: TOKEN_PRICES,
  parseDataUri: parseDataUri,
  buildImageRequest: buildImageRequest,
  imagesFromResponse: imagesFromResponse,
  usageFromResponse: usageFromResponse,
  estimateCost: estimateCost,
  costFromResponse: costFromResponse,
  classify: classify
};
