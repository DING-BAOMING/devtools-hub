/**
 * YouTube Transcript Extractor API
 *
 * Endpoints:
 *   POST /api/youtube-transcript-extractor
 *     body: { action: "tracks", videoId: "..." }
 *     -> { videoId, meta: oEmbed, tracks: [{ lang, label, kind, url }] }
 *     body: { action: "transcript", videoId, lang, trackUrl }
 *     -> { videoId, duration, cues: [{ start, duration, text }] }
 *
 * Env: none required.
 *
 * Strategy:
 *   1. Fetch https://www.youtube.com/watch?v=VIDEO_ID
 *   2. Parse ytInitialPlayerResponse JSON embedded in HTML
 *   3. Extract captions.playerCaptionsTracklistRenderer.captionTracks[]
 *   4. For transcript, fetch the baseUrl with fmt=json3 to get timed events
 *   5. Parse JSON3 events into cues (start, duration, text)
 *   6. Also fetch oEmbed for title/channel/thumbnail
 */

var YT_WATCH = 'https://www.youtube.com/watch?v=';
var YT_OEMBED = 'https://www.youtube.com/oembed?url=';
var USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

var CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

function json(data, status) {
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
    });
}

function err(msg, status) {
    return json({ error: msg }, status || 400);
}

function parseVideoId(input) {
    if (!input) return null;
    var s = String(input).trim();
    var patterns = [
        /[?&]v=([a-zA-Z0-9_-]{11})/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})/,
        /\/shorts\/([a-zA-Z0-9_-]{11})/,
        /\/embed\/([a-zA-Z0-9_-]{11})/,
        /\/live\/([a-zA-Z0-9_-]{11})/,
        /\/v\/([a-zA-Z0-9_-]{11})/
    ];
    for (var i = 0; i < patterns.length; i++) {
        var m = s.match(patterns[i]);
        if (m) return m[1];
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
    return null;
}

function extractPlayerResponse(html) {
    var marker = 'var ytInitialPlayerResponse = ';
    var idx = html.indexOf(marker);
    if (idx < 0) {
        marker = 'ytInitialPlayerResponse = ';
        idx = html.indexOf(marker);
        if (idx < 0) return null;
        idx += marker.length;
    } else {
        idx += marker.length;
    }
    var braceIdx = html.indexOf('{', idx);
    if (braceIdx < 0) return null;
    var depth = 0;
    var end = -1;
    var inStr = false;
    var escape = false;
    for (var i = braceIdx; i < html.length; i++) {
        var ch = html[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) { end = i + 1; break; }
        }
    }
    if (end < 0) return null;
    var raw = html.substring(braceIdx, end);
    try {
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

function extractCaptionTracks(playerResponse) {
    var tracks = [];
    try {
        var cap = playerResponse && playerResponse.captions && playerResponse.captions.playerCaptionsTracklistRenderer;
        if (!cap || !Array.isArray(cap.captionTracks)) return tracks;
        cap.captionTracks.forEach(function(t) {
            if (!t || !t.baseUrl) return;
            var track = {
                lang: t.languageCode || '',
                label: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs.map(function(r) { return r.text; }).join('')))) || t.languageCode || 'Unknown',
                kind: t.kind || '',
                url: t.baseUrl,
                isTranslatable: !!t.isTranslatable
            };
            tracks.push(track);
        });
    } catch (e) {
        return tracks;
    }
    return tracks;
}

async function fetchWatchHtml(videoId) {
    var resp = await fetch(YT_WATCH + encodeURIComponent(videoId), {
        headers: {
            'User-Agent': USER_AGENT,
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml'
        }
    });
    if (!resp.ok) {
        throw new Error('YouTube watch page returned HTTP ' + resp.status);
    }
    return await resp.text();
}

async function fetchOembed(videoId) {
    try {
        var url = YT_OEMBED + encodeURIComponent(YT_WATCH + videoId) + '&format=json';
        var resp = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT }
        });
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        return null;
    }
}

