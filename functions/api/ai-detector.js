/**
 * AI Detector API - Multi-LLM Voting Content Detection
 *
 * AI Provider动态模型选择说明 (重要):
 *
 * 免费AI API存在模型可用性不稳定的情况:
 * - 本月模型A可用/模型B不可用, 下月可能相反
 * - 模型可能突然失效、新增或被替换
 *
 * 因此本API采用动态模型发现机制:
 * 1. 并行调用所有已配置的AI provider
 * 2. 每个provider独立分析文本是否为AI生成
 * 3. 投票机制聚合结果，提高准确性
 *
 * 当前Provider列表:
 * Groq (60 req/min) → Gemini (10 RPM) → NVIDIA Key1 (30 req/min) → NVIDIA Key3 (30 req/min) → SiliconFlow (74免费模型)
 *
 * 架构说明:
 * - 所有provider并行调用 (Promise.allSettled)
 * - 每个provider返回: verdict (AI/Human/Uncertain), confidence (0-100), reasoning, flagged_sentences
 * - 聚合: majority voting + confidence averaging
 * - 绕过: 任何provider失败/超时不影响其他provider
 */

import { discoverChatModels, discoverGeminiModels } from '../../libs/ai-provider.js';

var DETECTION_PROMPT = `You are an AI content detection expert. Analyze the following text and determine if it was written by an AI language model or a human.

Return your analysis in valid JSON format only, no other text:
{
  "verdict": "AI" or "Human" or "Uncertain",
  "confidence": <number 0-100>,
  "reasoning": "<2-3 sentence explanation focusing on specific patterns>",
  "flagged_sentences": [
    {"text": "<exact sentence text>", "reason": "<why this seems AI/human>"}
  ]
}

Rules:
- "AI" = confident the text is AI-generated
- "Human" = confident the text is human-written
- "Uncertain" = cannot determine with confidence
- Focus on: repetitiveness, sentence structure uniformity, vocabulary patterns, transition phrases, depth of analysis
- Flag 0-5 specific sentences that most influenced your verdict
- Be conservative: if unsure, use "Uncertain" rather than guessing

Text to analyze:
`;

var VERDICT_PROMPT = '\n\nAnalyze this text as described. Return ONLY valid JSON.';

var MAX_TEXT_LENGTH = 5000;

// One provider's vote should not be lost because its first listed model is out of
// quota. Bounded so a visitor's button still answers promptly.
var MODELS_PER_PROVIDER = 3;

async function getSiliconFlowModels(apiKey) {
  try {
    var res = await fetch('https://api.siliconflow.cn/v1/models', {
      headers: { 'Authorization': 'Bearer ' + apiKey }
    });
    if (!res.ok) return [];
    var data = await res.json();
    return data.data
      .filter(function(m) { return !m.id.startsWith('Pro/') && !m.id.startsWith('LoRA/'); })
      .map(function(m) { return m.id; });
  } catch (e) {
    return [];
  }
}

function selectBestSiliconModel(models) {
  var priorities = [
    'deepseek-ai/DeepSeek-V3',
    'Qwen/Qwen2.5-72B-Instruct',
    'Qwen/Qwen2.5-32B-Instruct',
    'Qwen/Qwen3-32B',
    'Qwen/Qwen2.5-14B-Instruct',
    'Qwen/Qwen2.5-7B-Instruct'
  ];
  for (var i = 0; i < priorities.length; i++) {
    var found = models.find(function(m) { return m === priorities[i]; });
    if (found) return found;
  }
  return models.find(function(m) { return m.includes('Qwen') || m.includes('DeepSeek'); }) || models[0] || 'Qwen/Qwen2.5-7B-Instruct';
}

function parseGeminiVerdict(data) {
  if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) return null;
  var text = data.candidates[0].content.parts[0].text;
  return parseVerdictFromText(text);
}

function parseVerdictFromText(text) {
  try {
    var cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var jsonStart = cleaned.indexOf('{');
    var jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
    }
    var parsed = JSON.parse(cleaned);
    return {
      verdict: parsed.verdict || 'Uncertain',
      confidence: Math.min(100, Math.max(0, parseInt(parsed.confidence) || 50)),
      reasoning: parsed.reasoning || '',
      flagged_sentences: Array.isArray(parsed.flagged_sentences) ? parsed.flagged_sentences.slice(0, 5) : []
    };
  } catch (e) {
    return null;
  }
}

