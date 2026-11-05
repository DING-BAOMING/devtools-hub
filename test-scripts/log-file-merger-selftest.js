// Self-check for the log-file-merger timestamp engine.
// Runs the page's own parser out of the HTML so it cannot drift from the shipped file.
//   node /home/ubuntu/evan-ip-ddns-com/devtools-hub/test-scripts/log-file-merger-selftest.js
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'tools', 'log-file-merger', 'index.html');
const src = fs.readFileSync(HTML, 'utf8');
const blocks = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const engine = blocks[blocks.length - 1];
const start = engine.indexOf('var MONTH =');
const end = engine.indexOf('var LEVELS =');
if (start < 0 || end < 0) throw new Error('parser block not found in page');
const sandbox = {};
new Function('sandbox', engine.slice(start, end) + '\nsandbox.MATCH=MATCH;sandbox.parseTimestamp=parseTimestamp;')(sandbox);

let pass = 0, fail = 0;
function eq(label, got, want) {
    const ok = got === want;
    ok ? pass++ : fail++;
    console.log((ok ? 'ok   ' : 'FAIL ') + label + '  got=' + got + (ok ? '' : ' want=' + want));
}
function p(line, forced) {
    const r = sandbox.parseTimestamp(line, forced || null);
    return r ? new Date(r.ms).toISOString() : null;
}
function offOf(line, forced) {
    const r = sandbox.parseTimestamp(line, forced || null);
    return r === null ? 'no match' : (r.off === null ? 'none' : String(r.off));
}

eq('ISO with Z', p('2024-01-15T10:30:00Z'), '2024-01-15T10:30:00.000Z');
eq('ISO with offset +01:00', p('2024-01-15T11:30:00+01:00'), '2024-01-15T10:30:00.000Z');
eq('ISO with -05:00', p('2024-01-15T05:30:00-05:00'), '2024-01-15T10:30:00.000Z');
eq('ISO fractional ms', p('2024-01-15T10:30:00.123Z'), '2024-01-15T10:30:00.123Z');
eq('ISO no offset is not UTC-shifted', offOf('2024-01-15T11:30:00'), 'none');
eq('ISO with Z reports offset 0', offOf('2024-01-15T10:30:00Z'), '0');
eq('Apache combined', p('10.0.0.1 - - [15/Jan/2024:10:30:00 +0000] "GET / HTTP/1.1" 200 2'), '2024-01-15T10:30:00.000Z');
eq('Apache combined -0700', p('1.1.1.1 - - [15/Jan/2024:03:30:00 -0700] "GET / HTTP/1.1" 200 2'), '2024-01-15T10:30:00.000Z');
eq('ALB microseconds', p('1.1.1.1 - - [15/Jan/2024:10:30:00.123456 +0000] "GET / HTTP/1.1" 200 2'), '2024-01-15T10:30:00.123Z');
eq('Apache error no offset', offOf('2024/01/15 10:30:00 [error] 123#0: *1 open() failed'), 'none');
eq('syslog no year no offset', offOf('Jan 15 10:30:00 host proc: msg'), 'none');
eq('epoch seconds', p('1705312200 hello'), '2024-01-15T09:50:00.000Z');
eq('epoch ms', p('1705312200123 hello'), '2024-01-15T09:50:00.123Z');
eq('epoch forced', p('[1705312200] hit', 'epoch'), '2024-01-15T09:50:00.000Z');
eq('epochms forced rejects seconds', p('1705312200', 'epochms'), null);
eq('JSON lines time key', p('{"time":"2024-01-15T11:30:00+01:00","level":"error","msg":"x"}'), '2024-01-15T10:30:00.000Z');
eq('JSON lines ts key', p('{"ts":1705312200,"msg":"x"}'), '2024-01-15T09:50:00.000Z');
eq('JSON lines @timestamp', p('{"@timestamp":"2024-01-15T10:30:00.500Z"}'), '2024-01-15T10:30:00.500Z');
eq('clf forced rejects iso', p('2024-01-15T10:30:00Z', 'clf'), null);
eq('syslog forced rejects iso', p('2024-01-15T10:30:00Z', 'sys'), null);
eq('unparseable line', p('total gibberish with no clock at all'), null);
eq('plain sentence not an epoch', p('connection accepted from client'), null);

// The whole point of the tool: a per source offset changes the instant, and the
// line is marked assumed so the UI can say so.
const raw = sandbox.parseTimestamp('Jan 15 11:30:00 worker: msg', null);
eq('syslog assumed +01:00 lands on', new Date(raw.ms - 60 * 60000).toISOString(), new Date(new Date().getFullYear(), 0, 15, 10, 30, 0).toISOString());
eq('syslog assumed +01:00 flagged', String(raw.off), 'null');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
