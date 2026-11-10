// SPDX-License-Identifier: GPL-3.0-or-later
// O0 config -> host outputs.configure params (pure; no host process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { plan, planFile, readServerSchemes, validLiveUrl } from '../lib/outputs-plan.mjs';
import { HOST_DIR, REPO_ROOT } from '../lib/config.mjs';

const O1 = path.join(HOST_DIR, 'outputs', 'o1-loopback.json');

test('o1-loopback plan: deduped rungs, sinks bound to rungs, one audio track, loopback targets', () => {
  const { params, report } = planFile(O1);
  assert.equal(report.errors.length, 0);
  assert.deepEqual(params.rungs.map((r) => r.id), ['yt-h', 'reencode-tk', 'vert']);
  const byRung = Object.fromEntries(params.rungs.map((r) => [r.id, params.sinks.filter((s) => s.rung === r.id).map((s) => s.id)]));
  assert.deepEqual(byRung, { 'yt-h': ['youtube-h', 'rec-h'], 'reencode-tk': ['twitch', 'kick'], vert: ['youtube-v'] });
  assert.deepEqual(params.audio, { bitrate: 160, sampleRate: 48000 });
  for (const s of params.sinks) {
    assert.ok(['rtmp', 'srt', 'file'].includes(s.target.transport));
    assert.equal(JSON.stringify(s.target).includes('://'), false, 'no URLs in targets: the host builds them');
  }
});

test('platform limits come from data/platforms: an over-limit rung is an error', () => {
  const { config, wrapper } = planFile(O1);
  const bad = structuredClone(config);
  bad.encoders.find((e) => e.id === 'reencode-tk').bitrate = 9000; // twitch max is in data/platforms/twitch.json
  assert.throws(() => plan(bad, wrapper.targets), /output config has errors/);
});

test('every sink needs a target, and targets must name sinks', () => {
  const { config, wrapper } = planFile(O1);
  const t = { ...wrapper.targets };
  delete t.kick;
  assert.throws(() => plan(config, t), /"kick" has no target/);
  assert.throws(() => plan(config, { ...wrapper.targets, ghost: { transport: 'file', name: 'g.mkv' } }), /names no sink/);
});

test('identical encoders are merged into one rung (dedup from the O0 validator)', () => {
  const { config, wrapper } = planFile(O1);
  const c = structuredClone(config);
  c.encoders.push({ ...c.encoders.find((e) => e.id === 'reencode-tk'), id: 'reencode-copy' });
  c.sinks.find((s) => s.id === 'kick').encoder = 'reencode-copy';
  const { params } = plan(c, wrapper.targets);
  assert.equal(params.rungs.length, 3);
  assert.equal(params.sinks.find((s) => s.id === 'kick').rung, 'reencode-tk');
});

test('o2-loopback plan: YouTube 1440p60 H direct, one Multi rung 1920x1080@60 CBR 6000 on H for twitch + kick', () => {
  const { params } = planFile(path.join(HOST_DIR, 'outputs', 'o2-loopback.json'));
  assert.deepEqual(params.rungs.map((r) => `${r.id}:${r.canvas}:${r.w}x${r.h}@${r.fps}:${r.rc}:${r.bitrate}`),
    ['yt-h:H:2560x1440@60:cbr:34000', 'reencode-tk:H:1920x1080@60:cbr:6000', 'vert:V:1080x1920@60:cbr:7500']);
  const rungOf = Object.fromEntries(params.sinks.map((s) => [s.id, s.rung]));
  assert.deepEqual(rungOf, { 'youtube-h': 'yt-h', 'youtube-v': 'vert', twitch: 'reencode-tk', kick: 'reencode-tk' });
  for (const s of params.sinks) assert.ok(s.target.port && s.target.port !== 8093, `${s.id}: loopback port`);
  assert.equal(params.audio.sampleRate, 48000);
});

// ---- A0 real targets (pure planning; no host, no keychain, no network) -------------------------------------------
const ALPHA = path.join(REPO_ROOT, 'data', 'outputs', 'alpha-live.json');
const alpha = () => planFile(ALPHA, { allowLive: true });