// `makeRequest` is called as makeRequest(modelId). The id is resolved live from the
// provider rather than pinned: Groq decommissioned the `llama-3.3-70b-versatile` this
// file hardcoded and NVIDIA answered 410 Gone for `meta/llama-3.3-70b-instruct`, so
// this tool reported "Error" with 0 of 5 models answered (BUG-328). Walking the live
// list also means one out-of-quota model no longer costs the whole vote.
async function callProvider(name, makeRequest, parseFunc, resolveModels) {
  var models = resolveModels ? await resolveModels() : [];
  if (!models.length) {
    return { name: name, verdict: 'Uncertain', confidence: 0, reasoning: 'No live model offered by this provider', flagged_sentences: [], error: true };
  }
  var tries = Math.min(MODELS_PER_PROVIDER, models.length);
  var lastReasoning = '';
  for (var n = 0; n < tries; n++) {
    try {
      var response = await makeRequest(models[n]);
      if (!response.ok) {
        var errorText = '';
        try { errorText = await response.text(); } catch(e) {}
        lastReasoning = 'API error: ' + response.status + ' ' + errorText.substring(0, 100);
        continue;
      }
      var data = await response.json();
      var parsed;
      if (parseFunc) {
        parsed = parseFunc(data);
      } else {
        var content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
        parsed = parseVerdictFromText(content);
      }
      if (!parsed) {
        lastReasoning = 'Failed to parse response';
        continue;
      }
      return { name: name, verdict: parsed.verdict, confidence: parsed.confidence, reasoning: parsed.reasoning, flagged_sentences: parsed.flagged_sentences, error: false };
    } catch (e) {
      lastReasoning = 'Exception: ' + e.message.substring(0, 100);
    }
  }
  return { name: name, verdict: 'Uncertain', confidence: 0, reasoning: lastReasoning, flagged_sentences: [], error: true };
}

