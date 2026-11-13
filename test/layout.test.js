// Offline tests for js/layout.js. Run: jsc test/layout.test.js -- js/layout.js
load(arguments[0]);
var fails = 0;
function check(name, cond, info) { print((cond ? 'PASS ' : 'FAIL ') + name + (cond || !info ? '' : '  -> ' + info)); if (!cond) fails++; }
function M(id, kind, dur, cur, track, order) { return { id: id, kind: kind, duration: dur, curStart: cur, trackKey: track, trackOrder: order }; }
function G(members) { var g = { root: Object.keys(members)[0], members: {} }; for (var k in members) g.members[k] = { offset: members[k] }; return g; }
function overlapsWithin(lanes, pos) {
  var bad = 0;
  lanes.forEach(function (l) { var s = l.clips.slice().sort(function (a, b) { return a.start - b.start; });
    for (var i = 1; i < s.length; i++) if (s[i].start < pos[s[i - 1].id].end - 0.01) bad++; });
  return bad;
}
var S = { trimAudio: 'off', unusedAudio: 'park', layout: 'device' };

// --- A: Synq demo style: everything dumped on V1 / A1, 3 cameras + 4 mics, 3 scenes ---
var media = [], groups = [], t = 0;
[[1821, 449, 5278, 300], [1822, 452, 5279, 500], [1823, 453, 5280, 200]].forEach(function (sc, i) {
  var m = {};
  var ids = ['B_CAM' + sc[0] + '.MP4', 'C0' + sc[1] + '.MP4', 'IMG_' + sc[2] + '.MOV'];
  ids.forEach(function (id, k) { media.push(M(id, 'video', sc[3] - k * 7, t, 'V1', 0)); m[id] = k * 3.5; t += 20; });
  for (var mic = 1; mic <= 4; mic++) {
    var id = 'TX0' + mic + '_MIC0' + (10 + i) + '_20260905_1127' + i + mic + '_orig.wav';
    media.push(M(id, 'audio', sc[3] + 30, t, 'A1', 0)); m[id] = -10 - mic; t += 20;
  }
  groups.push(G(m));
});
var devs = Layout.detectDevices(media, Layout.computePositions(media, groups, S).pos);
check('A: 3 camera devices', devs.filter(function (d) { return d.kind === 'video'; }).length === 3, devs.map(function (d) { return d.id; }).join(' | '));
check('A: 4 mic devices', devs.filter(function (d) { return d.kind === 'audio'; }).length === 4);
check('A: each device has 3 clips', devs.every(function (d) { return d.files.length === 3; }));
var plan = Layout.buildPlan(media, groups, devs, S, 0.04);
check('A: one track per camera', plan.videoLanes.length === 3);
check('A: one track per mic', plan.audioLanes.length === 4);
check('A: no overlaps on any track', overlapsWithin(plan.videoLanes.concat(plan.audioLanes), plan.pos) === 0);
var lane0 = plan.videoLanes[0].clips.map(function (c) { return c.id; }).join(',');
check('A: a track holds one camera only', /^B_CAM1821.*B_CAM1822.*B_CAM1823/.test(lane0), lane0);
check('A: 3 scenes', plan.scenes === 3);

// --- B: trim audio to video ---
var planT = Layout.buildPlan(media, groups, devs, { trimAudio: 'video', unusedAudio: 'park', layout: 'device' }, 0.04);
var mic = planT.audioLanes[0].clips[0], cam = planT.videoLanes[0].clips[0];
check('B: mic trimmed', mic.trimmed && mic.mediaIn > 0);
var sceneVideoStart = Math.min.apply(null, planT.videoLanes.map(function (l) { return l.clips[0].start; }));
check('B: trimmed mic starts with first camera', Math.abs(mic.start - sceneVideoStart) < 1e-6, mic.start + ' vs ' + sceneVideoStart);

// --- C: user style: one track per camera, takes on one audio track, unmatched takes ---
media = [M('C0039.MP4', 'video', 423, 117, 'V2', 1), M('C0040.MP4', 'video', 685, 540, 'V3', 2), M('C0037.MP4', 'video', 10, 0, 'V1', 0),
         M('KN Hallo 1.m4a', 'audio', 423, 1545, 'A5', 4), M('KN hallo 2.m4a', 'audio', 686, 1968, 'A5', 4), M('Kn hallo 4.m4a', 'audio', 160, 2878, 'A5', 4)];
groups = [G({ 'KN Hallo 1.m4a': 0, 'C0039.MP4': -1.199 }), G({ 'KN hallo 2.m4a': 0, 'C0040.MP4': 1.914 }), G({ 'C0037.MP4': 0 }), G({ 'Kn hallo 4.m4a': 0 })];
var P = Layout.computePositions(media, groups, S);
devs = Layout.detectDevices(media, P.pos);
check('C: cameras on own tracks stay separate devices', devs.filter(function (d) { return d.kind === 'video'; }).length === 3);
check('C: takes on one track = one recorder', devs.filter(function (d) { return d.kind === 'audio'; }).length === 1);
var last = Math.max(P.pos['KN hallo 2.m4a'].end, P.pos['C0040.MP4'].end);
check('C: unmatched take parked after everything', P.pos['Kn hallo 4.m4a'].start >= last + 9.99, P.pos['Kn hallo 4.m4a'].start + ' vs ' + last);
check('C: synced offset kept', Math.abs((P.pos['C0039.MP4'].start - P.pos['KN Hallo 1.m4a'].start) - (-1.199)) < 1e-9);
var PR = Layout.computePositions(media, groups, { unusedAudio: 'remove' });
check('C: remove option drops unmatched audio', PR.removed.length === 1 && !PR.pos['Kn hallo 4.m4a']);

// --- D: your request: overlapping audio on one track goes to another track ---
media = [M('CAM_A001.MP4', 'video', 300, 0, 'V1', 0),
         M('ZOOM_0001.WAV', 'audio', 320, 400, 'A2', 1), M('ZOOM_0002.WAV', 'audio', 320, 800, 'A2', 1)];
groups = [G({ 'CAM_A001.MP4': 0, 'ZOOM_0001.WAV': -5, 'ZOOM_0002.WAV': -2 })];   // two recorders running at once
P = Layout.computePositions(media, groups, S);
devs = Layout.detectDevices(media, P.pos);
plan = Layout.buildPlan(media, groups, devs, S, 0.04);
check('D: overlapping audio split onto 2 tracks', plan.audioLanes.length === 2, plan.audioLanes.length);
check('D: nothing overlaps', overlapsWithin(plan.audioLanes, plan.pos) === 0);
var planC = Layout.buildPlan(media, groups, devs, { layout: 'compact', unusedAudio: 'park' }, 0.04);
check('D: compact layout also avoids overlaps', overlapsWithin(planC.audioLanes, planC.pos) === 0 && planC.audioLanes.length === 2);

// --- E: nudge moves one device by frames ---
devs[0].nudge = 2;
var planN = Layout.buildPlan(media, groups, devs, S, 0.04);
check('E: nudge +2 frames', Math.abs(planN.videoLanes[0].clips[0].start - plan.videoLanes[0].clips[0].start - 0.08) < 1e-9);

check('name signature', Layout.nameSignature('/x/TX01_MIC004_20260905_112715_orig.wav') === 'tx01_mic#_#_#_orig.wav' &&
      Layout.nameSignature('C0449.MP4') === 'c#.mp4' && Layout.nameSignature('KN Hallo 3.m4a') === 'kn hallo #.m4a');
print(fails ? fails + ' FAILED' : 'all passed');