test('alpha-live plan: YouTube H 1080p60 17 Mbps (D182) + V direct, Multi rung -> twitch + kick, mkv recording on yt-h; keyRefs only', () => {
  const { params, live } = alpha();
  assert.deepEqual(params.rungs.map((r) => `${r.id}:${r.canvas}:${r.w}x${r.h}@${r.fps}:${r.rc}:${r.bitrate}`),
    ['yt-h:H:1920x1080@60:cbr:17000', 'reencode-tk:H:1920x1080@60:cbr:6000', 'vert:V:1080x1920@60:cbr:7500']);
  const rungOf = Object.fromEntries(params.sinks.map((s) => [s.id, s.rung]));
  assert.deepEqual(rungOf, { 'youtube-h': 'yt-h', 'youtube-v': 'vert', twitch: 'reencode-tk', kick: 'reencode-tk', record: 'yt-h', 'record-v': 'vert' });
  assert.deepEqual(live, ['youtube-h', 'youtube-v', 'twitch', 'kick']);
  const t = Object.fromEntries(params.sinks.map((s) => [s.id, s.target]));
  assert.deepEqual(t['youtube-h'], { transport: 'rtmps', url: 'rtmps://a.rtmps.youtube.com:443/live2', keyRef: 'Ujwalam/stream/youtube-h' });
  assert.deepEqual(t.kick, { transport: 'rtmps', urlRef: 'Ujwalam/stream/kick-server', keyRef: 'Ujwalam/stream/kick' });
  // Twitch is "auto" (D309 proposed): unresolved without the stored scheme (validation only; the host refuses "auto").
  assert.deepEqual(t.twitch, { transport: 'auto', urlRef: 'Ujwalam/stream/twitch-server', keyRef: 'Ujwalam/stream/twitch' });
  assert.deepEqual(alpha().unresolved, ['twitch']);
  assert.deepEqual(t.record, { transport: 'file', name: 'alpha.mkv' });
  // LC1 (D333 proposed): the V canvas is recorded too, on the V stream's rung; "optional" is plan-only (not sent)
  assert.deepEqual(t['record-v'], { transport: 'file', name: 'alpha-v.mkv' });
  assert.equal(params.rungs.length, 3, 'two recordings, still three encoders');
  const text = readFileSync(ALPHA, 'utf8');
  assert.equal(/"(key|streamKey|stream_key|password|secret)"\s*:/i.test(text), false, 'no key fields in the committed plan');
});

test('real targets are refused without allowLive (the host also needs --allow-live)', () => {
  assert.throws(() => planFile(ALPHA), /real \(non-loopback\) targets .* refused: plan with allowLive .*--allow-live/);
});

test('real target rules: keyRef name, server from data or serverRef, transport = proto = platform protocol', () => {
  const { config, wrapper } = alpha();
  const go = (patch) => plan(config, { ...wrapper.targets, ...patch }, { allowLive: true });
  assert.throws(() => go({ 'youtube-h': { transport: 'rtmps', server: 'primary-rtmps' } }), /keyRef must match/);
  assert.throws(() => go({ 'youtube-h': { transport: 'rtmps', server: 'primary-rtmps', keyRef: 'Ujwalam/streamerbot' } }), /keyRef must match/);
  assert.throws(() => go({ 'youtube-h': { transport: 'rtmps', server: 'primary-rtmps', keyRef: 'Ujwalam/stream/youtube-h', key: 'x' } }), /unknown real-target field "key"/);
  assert.throws(() => go({ 'youtube-h': { transport: 'rtmps', server: 'nope', keyRef: 'Ujwalam/stream/youtube-h' } }), /unknown youtube ingest server "nope"/);
  assert.throws(() => go({ 'youtube-h': { transport: 'rtmps', server: 'primary-rtmps', serverRef: 'Ujwalam/stream/x', keyRef: 'Ujwalam/stream/youtube-h' } }), /exactly one of server/);
  assert.throws(() => go({ 'youtube-h': { transport: 'rtmp', server: 'primary-rtmp', keyRef: 'Ujwalam/stream/youtube-h' } }), /must equal the sink proto rtmps/);
  assert.throws(() => go({ kick: { transport: 'rtmps', server: 'x', keyRef: 'Ujwalam/stream/kick' } }), /kick ingest servers are chosen per user\/account .* use serverRef/);
  assert.throws(() => go({ 'youtube-v': { transport: 'rtmps', server: 'primary-rtmps', keyRef: 'Ujwalam/stream/youtube-h' } }), /already used by sink "youtube-h"/);
  assert.throws(() => go({ kick: { transport: 'rtmps', serverRef: 'Ujwalam/stream/kick', keyRef: 'Ujwalam/stream/kick' } }), /must be different credentials/);
  // a platform whose protocols do not include the transport (kick: rtmps only per data/platforms/kick.json)
  const c2 = structuredClone(config);
  c2.sinks.find((s) => s.id === 'kick').proto = 'rtmp';
  assert.throws(() => plan(c2, { ...wrapper.targets, kick: { transport: 'rtmp', serverRef: 'Ujwalam/stream/kick-server', keyRef: 'Ujwalam/stream/kick' } }, { allowLive: true }), /kick does not take rtmp/);
  assert.throws(() => go({ kick: { transport: 'rtmps', port: 19453, app: 'live', stream: 'kick' } }), /an rtmps target is a real target/);
});