export async function onRequest(context) {
  var responseHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }

  if (context.request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });
  }

  var text;
  try {
    var body = await context.request.json();
    text = body.text;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: responseHeaders });
  }

  if (!text || typeof text !== 'string') {
    return new Response(JSON.stringify({ error: 'No text provided' }), { status: 400, headers: responseHeaders });
  }

  if (text.length < 50) {
    return new Response(JSON.stringify({ error: 'Please enter at least 50 characters for reliable detection' }), { status: 400, headers: responseHeaders });
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return new Response(JSON.stringify({ error: 'Text exceeds ' + MAX_TEXT_LENGTH + ' character limit' }), { status: 400, headers: responseHeaders });
  }

  var env = context.env;
  var groqKey = env.DEVTOOLS_GROQ_API_KEY;
  var geminiKey = env.DEVTOOLS_GEMINI_KEY;
  var nvidiaKey1 = env.DEVTOOLS_NVIDIA_KEY_1;
  var nvidiaKey3 = env.DEVTOOLS_NVIDIA_KEY_3;
  var siliconKey = env.DEVTOOLS_SILICONFLOW_KEY;

  var userText = text;
  var systemPrompt = DETECTION_PROMPT;
  var fullPrompt = userText + VERDICT_PROMPT;

  var providers = [];

  if (groqKey && groqKey !== 'GROQ_API_KEY_NOT_SET') {
    providers.push(callProvider('Groq',
      function(model) {
        return fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: fullPrompt }
            ],
            temperature: 0.1,
            max_tokens: 1024,
            response_format: { type: 'json_object' }
          })
        });
      },
      null,
      function() { return discoverChatModels('https://api.groq.com/openai/v1', groqKey); }
    ));
  }

  if (geminiKey) {
    providers.push(callProvider('Gemini',
      function(model) {
        var geminiBody = {
          contents: [{
            parts: [{ text: systemPrompt + '\n\n' + fullPrompt }]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1024, responseMimeType: 'application/json' }
        };
        return fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify(geminiBody)
        });
      },
      parseGeminiVerdict,
      // The id is read from Gemini's own catalogue, never written down here.
      function() { return discoverGeminiModels(geminiKey); }
    ));
  }

  if (nvidiaKey1) {
    providers.push(callProvider('NVIDIA #1',
      function(model) {
        return fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + nvidiaKey1, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: fullPrompt }
            ],
            temperature: 0.1,
            max_tokens: 1024,
            response_format: { type: 'json_object' }
          })
        });
      },
      null,
      function() { return discoverChatModels('https://integrate.api.nvidia.com/v1', nvidiaKey1); }
    ));
  }

  if (nvidiaKey3) {
    providers.push(callProvider('NVIDIA #2',
      function(model) {
        return fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + nvidiaKey3, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: fullPrompt }
            ],
            temperature: 0.1,
            max_tokens: 1024,
            response_format: { type: 'json_object' }
          })
        });
      },
      null,
      function() { return discoverChatModels('https://integrate.api.nvidia.com/v1', nvidiaKey3); }
    ));
  }

  if (siliconKey) {
    var siliconModels = await getSiliconFlowModels(siliconKey);
    var bestModel = selectBestSiliconModel(siliconModels);
    if (bestModel) {
      providers.push(callProvider('SiliconFlow (' + bestModel.split('/').pop() + ')',
        function(model) {
          return fetch('https://api.siliconflow.cn/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + siliconKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: model || bestModel,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: fullPrompt }
              ],
              temperature: 0.1,
              max_tokens: 1024
            })
          });
        },
        null,
        async function() { return siliconModels.length ? [bestModel] : []; }
      ));
    }
  }

  if (providers.length === 0) {
    return new Response(JSON.stringify({ error: 'No AI providers configured' }), { status: 500, headers: responseHeaders });
  }

  var results = await Promise.allSettled(providers.map(function(p) { return p; }));
  var providerResults = [];
  for (var i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      providerResults.push(results[i].value);
    } else {
      providerResults.push({
        name: 'Provider #' + (i + 1),
        verdict: 'Uncertain',
        confidence: 0,
        reasoning: 'Request failed: ' + results[i].reason,
        flagged_sentences: [],
        error: true
      });
    }
  }

  var aiVotes = 0, humanVotes = 0, uncertainVotes = 0;
  var totalConfidence = 0;
  var providerCount = providerResults.length;
  var sentenceMap = {};

  for (var j = 0; j < providerResults.length; j++) {
    var r = providerResults[j];
    if (r.error) continue;
    if (r.verdict === 'AI') aiVotes++;
    else if (r.verdict === 'Human') humanVotes++;
    else uncertainVotes++;
    totalConfidence += r.confidence;

    if (r.flagged_sentences && r.flagged_sentences.length > 0) {
      for (var k = 0; k < r.flagged_sentences.length; k++) {
        var fs = r.flagged_sentences[k];
        var key = fs.text.substring(0, 80);
        if (!sentenceMap[key]) {
          sentenceMap[key] = { text: fs.text, count: 0, reasons: [] };
        }
        sentenceMap[key].count++;
        if (fs.reason) sentenceMap[key].reasons.push(fs.reason);
      }
    }
  }

  var nonErrorCount = providerResults.filter(function(r) { return !r.error; }).length;
  var avgConfidence = nonErrorCount > 0 ? Math.round(totalConfidence / nonErrorCount) : 0;

  var verdict;
  if (nonErrorCount === 0) {
    verdict = 'Error';
  } else if (aiVotes > humanVotes && aiVotes >= Math.ceil(nonErrorCount / 2)) {
    if (aiVotes >= nonErrorCount - uncertainVotes && nonErrorCount - uncertainVotes >= 2) {
      verdict = 'AI-Generated';
    } else {
      verdict = 'Likely AI-Generated';
    }
  } else if (humanVotes > aiVotes && humanVotes >= Math.ceil(nonErrorCount / 2)) {
    if (humanVotes >= nonErrorCount - uncertainVotes && nonErrorCount - uncertainVotes >= 2) {
      verdict = 'Human-Written';
    } else {
      verdict = 'Likely Human-Written';
    }
  } else {
    verdict = 'Uncertain';
  }

  var sentences = Object.keys(sentenceMap).map(function(key) {
    var s = sentenceMap[key];
    return {
      text: s.text,
      mention_count: s.count,
      reasons: s.reasons.slice(0, 3)
    };
  }).sort(function(a, b) { return b.mention_count - a.mention_count; }).slice(0, 10);

  var aiProbability = nonErrorCount > 0 ? Math.round((aiVotes / nonErrorCount) * 100) : 0;

  var result = {
    overall: {
      verdict: verdict,
      ai_probability: aiProbability,
      avg_confidence: avgConfidence,
      total_providers: providerResults.length,
      successful_providers: nonErrorCount,
      ai_votes: aiVotes,
      human_votes: humanVotes,
      uncertain_votes: uncertainVotes
    },
    per_provider: providerResults.map(function(r) {
      return {
        name: r.name,
        verdict: r.verdict,
        confidence: r.confidence,
        reasoning: r.reasoning,
        error: r.error
      };
    }),
    flagged_sentences: sentences
  };

  return new Response(JSON.stringify(result), { headers: responseHeaders });
}
