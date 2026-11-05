/**
 * Sudoku Generator API
 * 
 * Proxy for Juhe Data Sudoku API (ID 572) to:
 * 1. Hide the API key from the browser
 * 2. Normalize the response
 * 3. Handle CORS
 * 4. Provide a clean error path with a client-side fallback
 *
 * GET /api/sudoku?difficulty=easy|normal|hard|veryhard
 *
 * Note: This function does NOT generate puzzles client-side as a fallback,
 * because a hand-rolled CSRNG-Sudoku generator with grade-d difficulty
 * calibration is significantly more code than just surfacing the API error.
 * The browser caller is expected to handle non-200 with its own UI message.
 */
const JUHE_BASE = 'https://apis.juhe.cn/fapig/sudoku/generate';
const VALID = { easy: 1, normal: 1, hard: 1, veryhard: 1 };

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const difficulty = (url.searchParams.get('difficulty') || 'easy').toLowerCase();
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers, status: 204 });
  }
  const key = context.env?.DEVTOOLS_JUHE_SUDOKU_KEY;
  if (!key) {
    return new Response(JSON.stringify({
      error: 'sudoku_key_missing',
      message: 'Sudoku API key is not configured on the server.'
    }), { status: 503, headers });
  }
  if (!VALID[difficulty]) {
    return new Response(JSON.stringify({
      error: 'invalid_difficulty',
      message: 'difficulty must be one of: easy, normal, hard, veryhard'
    }), { status: 400, headers });
  }
  const apiUrl = JUHE_BASE + '?key=' + encodeURIComponent(key) + '&difficulty=' + encodeURIComponent(difficulty);
  try {
    const resp = await fetch(apiUrl, { method: 'GET' });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (e) {
      return new Response(JSON.stringify({
        error: 'upstream_parse_error',
        message: 'Sudoku API returned a non-JSON response.',
        upstream_status: resp.status
      }), { status: 502, headers });
    }
    if (data.error_code !== 0) {
      return new Response(JSON.stringify({
        error: 'upstream_error',
        message: data.reason || 'Sudoku API returned an error.',
        upstream_code: data.error_code
      }), { status: 502, headers });
    }
    return new Response(JSON.stringify({
      difficulty,
      puzzle: data.result.puzzle,
      solution: data.result.solution
    }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({
      error: 'upstream_failure',
      message: e.message || 'Failed to reach the Sudoku API.'
    }), { status: 502, headers });
  }
}