test('every ingest URL in data/platforms is a valid live URL with source and checked date', () => {
  for (const id of ['youtube', 'twitch', 'kick']) {
    const p = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'platforms', `${id}.json`), 'utf8'));
    assert.ok(p.ingest?.source && /^\d{4}-\d{2}-\d{2}$/.test(p.ingest.checked), `${id}.ingest source + checked`);
    for (const s of p.ingest.value.servers) assert.ok(validLiveUrl(s.url, s.proto), `${id} ${s.id}`);
  }
  for (const bad of ['rtmps://127.0.0.1/live2', 'rtmps://localhost/app', 'rtmps://u:p@host.example/app', 'rtmps://host.example/app?key=1',
    'rtmp://host.example/app', 'rtmps://host.example:0/app', 'rtmps://host.example/a b'])
    assert.equal(validLiveUrl(bad, 'rtmps'), false, bad);
  assert.equal(validLiveUrl('rtmps://abc123.global-contribute.live-video.net:443/app/', 'rtmps'), true);
});

test('recording: .mkv by default; another container only when the target says unsafeContainer (and the error says why)', () => {
  const { config, wrapper } = alpha();
  const go = (rec) => plan(config, { ...wrapper.targets, record: rec }, { allowLive: true });
  assert.throws(() => go({ transport: 'file', name: 'alpha.mp4' }), /\.mp4 is refused because it is not crash-safe .* "unsafeContainer": true/);
  assert.throws(() => go({ transport: 'file', name: 'alpha.flv' }), /not crash-safe/);
  assert.equal(go({ transport: 'file', name: 'alpha.mp4', unsafeContainer: true }).params.sinks.find((s) => s.id === 'record').target.unsafeContainer, true);
});

test('recording binds to an existing stream rung (no extra encoder) unless ownRung', () => {
  const { config, wrapper } = alpha();
  const c = structuredClone(config);
  c.encoders.push({ id: 'rec-only', canvas: 'H', w: 1920, h: 1080, codec: 'h264', bitrate: 40000, rc: 'cbr', gop_sec: 2, encoder: 'nvenc' });
  c.sinks.find((s) => s.id === 'record').encoder = 'rec-only';
  assert.throws(() => plan(c, wrapper.targets, { allowLive: true }), /feeds no stream sink, so it would add an encoder/);
  const ok = plan(c, { ...wrapper.targets, record: { transport: 'file', name: 'alpha.mkv', ownRung: true } }, { allowLive: true });
  assert.equal(ok.params.sinks.find((s) => s.id === 'record').target.ownRung, undefined, 'plan-only field is not sent to the host');
});

