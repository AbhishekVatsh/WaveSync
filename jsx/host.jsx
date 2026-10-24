/*
 * WaveSync — Premiere Pro side (ExtendScript, ES3).
 * Reads clips from the active sequence and moves them to the synced positions.
 * Every function returns a JSON string.
 */
var WaveSync = (function () {

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

  function findClip(seq, type, track, nodeId) {
    var clips = tracksOf(seq, type)[track].clips;
    for (var j = 0; j < clips.numItems; j++) if (clips[j].nodeId === nodeId) return clips[j];
    return null;
  }

  function getItems(useAll) {
    try {
      var seq = app.project.activeSequence;
      if (!seq) return toJSON({ ok: false, error: 'Open a sequence first.' });
      var items = [];
      eachClip(seq, function (c, type, track) {
        if (!useAll && !c.isSelected()) return;
        var path = '', speed = 1;
        try { if (c.projectItem) path = c.projectItem.getMediaPath(); } catch (e1) {}
        try { speed = c.getSpeed(); } catch (e2) {}
        items.push({
          nodeId: c.nodeId, type: type, track: track, name: c.name, path: path || '',
          start: c.start.seconds, end: c.end.seconds, inPoint: c.inPoint.seconds, speed: speed
        });
      });
      return toJSON({ ok: true, sequence: seq.name, items: items });
    } catch (e) {
      return toJSON({ ok: false, error: 'getItems: ' + e });
    }
  }

  function overlaps(a0, a1, b0, b1) { return a0 < b1 - 0.001 && b0 < a1 - 0.001; }

  function sequenceNames() {
    var names = {}, seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences; i++) names[seqs[i].name] = true;
    return names;
  }

  /*
   * Copies seq as "<name> - Backup" (or "- Backup 2", ...). Premiere switches to the new
   * copy after clone(), so the original is made active again. Returns the backup's name.
   */
  function backupSequence(seq) {
    var before = {}, seqs = app.project.sequences, i, copy = null;
    for (i = 0; i < seqs.numSequences; i++) before[seqs[i].sequenceID] = true;
    seq.clone();
    seqs = app.project.sequences;
    for (i = 0; i < seqs.numSequences; i++) if (!before[seqs[i].sequenceID]) { copy = seqs[i]; break; }
    if (!copy) return '';

    var names = sequenceNames(), base = seq.name + ' - Backup', name = base, n = 2;
    while (names[name]) name = base + ' ' + n++;
    try { copy.projectItem.name = name; } catch (e1) { try { copy.name = name; } catch (e2) {} }

    try { app.project.activeSequence = seq; } catch (e3) {}
    if (app.project.activeSequence.sequenceID !== seq.sequenceID) {
      try { app.project.openSequence(seq.sequenceID); } catch (e4) {}
    }
    return name;
  }

  /*
   * json: { backup: bool, moves: [{ nodeId, type, track, start, end, target, name }] }
   * Moves are done in two phases (everything to a free area past the end of the
   * sequence, then back to the final spot) so clips never land on each other mid-way.
   */
  function applyMoves(json) {
    try {
      var data = eval('(' + json + ')');
      var seq = app.project.activeSequence;
      if (!seq) return toJSON({ ok: false, error: 'Open a sequence first.' });
      var moves = data.moves, i, j, m, n;

      var moving = {};
      for (i = 0; i < moves.length; i++) moving[moves[i].nodeId] = true;

      // Refuse if a synced clip would land on another clip on the same track.
      var problems = [];
      for (i = 0; i < moves.length; i++) {
        m = moves[i];
        var t0 = m.target, t1 = m.target + (m.end - m.start);
        for (j = i + 1; j < moves.length; j++) {
          n = moves[j];
          if (n.type === m.type && n.track === m.track &&
              overlaps(t0, t1, n.target, n.target + (n.end - n.start)))
            problems.push(m.name + ' and ' + n.name + ' (' + m.type + (m.track + 1) + ')');
        }
        var clips = tracksOf(seq, m.type)[m.track].clips;
        for (j = 0; j < clips.numItems; j++) {
          var c = clips[j];
          if (moving[c.nodeId]) continue;
          if (overlaps(t0, t1, c.start.seconds, c.end.seconds))
            problems.push(m.name + ' would cover ' + c.name + ' (' + m.type + (m.track + 1) + ')');
        }
      }
      if (problems.length)
        return toJSON({ ok: false, error: 'Clips would overlap after syncing. Put each camera/mic on its own track.', details: problems });

      var backupName = data.backup ? backupSequence(seq) : '';

      var maxEnd = 0, minTarget = Infinity;
      eachClip(seq, function (c) { if (c.end.seconds > maxEnd) maxEnd = c.end.seconds; });
      for (i = 0; i < moves.length; i++) {
        m = moves[i];
        maxEnd = Math.max(maxEnd, m.target + (m.end - m.start));
        minTarget = Math.min(minTarget, m.target);
      }
      var parking = Math.ceil(maxEnd - minTarget + 60);

      var missing = 0;
      function phase(extra) {
        for (var k = 0; k < moves.length; k++) {
          var mv = moves[k], clip = findClip(seq, mv.type, mv.track, mv.nodeId);
          if (!clip) { missing++; continue; }
          // Re-read the position: moving a clip can drag its linked partner along.
          var delta = mv.target + extra - clip.start.seconds;
          if (Math.abs(delta) < 0.0001) continue;
          var t = new Time();
          t.seconds = delta;
          clip.move(t);
        }
      }
      phase(parking);
      phase(0);

      var maxErr = 0, worst = '';
      for (i = 0; i < moves.length; i++) {
        m = moves[i];
        var cl = findClip(seq, m.type, m.track, m.nodeId);
        if (!cl) continue;
        var err = Math.abs(cl.start.seconds - m.target);
        if (err > maxErr) { maxErr = err; worst = m.name; }
      }
      return toJSON({ ok: true, moved: moves.length, missing: missing, maxErr: maxErr, worst: worst, backup: backupName });
    } catch (e) {
      return toJSON({ ok: false, error: 'applyMoves: ' + e + (e.line ? ' (line ' + e.line + ')' : '') });
    }
  }

  return { getItems: getItems, applyMoves: applyMoves, ping: function () { return toJSON({ ok: true, version: app.version }); } };
})();