async function handleTracks(env, videoId) {
    var html = await fetchWatchHtml(videoId);
    var playerResponse = extractPlayerResponse(html);
    if (!playerResponse) {
        return err('Could not parse YouTube player response. The video may be private, age-restricted, or temporarily unavailable.', 502);
    }
    var playability = playerResponse.playabilityStatus || {};
    if (playability.status === 'ERROR' || playability.status === 'LOGIN_REQUIRED') {
        var reason = playability.reason || ('YouTube playability status: ' + playability.status);
        return err(reason + ' Try a public video with captions enabled.', 403);
    }
    var tracks = extractCaptionTracks(playerResponse);
    var meta = await fetchOembed(videoId);
    return json({
        videoId: videoId,
        meta: meta,
        tracks: tracks
    });
}

function formatSrtTime(sec) {
    sec = Math.max(0, sec);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    var ms = Math.floor((sec - Math.floor(sec)) * 1000);
    var hh = h < 10 ? '0' + h : '' + h;
    var mm = m < 10 ? '0' + m : '' + m;
    var ss = s < 10 ? '0' + s : '' + s;
    var mss = ms < 10 ? '00' + ms : ms < 100 ? '0' + ms : '' + ms;
    return hh + ':' + mm + ':' + ss + ',' + mss;
}

function parseJson3Transcript(jsonText) {
    var data;
    try { data = JSON.parse(jsonText); }
    catch (e) { return { cues: [], duration: 0 }; }
    var events = data.events || [];
    var cues = [];
    var lastEnd = 0;
    for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var start = (ev.tStartMs || 0) / 1000;
        var dur = (ev.dDurationMs || 0) / 1000;
        var text = '';
        if (Array.isArray(ev.segs)) {
            text = ev.segs.map(function(s) { return s.utf8 || ''; }).join('').replace(/\s+/g, ' ').trim();
        }
        if (!text) continue;
        cues.push({ start: start, duration: dur, text: text });
        if (start + dur > lastEnd) lastEnd = start + dur;
    }
    return { cues: cues, duration: lastEnd };
}

async function handleTranscript(env, videoId, lang, trackUrl) {
    var url = trackUrl;
    if (!url) {
        var tracksResp = await handleTracks(env, videoId);
        var tracksJson = await tracksResp.json();
        if (tracksJson.error) return tracksResp;
        var candidates = tracksJson.tracks || [];
        var track = null;
        if (lang) track = candidates.find(function(t) { return t.lang === lang; });
        if (!track) track = candidates.find(function(t) { return t.kind !== 'asr'; }) || candidates[0];
        if (!track) return err('No caption track available for language "' + lang + '"', 404);
        url = track.url;
    }

    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    var json3Url = url + sep + 'fmt=json3';
    var resp = await fetch(json3Url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': lang || 'en' }
    });
    if (!resp.ok) {
        var txt = await resp.text().catch(function() { return ''; });
        return err('Timedtext endpoint returned HTTP ' + resp.status + '. Body: ' + txt.substring(0, 200), 502);
    }
    var text = await resp.text();
    var parsed = parseJson3Transcript(text);
    return json({
        videoId: videoId,
        lang: lang || null,
        cue_count: parsed.cues.length,
        duration: parsed.duration,
        cues: parsed.cues
    });
}

export async function onRequest(context) {
    if (context.request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }
    if (context.request.method === 'GET') {
        return json({
            tool: 'youtube-transcript-extractor',
            version: '1.0.0',
            status: 'ready',
            upstream: 'YouTube public player response + timedtext endpoint (no API key)',
            actions: ['tracks', 'transcript']
        });
    }
    if (context.request.method !== 'POST') {
        return err('Method not allowed. Use GET for health or POST to fetch.', 405);
    }

    var body;
    try { body = await context.request.json(); }
    catch (e) { return err('Invalid JSON body', 400); }

    var action = (body.action || '').toString();
    var videoId = parseVideoId(body.videoId || '');

    if (!videoId) {
        return err('Invalid or missing videoId. Provide a YouTube video ID or URL (youtube.com/watch?v=..., youtu.be/..., /shorts/..., /embed/...).', 502);
    }

    try {
        if (action === 'tracks') {
            return await handleTracks(context.env, videoId);
        }
        if (action === 'transcript') {
            return await handleTranscript(context.env, videoId, body.lang || '', body.trackUrl || '');
        }
        return err('Unknown action. Use "tracks" or "transcript".', 400);
    } catch (e) {
        console.error('YT transcript error:', e && e.message);
        return err('Upstream error: ' + (e.message || 'unknown'), 502);
    }
}