test('optional recording (LC1): left out, not refused, when its rung feeds no stream; never adds an encoder', () => {
  // --sinks without the V stream: record-v (on vert) is dropped and the vert rung is not created
  const r = planFile(ALPHA, { allowLive: true, select: ['youtube-h'] });
  assert.deepEqual(r.dropped, ['record-v']);
  assert.deepEqual(r.params.sinks.map((s) => s.id), ['youtube-h', 'record']);
  assert.deepEqual(r.params.rungs.map((x) => x.id), ['yt-h']);
  // with the V stream it stays, on vert
  const v = planFile(ALPHA, { allowLive: true, select: ['youtube-v', 'youtube-h'] });
  assert.deepEqual(v.dropped, []);
  assert.equal(v.params.sinks.find((s) => s.id === 'record-v').rung, 'vert');
  // the same recording without "optional" is refused as before
  const { config, wrapper } = alpha();
  const c = structuredClone(config);
  c.sinks = c.sinks.filter((s) => s.id !== 'youtube-v');
  const tg = Object.fromEntries(Object.entries(wrapper.targets).filter(([id]) => id !== 'youtube-v'));
  assert.throws(() => plan(c, { ...tg, 'record-v': { transport: 'file', name: 'alpha-v.mkv' } }, { allowLive: true }), /feeds no stream sink, so it would add an encoder/);
  assert.throws(() => plan(c, { ...tg, 'record-v': { transport: 'file', name: 'alpha-v.mkv', optional: 'yes' } }, { allowLive: true }), /"optional" must be true/);
  // a plan with no stream at all keeps an optional recording (a recording-only plan)
  const recOnly = { ...c, sinks: c.sinks.filter((s) => s.proto === 'file') };
  const ro = plan(recOnly, { record: tg.record, 'record-v': { transport: 'file', name: 'alpha-v.mkv', optional: true } });
  assert.deepEqual(ro.params.sinks.map((s) => s.id), ['record', 'record-v']);
});

test('loopback rtmp may carry a keyRef instead of a stream name (key path test); no allowLive needed', () => {
  const { config, wrapper } = planFile(path.join(HOST_DIR, 'outputs', 'o2-loopback.json'));
  const { params, live } = plan(config, { ...wrapper.targets, kick: { transport: 'rtmp', port: 19453, app: 'live', keyRef: 'Ujwalam/stream/test-x' } });
  assert.deepEqual(live, []);
  assert.deepEqual(params.sinks.find((s) => s.id === 'kick').target, { transport: 'rtmp', port: 19453, app: 'live', keyRef: 'Ujwalam/stream/test-x' });
});

// ---- Twitch either scheme (D309 proposed): "auto" follows the stored server address's scheme ----------------------
const SECRET_HOST = 'secret-ingest-zz9.example'; // stands for the stored address; must never appear in a plan or error
const facts = (scheme) => ({ present: true, scheme });
const live = (schemes, select) => planFile(ALPHA, { allowLive: true, schemes, ...(select ? { select } : {}) });

test('twitch "auto": a stored rtmp:// or rtmps:// address picks the transport (sink proto follows); kick stays rtmps', () => {
  for (const sch of ['rtmp', 'rtmps']) {
    const r = live({ 'Ujwalam/stream/twitch-server': facts(sch), 'Ujwalam/stream/kick-server': facts('rtmps') });
    const tw = r.params.sinks.find((s) => s.id === 'twitch');
    assert.deepEqual(tw.target, { transport: sch, urlRef: 'Ujwalam/stream/twitch-server', keyRef: 'Ujwalam/stream/twitch' });
    assert.equal(tw.proto, sch, 'the host requires proto = transport');
    assert.deepEqual(r.unresolved, []);
    const k = r.params.sinks.find((s) => s.id === 'kick');
    assert.equal(k.target.transport, 'rtmps'); assert.equal(k.proto, 'rtmps');
  }
});

test('twitch "auto": another scheme, no scheme, no stored address or an unreadable one is refused, naming the target only', () => {
  const kick = { 'Ujwalam/stream/kick-server': facts('rtmps') };
  const cases = [
    [{ ...kick, 'Ujwalam/stream/twitch-server': facts('https') }, /sink "twitch": the server address in Windows Credential Manager target Ujwalam\/stream\/twitch-server starts with https:\/\/, but twitch takes only rtmp:\/\/ or rtmps:\/\/\. Set it again with: node services\/event-core\/cli\.mjs credential set --target Ujwalam\/stream\/twitch-server/],
    [{ ...kick, 'Ujwalam/stream/twitch-server': facts(null) }, /starts with no rtmp:\/\/ or rtmps:\/\/, but twitch takes only/],
    [{ ...kick, 'Ujwalam/stream/twitch-server': { present: false, scheme: null } }, /no server address is stored in Windows Credential Manager target Ujwalam\/stream\/twitch-server\. Set it \(rtmp:\/\/ or rtmps:\/\/\)/],
    [{ ...kick, 'Ujwalam/stream/twitch-server': { error: true } }, /target Ujwalam\/stream\/twitch-server could not be read/],
    [{ ...kick }, /twitch-server could not be read/],
  ];
  for (const [schemes, re] of cases) {
    let err;
    try { live(schemes); } catch (e) { err = e; }
    assert.ok(err, JSON.stringify(schemes));
    assert.match(err.message, re);
    assert.ok(!err.message.includes(SECRET_HOST));
  }
  // leaving twitch out (--sinks) does not need its address
  assert.deepEqual(live({}, ['youtube-h']).unresolved, []);
});

