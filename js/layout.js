/*
 * WaveSync layout: turns sync results into a timeline plan. Pure JavaScript, no dependencies.
 *
 *   media:  [{ id, kind: 'video'|'audio', duration, curStart, trackKey: 'V1', trackOrder }]
 *   groups: SyncCore.buildGroups() output
 *
 * Steps: place scenes in time (positions) -> work out which files came from the same
 * device (detectDevices) -> give each device its own track(s), with an extra track
 * whenever two of its clips would overlap (buildPlan).
 */
(function (root) {
  'use strict';

  var SCENE_GAP = 2;    // seconds between scenes
  var PARK_GAP = 10;    // seconds between the last scene and parked audio
  var EPS = 0.01;

  // Premiere's 16 label colours, by label index.
  var LABELS = [
    { name: 'Violet', hex: '#a990dd' }, { name: 'Iris', hex: '#e5a3f2' }, { name: 'Caribbean', hex: '#1cc6b0' },
    { name: 'Lavender', hex: '#e384e3' }, { name: 'Cerulean', hex: '#1aa8e7' }, { name: 'Forest', hex: '#79b43c' },
    { name: 'Rose', hex: '#f55e8a' }, { name: 'Mango', hex: '#f89c3a' }, { name: 'Purple', hex: '#9c43d8' },
    { name: 'Blue', hex: '#3361e0' }, { name: 'Teal', hex: '#0e9a92' }, { name: 'Magenta', hex: '#e8217e' },
    { name: 'Tan', hex: '#c69b6b' }, { name: 'Green', hex: '#43c242' }, { name: 'Brown', hex: '#8f5a2c' },
    { name: 'Yellow', hex: '#e6d03a' }
  ];
  var VIDEO_COLORS = [2, 7, 15, 6, 4, 3, 0, 12];
  var AUDIO_COLORS = [13, 5, 10, 9, 11, 14, 8, 1];

  function minOf(a, f) { var m = Infinity; a.forEach(function (x) { m = Math.min(m, f(x)); }); return m; }
  function maxOf(a, f) { var m = -Infinity; a.forEach(function (x) { m = Math.max(m, f(x)); }); return m; }

  function baseName(p) { return String(p).split(/[\\/]/).pop(); }

  /*
   * Device-ish fingerprint of a file name: the running clip number is replaced, the device
   * part is kept. "C0449.MP4" -> "c#.mp4", "TX01_MIC004_20260905_112715_orig.wav" ->
   * "tx01_mic#_#_#_orig.wav", "KN Hallo 3.m4a" -> "kn hallo #.m4a".
   */
  function nameSignature(p) {
    var base = baseName(p).toLowerCase(), m = base.match(/\.[^.]+$/), ext = m ? m[0] : '';
    var stem = base.slice(0, base.length - ext.length);
    return stem.replace(/\d+$/, '#').replace(/\d{3,}/g, '#') + ext;
  }

  /*
   * Timeline positions for every file. Scenes keep the order they had on the timeline and
   * are laid out back to back. Returns { pos: { id: { start, end, mediaIn, mediaOut, scene } },
   * removed: [ids], scenes: count }.
   */
  function computePositions(media, groups, settings) {
    var byId = {};
    media.forEach(function (m) { byId[m.id] = m; });

    var blocks = groups.map(function (g) {
      var ids = Object.keys(g.members).filter(function (id) { return byId[id]; });
      var clips = ids.map(function (id) {
        return { id: id, rel: g.members[id].offset, mediaIn: 0, mediaOut: byId[id].duration };
      });
      var matched = clips.length > 1;
      if (matched && settings.trimAudio === 'video') {
        var vids = clips.filter(function (c) { return byId[c.id].kind === 'video'; });
        if (vids.length) {
          var s0 = minOf(vids, function (c) { return c.rel; }), s1 = maxOf(vids, function (c) { return c.rel + c.mediaOut; });
          clips.forEach(function (c) {
            if (byId[c.id].kind !== 'audio') return;
            var a = Math.max(0, s0 - c.rel), b = Math.min(c.mediaOut, s1 - c.rel);
            if (b - a > 1) { c.mediaIn = a; c.mediaOut = b; }
          });
        }
      }
      return { clips: clips, matched: matched,
               unusedAudio: !matched && byId[clips[0].id].kind === 'audio',
               curStart: minOf(clips, function (c) { return byId[c.id].curStart; }) };
    }).filter(function (b) { return b.clips.length; })
      .sort(function (a, b) { return a.curStart - b.curStart; });

    var pos = {}, removed = [], scene = 0;
    var cursor = blocks.length ? blocks[0].curStart : 0;
    function place(b) {
      var lo = minOf(b.clips, function (c) { return c.rel + c.mediaIn; });
      var hi = maxOf(b.clips, function (c) { return c.rel + c.mediaOut; });
      var anchor = cursor - lo, sc = b.matched ? scene++ : null;
      b.clips.forEach(function (c) {
        pos[c.id] = { start: anchor + c.rel + c.mediaIn, end: anchor + c.rel + c.mediaOut,
                      mediaIn: c.mediaIn, mediaOut: c.mediaOut, scene: sc };
      });
      cursor = anchor + hi + SCENE_GAP;
    }

    var mode = settings.unusedAudio || 'park';
    blocks.forEach(function (b) { if (!b.unusedAudio || mode === 'inline') place(b); });
    var parked = blocks.filter(function (b) { return b.unusedAudio && mode === 'park'; });
    if (parked.length) cursor += PARK_GAP - SCENE_GAP;
    parked.forEach(place);
    blocks.forEach(function (b) {
      if (b.unusedAudio && mode === 'remove') b.clips.forEach(function (c) { removed.push(c.id); });
    });
    return { pos: pos, removed: removed, scenes: scene };
  }

  // Greedy interval packing: a clip goes on the first lane that is free at its start.
  function packLanes(ids, pos) {
    var lanes = [], ends = [];
    ids.slice().sort(function (a, b) { return pos[a].start - pos[b].start; }).forEach(function (id) {
      for (var i = 0; i < lanes.length; i++) {
        if (pos[id].start >= ends[i] - EPS) { lanes[i].push(id); ends[i] = pos[id].end; return; }
      }
      lanes.push([id]); ends.push(pos[id].end);
    });
    return lanes;
  }

  /*
   * Which files came from the same camera or recorder.
   *  - A track whose clips never overlap after syncing was set up per device, so everything
   *    on it is one device.
   *  - On a track where everything was dumped together (clips overlap once synced), files
   *    are told apart by file-name pattern plus media format (sig).
   * Returns devices in display order: cameras first, then audio recorders.
   */
  function detectDevices(media, pos) {
    var byTrack = {};
    media.forEach(function (m) {
      if (!pos[m.id]) return;
      var k = m.kind + '|' + m.trackKey;
      (byTrack[k] = byTrack[k] || []).push(m);
    });

    var byKey = {}, devices = [];
    Object.keys(byTrack).forEach(function (k) {
      var list = byTrack[k];
      var perDevice = packLanes(list.map(function (m) { return m.id; }), pos).length === 1;
      list.forEach(function (m) {
        var key = perDevice ? 'track:' + k : 'sig:' + m.kind + '|' + (m.sig || nameSignature(m.id));
        var d = byKey[key];
        if (!d) {
          d = byKey[key] = { id: key, kind: m.kind, files: [], trackOrder: m.trackOrder, nudge: 0 };
          devices.push(d);
        }
        d.files.push(m.id);
        d.trackOrder = Math.min(d.trackOrder, m.trackOrder);
      });
    });

    devices.forEach(function (d) {
      d.files.sort(function (a, b) { return pos[a].start - pos[b].start; });
      d.firstStart = pos[d.files[0]].start;
      d.name = baseName(d.files[0]);
    });
    devices.sort(function (a, b) {
      return (a.kind === b.kind ? 0 : a.kind === 'video' ? -1 : 1) ||
             (a.trackOrder - b.trackOrder) || (a.firstStart - b.firstStart);
    });
    var v = 0, a = 0;
    devices.forEach(function (d) {
      d.color = d.kind === 'video' ? VIDEO_COLORS[v++ % VIDEO_COLORS.length] : AUDIO_COLORS[a++ % AUDIO_COLORS.length];
    });
    return devices;
  }

  /*
   * The plan the Premiere side executes. settings: { trimAudio, unusedAudio, layout,
   * cameraAudio, link }. frameDur: sequence frame duration in seconds (for nudges).
   * Returns { videoLanes, audioLanes, removed, scenes, pos } where each lane is
   * { device, color, clips: [{ id, start, mediaIn, mediaOut, trimmed, scene }] }.
   */
  function buildPlan(media, groups, devices, settings, frameDur) {
    var P = computePositions(media, groups, settings), pos = P.pos;
    var byId = {};
    media.forEach(function (m) { byId[m.id] = m; });

    devices.forEach(function (d) {
      if (!d.nudge) return;
      d.files.forEach(function (id) {
        if (pos[id]) { pos[id].start += d.nudge * frameDur; pos[id].end += d.nudge * frameDur; }
      });
    });

    function clipOf(id) {
      var p = pos[id], m = byId[id];
      return { id: id, start: p.start, mediaIn: p.mediaIn, mediaOut: p.mediaOut, scene: p.scene,
               trimmed: p.mediaIn > EPS || p.mediaOut < m.duration - EPS };
    }
    function lanesFor(list, kind) {
      var out = [];
      if (settings.layout === 'compact') {
        var ids = [], colorOf = {};
        list.forEach(function (d) { d.files.forEach(function (id) { if (pos[id]) { ids.push(id); colorOf[id] = d.color; } }); });
        packLanes(ids, pos).forEach(function (lane, i) {
          out.push({ device: kind + '-lane-' + i, clips: lane.map(function (id) { var c = clipOf(id); c.color = colorOf[id]; return c; }) });
        });
        return out;
      }
      list.forEach(function (d) {
        packLanes(d.files.filter(function (id) { return pos[id]; }), pos).forEach(function (lane) {
          out.push({ device: d.id, clips: lane.map(function (id) { var c = clipOf(id); c.color = d.color; return c; }) });
        });
      });
      return out;
    }

    return {
      videoLanes: lanesFor(devices.filter(function (d) { return d.kind === 'video'; }), 'video'),
      audioLanes: lanesFor(devices.filter(function (d) { return d.kind === 'audio'; }), 'audio'),
      removed: P.removed, scenes: P.scenes, pos: pos
    };
  }

  var Layout = {
    LABELS: LABELS, nameSignature: nameSignature, computePositions: computePositions,
    packLanes: packLanes, detectDevices: detectDevices, buildPlan: buildPlan
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Layout;
  root.Layout = Layout;
})(typeof window !== 'undefined' ? window : this);
