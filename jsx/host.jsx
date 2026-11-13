/*
 * WaveSync — Premiere Pro side (ExtendScript, ES3).
 * Reads clips from the active sequence and lays them out again from a plan made by the
 * panel: one track (or more) per device, colour labels, trims, camera audio handling, links.
 * Every function returns a JSON string.
 */
var WaveSync = (function () {

  var TICKS = 254016000000;
  var projectItems = {};   // media path -> ProjectItem, filled by getItems
  var timeMode = null;     // which time format overwriteClip accepts, found on first use
  var inOutMode = null;    // which unit setInPoint/setOutPoint accept

  function q(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
  }

  function toJSON(v) {
    var i, out, k;
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return q(v);
    if (v instanceof Array) {
      out = [];
      for (i = 0; i < v.length; i++) out.push(toJSON(v[i]));
      return '[' + out.join(',') + ']';
    }
    out = [];
    for (k in v) if (v.hasOwnProperty(k)) out.push(q(k) + ':' + toJSON(v[k]));
    return '{' + out.join(',') + '}';
  }

  function tracksOf(seq, type) { return type === 'V' ? seq.videoTracks : seq.audioTracks; }

  function eachClip(seq, fn) {
    var types = ['V', 'A'];
    for (var t = 0; t < types.length; t++) {
      var tracks = tracksOf(seq, types[t]);
      for (var i = 0; i < tracks.numTracks; i++) {
        var clips = tracks[i].clips;
        for (var j = 0; j < clips.numItems; j++) fn(clips[j], types[t], i);
      }
    }
  }

  function mediaPath(item) {
    try { return item.projectItem ? item.projectItem.getMediaPath() : ''; } catch (e) { return ''; }
  }

  function frameDuration(seq) {
    var tb = Number(seq.timebase);
    return tb > 0 ? tb / TICKS : 1 / 25;
  }

  function getItems(useAll) {
    try {
      var seq = app.project.activeSequence;
      if (!seq) return toJSON({ ok: false, error: 'Open a sequence first.' });
      var items = [];
      eachClip(seq, function (c, type, track) {
        if (!useAll && !c.isSelected()) return;
        var path = mediaPath(c), speed = 1;
        try { speed = c.getSpeed(); } catch (e2) {}
        if (path && c.projectItem) projectItems[path] = c.projectItem;
        items.push({
          nodeId: c.nodeId, type: type, track: track, name: c.name, path: path || '',
          start: c.start.seconds, end: c.end.seconds, inPoint: c.inPoint.seconds, speed: speed
        });
      });
      return toJSON({ ok: true, sequence: seq.name, sequenceId: seq.sequenceID,
                      frameDur: frameDuration(seq), items: items });
    } catch (e) {
      return toJSON({ ok: false, error: 'getItems: ' + e });
    }
  }

  function findProjectItem(bin, path) {
    for (var i = 0; i < bin.children.numItems; i++) {
      var c = bin.children[i];
      if (c.type === 2) { var r = findProjectItem(c, path); if (r) return r; }
      else { try { if (c.getMediaPath() === path) return c; } catch (e) {} }
    }
    return null;
  }

  function projectItemFor(path) {
    if (!projectItems[path]) projectItems[path] = findProjectItem(app.project.rootItem, path);
    return projectItems[path];
  }

  function sequenceNames() {
    var names = {}, seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences; i++) names[seqs[i].name] = true;
    return names;
  }

  function sequenceById(id) {
    var seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences; i++) if (seqs[i].sequenceID === id) return seqs[i];
    return null;
  }

  function activate(seq) {
    try { app.project.activeSequence = seq; } catch (e1) {}
    if (!app.project.activeSequence || app.project.activeSequence.sequenceID !== seq.sequenceID) {
      try { app.project.openSequence(seq.sequenceID); } catch (e2) {}
    }
  }

  /*
   * Copies seq as "<name> - <suffix>" (numbered if taken). Premiere switches to the new
   * copy after clone(), so the original is made active again.
   */
  function copySequence(seq, suffix) {
    var before = {}, seqs = app.project.sequences, i, copy = null;
    for (i = 0; i < seqs.numSequences; i++) before[seqs[i].sequenceID] = true;
    seq.clone();
    seqs = app.project.sequences;
    for (i = 0; i < seqs.numSequences; i++) if (!before[seqs[i].sequenceID]) { copy = seqs[i]; break; }
    if (!copy) return null;

    var names = sequenceNames(), base = seq.name + ' - ' + suffix, name = base, n = 2;
    while (names[name]) name = base + ' ' + n++;
    try { copy.projectItem.name = name; } catch (e1) { try { copy.name = name; } catch (e2) {} }
    activate(seq);
    return { name: name, id: copy.sequenceID };
  }

  function removeNodes(seq, ids) {
    var want = {}, i, removed = 0;
    for (i = 0; i < ids.length; i++) want[ids[i]] = true;
    var found = true;
    while (found) {
      found = false;
      eachClip(seq, function (c) {
        if (found || !want[c.nodeId]) return;
        want[c.nodeId] = false;
        c.remove(0, 0);
        removed++;
        found = true;
      });
    }
    return removed;
  }

  function highestUsedTrack(seq, type) {
    var tracks = tracksOf(seq, type), top = -1;
    for (var i = 0; i < tracks.numTracks; i++) if (tracks[i].clips.numItems) top = i;
    return top;
  }

  // Adds tracks through Premiere's QE DOM when the sequence has too few.
  function ensureTracks(nV, nA) {
    var seq = app.project.activeSequence, v = seq.videoTracks.numTracks, a = seq.audioTracks.numTracks;
    if (v >= nV && a >= nA) return;
    try {
      app.enableQE();
      qe.project.getActiveSequence().addTracks(Math.max(0, nV - v), v, Math.max(0, nA - a), 1, a, 0, 0, 0);
    } catch (e) {}
    seq = app.project.activeSequence;
    if (seq.videoTracks.numTracks < nV || seq.audioTracks.numTracks < nA)
      throw new Error('Premiere did not add tracks. Add ' + Math.max(0, nV - seq.videoTracks.numTracks) +
        ' video and ' + Math.max(0, nA - seq.audioTracks.numTracks) + ' audio tracks (Sequence > Add Tracks) and try again.');
  }

  function nodeSet(track) {
    var s = {}, clips = track.clips;
    for (var j = 0; j < clips.numItems; j++) s[clips[j].nodeId] = true;
    return s;
  }

  function newClips(track, before) {
    var out = [], clips = track.clips;
    for (var j = 0; j < clips.numItems; j++) if (!before[clips[j].nodeId]) out.push(clips[j]);
    return out;
  }

  var TIME_FORMATS = [
    function (s) { return String(Math.round(s * TICKS)); },
    function (s) { return s; },
    function (s) { var t = new Time(); t.seconds = s; return t; }
  ];

  // The ProjectItem in/out API is documented inconsistently (seconds vs ticks); find out once.
  function setInOut(pi, a, b) {
    var forms = inOutMode === null ? [0, 1] : [inOutMode];
    for (var k = 0; k < forms.length; k++) {
      var f = forms[k] === 0 ? function (s) { return s; } : function (s) { return String(Math.round(s * TICKS)); };
      try { pi.setInPoint(f(a), 4); pi.setOutPoint(f(b), 4); } catch (e) { continue; }
      var got = -1;
      try { got = pi.getInPoint().seconds; } catch (e2) {}
      if (Math.abs(got - a) < 0.05 || inOutMode !== null) { inOutMode = forms[k]; return true; }
    }
    return false;
  }

  function clearInOut(pi) {
    try { pi.clearInPoint(); } catch (e1) {}
    try { pi.clearOutPoint(); } catch (e2) {}
  }

  /*
   * Places one file at `start` seconds with its video on track vIdx and audio from aIdx.
   * The target tracks are always empty around `start` (they sit above everything else),
   * so a wrongly-interpreted time format can be detected and undone safely.
   * Returns { video: TrackItem|null, audio: [TrackItem], warning }.
   */
  function placeClip(clip, isVideo, vIdx, aIdx) {
    var pi = projectItemFor(clip.path);
    if (!pi) return { video: null, audio: [], warning: 'Not found in project: ' + clip.path };
    ensureTracks(vIdx + 1, aIdx + 2);
    var seq = app.project.activeSequence, i, k;
    try { pi.setColorLabel(clip.color); } catch (e0) {}
    var warning = '';
    if (clip.trimmed && !setInOut(pi, clip.mediaIn, clip.mediaOut)) warning = 'Could not trim ' + clip.path;

    var nA = Math.min(seq.audioTracks.numTracks, aIdx + 4), beforeV = nodeSet(seq.videoTracks[vIdx]), beforeA = [];
    for (i = aIdx; i < nA; i++) beforeA.push(nodeSet(seq.audioTracks[i]));
    var tol = frameDuration(seq) + 0.01, order = timeMode === null ? [0, 1, 2] : [timeMode];
    var result = null;

    for (k = 0; k < order.length && !result; k++) {
      try { seq.overwriteClip(pi, TIME_FORMATS[order[k]](clip.start), vIdx, aIdx); } catch (e1) { continue; }
      seq = app.project.activeSequence;
      var vids = isVideo ? newClips(seq.videoTracks[vIdx], beforeV) : [], auds = [];
      for (i = aIdx; i < nA; i++) auds = auds.concat(newClips(seq.audioTracks[i], beforeA[i - aIdx]));
      var primary = isVideo ? vids[0] : auds[0];
      if (primary && Math.abs(primary.start.seconds - clip.start) <= tol) {
        timeMode = order[k];
        result = { video: vids[0] || null, audio: auds };
      } else {
        for (i = 0; i < vids.length; i++) vids[i].remove(0, 0);
        for (i = 0; i < auds.length; i++) auds[i].remove(0, 0);
      }
    }
    if (clip.trimmed) clearInOut(pi);
    if (!result) return { video: null, audio: [], warning: 'Could not place ' + clip.path };

    var all = result.audio.concat(result.video ? [result.video] : []);
    for (i = 0; i < all.length; i++) {
      try { if (typeof all[i].setColorLabel === 'function') all[i].setColorLabel(clip.color); } catch (e2) {}
    }
    result.warning = warning;
    return result;
  }

  function audioTrackOf(seq, item) {
    for (var i = 0; i < seq.audioTracks.numTracks; i++) {
      var clips = seq.audioTracks[i].clips;
      for (var j = 0; j < clips.numItems; j++) if (clips[j].nodeId === item.nodeId) return i;
    }
    return -1;
  }

  function deselectAll(seq) {
    var sel = seq.getSelection();
    for (var i = 0; i < sel.length; i++) { try { sel[i].setSelected(0, 1); } catch (e) {} }
  }

  function overlap(a, b) {
    return Math.max(0, Math.min(a.end.seconds, b.end.seconds) - Math.max(a.start.seconds, b.start.seconds));
  }

  /*
   * json: { sequenceId, backup, removeNodeIds, cameraAudio: keep|mute|delete, link: camera|mics,
   *         videoLanes, audioLanes }  (lanes: [{ device, clips: [{ path, start, mediaIn, mediaOut,
   *         trimmed, scene, color }] }])
   * Returns { ok, placed: [nodeId], tracks: { device: { v: [n], a: [n] } }, backup, warnings }.
   */
  function build(json) {
    try {
      var plan = eval('(' + json + ')'), i, j, k;
      var seq = sequenceById(plan.sequenceId);
      if (!seq) return toJSON({ ok: false, error: 'The sequence was closed or deleted. Run Sync again.' });
      if (app.project.activeSequence.sequenceID !== seq.sequenceID) activate(seq);

      var backup = plan.backup ? copySequence(seq, 'Backup') : null;
      seq = app.project.activeSequence;
      removeNodes(seq, plan.removeNodeIds);
      seq = app.project.activeSequence;

      // Start above anything left on the timeline, so nothing of the user's is overwritten.
      var baseV = highestUsedTrack(seq, 'V') + 1, curA = highestUsedTrack(seq, 'A') + 1;
      var tracks = {}, placed = [], warnings = [], cameraAudio = [], scenes = {};

      function note(dev, kind, n) {
        var t = tracks[dev] = tracks[dev] || { v: [], a: [] };
        if (t[kind].indexOf(n + 1) < 0) t[kind].push(n + 1);
      }

      function placeAudioLanes() {
        for (var l = 0; l < plan.audioLanes.length; l++) {
          var lane = plan.audioLanes[l], span = 1;
          for (var c = 0; c < lane.clips.length; c++) {
            var r = placeClip(lane.clips[c], false, baseV, curA);
            if (r.warning) warnings.push(r.warning);
            for (var x = 0; x < r.audio.length; x++) {
              var tr = audioTrackOf(app.project.activeSequence, r.audio[x]);
              span = Math.max(span, tr - curA + 1);
              note(lane.device, 'a', tr);
              placed.push(r.audio[x].nodeId);
              (scenes[lane.clips[c].scene] = scenes[lane.clips[c].scene] || { v: [], mics: [] }).mics.push(r.audio[x]);
            }
          }
          curA += span;
        }
      }

      function placeVideoLanes() {
        for (var l = 0; l < plan.videoLanes.length; l++) {
          var lane = plan.videoLanes[l], vIdx = baseV + l, span = 0;
          for (var c = 0; c < lane.clips.length; c++) {
            var r = placeClip(lane.clips[c], true, vIdx, curA);
            if (r.warning) warnings.push(r.warning);
            if (r.video) {
              note(lane.device, 'v', vIdx);
              placed.push(r.video.nodeId);
              (scenes[lane.clips[c].scene] = scenes[lane.clips[c].scene] || { v: [], mics: [] })
                .v.push({ item: r.video, audio: r.audio });
            }
            for (var x = 0; x < r.audio.length; x++) {
              var tr = audioTrackOf(app.project.activeSequence, r.audio[x]);
              span = Math.max(span, tr - curA + 1);
              if (plan.cameraAudio !== 'delete') note(lane.device, 'a', tr);
              cameraAudio.push(r.audio[x]);
            }
          }
          curA += span;
        }
      }

      // Deleted camera audio goes on the tracks after the mics, so the mics start at A1.
      if (plan.cameraAudio === 'delete') { placeAudioLanes(); placeVideoLanes(); }
      else { placeVideoLanes(); placeAudioLanes(); }

      for (i = 0; i < cameraAudio.length; i++) {
        if (plan.cameraAudio === 'delete') { cameraAudio[i].remove(0, 0); continue; }
        if (plan.cameraAudio === 'mute') { try { cameraAudio[i].disabled = true; } catch (e1) {} }
        placed.push(cameraAudio[i].nodeId);
      }

      // Link each mic clip to the camera clip it overlaps most in its scene.
      if (plan.link === 'mics') {
        seq = app.project.activeSequence;
        for (var s in scenes) {
          if (!scenes.hasOwnProperty(s) || s === 'null') continue;
          var sc = scenes[s];
          if (!sc.v.length || !sc.mics.length) continue;
          var groups = [];
          for (i = 0; i < sc.mics.length; i++) {
            var best = -1, bestOv = 0;
            for (j = 0; j < sc.v.length; j++) {
              var ov = overlap(sc.mics[i], sc.v[j].item);
              if (ov > bestOv) { bestOv = ov; best = j; }
            }
            if (best >= 0) (groups[best] = groups[best] || []).push(sc.mics[i]);
          }
          for (j = 0; j < sc.v.length; j++) {
            if (!groups[j]) continue;
            deselectAll(seq);
            sc.v[j].item.setSelected(1, 1);
            if (plan.cameraAudio !== 'delete')
              for (k = 0; k < sc.v[j].audio.length; k++) sc.v[j].audio[k].setSelected(1, 1);
            for (k = 0; k < groups[j].length; k++) groups[j][k].setSelected(1, 1);
            try { seq.linkSelection(); } catch (e2) { warnings.push('Could not link scene ' + s); }
          }
          deselectAll(seq);
        }
      }

      return toJSON({ ok: true, placed: placed, tracks: tracks, warnings: warnings,
                      backup: backup ? backup.name : '', backupId: backup ? backup.id : '' });
    } catch (e) {
      return toJSON({ ok: false, error: 'build: ' + e + (e.line ? ' (line ' + e.line + ')' : '') });
    }
  }

  function openSequence(id) {
    var seq = sequenceById(id);
    if (!seq) return toJSON({ ok: false, error: 'That sequence no longer exists.' });
    activate(seq);
    return toJSON({ ok: true });
  }

  function duplicate(id) {
    var seq = sequenceById(id);
    if (!seq) return toJSON({ ok: false, error: 'That sequence no longer exists.' });
    var copy = copySequence(seq, 'Copy');
    return toJSON({ ok: !!copy, name: copy ? copy.name : '', error: copy ? '' : 'Premiere did not duplicate the sequence.' });
  }

  return { getItems: getItems, build: build, openSequence: openSequence, duplicate: duplicate,
           ping: function () { return toJSON({ ok: true, version: app.version }); } };
})();