test('kick (named rtmps): a stored rtmp:// address is refused at build time; missing/unreadable left to host + readiness', () => {
  const tw = { 'Ujwalam/stream/twitch-server': facts('rtmps') };
  assert.throws(() => live({ ...tw, 'Ujwalam/stream/kick-server': facts('rtmp') }),
    /sink "kick": the server address in Windows Credential Manager target Ujwalam\/stream\/kick-server starts with rtmp:\/\/, but this output sends rtmps:\/\/ \(kick takes rtmps:\/\/\)/);
  assert.equal(live({ ...tw, 'Ujwalam/stream/kick-server': { present: false, scheme: null } }).params.sinks.find((s) => s.id === 'kick').target.transport, 'rtmps');
  assert.equal(live({ ...tw, 'Ujwalam/stream/kick-server': { error: true } }).params.sinks.find((s) => s.id === 'kick').target.transport, 'rtmps');
});

test('"auto" rules: serverRef only, a platform with both rtmp and rtmps, never a loopback form', () => {
  const { config, wrapper } = alpha();
  const go = (patch) => plan(config, { ...wrapper.targets, ...patch }, { allowLive: true });
  assert.throws(() => go({ kick: { transport: 'auto', serverRef: 'Ujwalam/stream/kick-server', keyRef: 'Ujwalam/stream/kick' } }),
    /sink "kick": transport "auto" needs a platform that takes both rtmp and rtmps; kick takes rtmps/);
  assert.throws(() => go({ 'youtube-h': { transport: 'auto', server: 'primary-rtmps', keyRef: 'Ujwalam/stream/youtube-h' } }), /transport "auto" needs serverRef/);
  assert.throws(() => go({ twitch: { transport: 'auto', port: 19452, app: 'live', stream: 'twitch' } }), /an auto target is a real target \(serverRef, and keyRef\)/);
});

test('readServerSchemes: reads only the plan\'s (selected) serverRefs, keeps scheme facts only, a failed read is { error }', async () => {
  const asked = [];
  const values = { 'Ujwalam/stream/twitch-server': `rtmp://${SECRET_HOST}/app`, 'Ujwalam/stream/kick-server': null };
  const readFacts = async (ref) => {
    asked.push(ref);
    const v = values[ref];
    return { present: typeof v === 'string', scheme: typeof v === 'string' ? v.slice(0, v.indexOf(':')) : undefined };
  };
  const all = await readServerSchemes(ALPHA, readFacts);
  assert.deepEqual(asked.sort(), ['Ujwalam/stream/kick-server', 'Ujwalam/stream/twitch-server']);
  assert.deepEqual(all, { 'Ujwalam/stream/twitch-server': { present: true, scheme: 'rtmp' }, 'Ujwalam/stream/kick-server': { present: false, scheme: null } });
  assert.ok(!JSON.stringify(all).includes(SECRET_HOST));
  asked.length = 0;
  assert.deepEqual(await readServerSchemes(ALPHA, readFacts, { select: ['youtube-h', 'twitch'] }), { 'Ujwalam/stream/twitch-server': { present: true, scheme: 'rtmp' } });
  assert.deepEqual(asked, ['Ujwalam/stream/twitch-server']);
  assert.deepEqual(await readServerSchemes(ALPHA, async () => { throw new Error(`boom ${SECRET_HOST}`); }, { select: ['twitch'] }), { 'Ujwalam/stream/twitch-server': { error: true } });
  const r = planFile(ALPHA, { allowLive: true, schemes: all, select: ['youtube-h', 'twitch'] });
  assert.equal(r.params.sinks.find((s) => s.id === 'twitch').target.transport, 'rtmp');
  assert.ok(!JSON.stringify(r.params).includes(SECRET_HOST));
});
