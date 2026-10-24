/* WaveSync panel logic: talks to Premiere (host.jsx), runs ffmpeg, calls SyncCore. */
(function () {
  'use strict';

  var nodeRequire = (typeof cep_node !== 'undefined' && cep_node.require) ? cep_node.require : require;
  var cp = nodeRequire('child_process'), fs = nodeRequire('fs'), path = nodeRequire('path');

  var isWin = process.platform === 'win32';
  var extDir = path.dirname(decodeURIComponent(window.location.pathname).replace(/^\/([A-Za-z]:)/, '$1'));
  var $ = function (id) { return document.getElementById(id); };
  var pcmCache = {};   // media path -> { mtime, pcm, env }
  var SCENE_GAP = 2;   // seconds between scenes on the timeline

  function evalHost(script) {
    return new Promise(function (resolve, reject) {
      window.__adobe_cep__.evalScript(script, function (res) {
        try { resolve(JSON.parse(res)); } catch (e) { reject(new Error('Premiere returned: ' + res)); }
      });
    });
  }

  function findFfmpeg() {
    var exe = isWin ? 'ffmpeg.exe' : 'ffmpeg';
    var c = [path.join(extDir, 'bin', exe), '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
    // Panels don't get the user's shell PATH on macOS, but on Windows (winget, choco) PATH is where ffmpeg lives.
    (process.env.PATH || '').split(path.delimiter).forEach(function (d) { if (d) c.push(path.join(d, exe)); });
    for (var i = 0; i < c.length; i++) if (fs.existsSync(c[i])) return c[i];
    return null;
  }

  function extractPcm(ffmpeg, file) {
    var mtime = fs.statSync(file).mtimeMs, hit = pcmCache[file];
    if (hit && hit.mtime === mtime) return Promise.resolve(hit);
    return new Promise(function (resolve, reject) {
      var args = ['-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', String(SyncCore.SR), '-f', 'f32le', 'pipe:1'];
      var proc = cp.spawn(ffmpeg, args), chunks = [], total = 0, err = '';
      proc.stdout.on('data', function (d) { chunks.push(d); total += d.length; });
      proc.stderr.on('data', function (d) { err += d; });
      proc.on('error', reject);
      proc.on('close', function (code) {
        if (code !== 0 || total < 4) return reject(new Error(err.trim() || 'no audio stream'));
        var buf = Buffer.concat(chunks, total), ab = new ArrayBuffer(total - (total % 4));
        new Uint8Array(ab).set(buf.subarray(0, ab.byteLength));
        var entry = { mtime: mtime, pcm: new Float32Array(ab) };
        entry.env = SyncCore.envelope(entry.pcm);
        pcmCache[file] = entry;
        resolve(entry);
      });
    });
  }

  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function setStatus(msg, kind) {
    var el = $('status');
    el.textContent = msg;
    el.className = 'status ' + (kind || '');
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

  function fmtSec(s) {
    var sign = s < 0 ? '−' : '+', a = Math.abs(s), m = Math.floor(a / 60);
    return sign + m + ':' + (a - m * 60).toFixed(3).padStart(6, '0');
  }

  function renderResults(scenes, unmatched) {
    var html = '';
    scenes.forEach(function (sc, i) {
      html += '<div class="scene">Scene ' + (i + 1) + '</div><table>';
      sc.files.forEach(function (f) {
        var m = sc.group.members[f.path], label, extra = [];
        if (m.status === 'ref') label = 'anchor';
        else label = fmtSec(m.offset) + (m.status === 'low' ? ' (check)' : '');
        if (m.via && m.via !== sc.group.root) extra.push('via ' + path.basename(m.via));
        if (m.driftPpm != null && Math.abs(m.driftPpm) > 20)
          extra.push('drift ' + Math.round(m.driftPpm * (m.overlap || 0) / 1000) + ' ms over clip');
        html += '<tr class="' + m.status + '"><td title="' + esc(f.path) + '">' + esc(path.basename(f.path)) +
          (extra.length ? '<div class="sub">' + esc(extra.join(' · ')) + '</div>' : '') + '</td><td>' + label + '</td></tr>';
      });
      html += '</table>';
    });
    if (unmatched.length) {
      html += '<div class="scene">No match found</div><table>';
      unmatched.forEach(function (f) {
        html += '<tr class="fail"><td title="' + esc(f.path) + '">' + esc(path.basename(f.path)) + '</td><td>—</td></tr>';
      });
      html += '</table>';
    }
    $('results').innerHTML = html;
  }

  async function runSync() {
    var btn = $('sync');
    btn.disabled = true;
    $('results').innerHTML = '';
    try {
      var ffmpeg = findFfmpeg();
      if (!ffmpeg) throw new Error('ffmpeg not found. Install it with: ' + (isWin ? 'winget install Gyan.FFmpeg' : 'brew install ffmpeg'));

      var useAll = $('scope-all').checked;
      setStatus('Reading clips from the sequence…');
      var sel = await evalHost('WaveSync.getItems(' + useAll + ')');
      if (!sel.ok) throw new Error(sel.error);

      // One entry per media file; all its timeline clips move together.
      var skipped = [], byPath = {}, media = [];
      sel.items.forEach(function (it) {
        if (!it.path) { skipped.push(it.name + ' (no media file)'); return; }
        if (Math.abs(it.speed - 1) > 1e-6) { skipped.push(it.name + ' (speed changed)'); return; }
        var m = byPath[it.path];
        if (!m) { m = byPath[it.path] = { path: it.path, items: [], tracks: [], audioOnly: true }; media.push(m); }
        m.items.push(it);
        var key = it.type + (it.track + 1);
        if (m.tracks.indexOf(key) < 0) m.tracks.push(key);
        if (it.type === 'V') m.audioOnly = false;
      });
      if (media.length < 2)
        throw new Error(useAll ? 'The sequence needs clips from at least two different files.'
                               : 'Select clips from at least two different files (cameras + mic audio).');

      var files = [];
      for (var i = 0; i < media.length; i++) {
        setStatus('Reading audio ' + (i + 1) + '/' + media.length + ': ' + path.basename(media[i].path));
        await tick();
        try {
          var e = await extractPcm(ffmpeg, media[i].path);
          files.push({ id: media[i].path, pcm: e.pcm, env: e.env, audioOnly: media[i].audioOnly, tracks: media[i].tracks });
        } catch (err) {
          skipped.push(path.basename(media[i].path) + ' (' + err.message + ')');
        }
      }
      media = media.filter(function (m) { return files.some(function (f) { return f.id === m.path; }); });
      if (files.length < 2) throw new Error('Could not read audio from enough files.');

      var pairs = SyncCore.candidatePairs(files), edges = [];
      for (i = 0; i < pairs.length; i++) {
        if (i % 3 === 0) { setStatus('Matching waveforms… ' + (i + 1) + '/' + pairs.length); await tick(); }
        var edge = SyncCore.matchPair(pairs[i][0], pairs[i][1], {});
        if (edge) edges.push(edge);
      }
      var groups = SyncCore.buildGroups(files, edges);

      // Scenes in the order they currently sit on the timeline; unmatched files keep their slot too.
      var blocks = groups.map(function (g) {
        var fl = media.filter(function (m) { return g.members[m.path]; });
        var items = [];
        fl.forEach(function (m) { m.items.forEach(function (it) { items.push({ it: it, rel: g.members[m.path].offset + it.inPoint }); }); });
        return { group: g, files: fl, items: items, matched: fl.length > 1,
                 curStart: Math.min.apply(null, items.map(function (x) { return x.it.start; })) };
      }).sort(function (a, b) { return a.curStart - b.curStart; });

      var scenes = blocks.filter(function (b) { return b.matched; });
      var unmatched = [];
      blocks.forEach(function (b) { if (!b.matched) unmatched = unmatched.concat(b.files); });
      renderResults(scenes, unmatched);
      if (!scenes.length) { setStatus('No matching audio found between these files, so nothing was moved.', 'warn'); return; }

      // timeline start - inPoint = anchor + offset  =>  target = anchor + offset + inPoint
      var cursor = blocks[0].curStart, moves = [];
      blocks.forEach(function (b) {
        var relMin = Math.min.apply(null, b.items.map(function (x) { return x.rel; }));
        var relMax = Math.max.apply(null, b.items.map(function (x) { return x.rel + (x.it.end - x.it.start); }));
        var anchor = cursor - relMin;
        b.items.forEach(function (x) {
          moves.push({ nodeId: x.it.nodeId, type: x.it.type, track: x.it.track, name: x.it.name,
                       start: x.it.start, end: x.it.end, target: anchor + x.rel });
        });
        cursor = anchor + relMax + SCENE_GAP;
      });
      var needed = moves.filter(function (m) { return Math.abs(m.target - m.start) > 0.0005; });
      if (!needed.length) { setStatus('Already in sync — nothing to move.', 'ok'); return; }

      setStatus('Moving ' + needed.length + ' clips…');
      await tick();
      var payload = JSON.stringify({ backup: $('backup').checked, moves: moves });
      var res = await evalHost('WaveSync.applyMoves(' + JSON.stringify(payload) + ')');
      if (!res.ok) throw new Error(res.error + (res.details ? '\n• ' + res.details.slice(0, 6).join('\n• ') : ''));

      var msg = 'Synced ' + scenes.length + ' scene' + (scenes.length > 1 ? 's' : '') + '.';
      if (unmatched.length) msg += ' ' + unmatched.length + ' file(s) had no match and were placed after their neighbours.';
      if (res.maxErr > 0.021) msg += ' Note: ' + res.worst + ' landed ' + Math.round(res.maxErr * 1000) + ' ms off (frame snapping).';
      if (skipped.length) msg += ' Skipped: ' + skipped.join(', ') + '.';
      if (res.backup) msg += ' Backup saved as "' + res.backup + '".';
      setStatus(msg, unmatched.length ? 'warn' : 'ok');
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  window.addEventListener('load', function () {
    $('sync').addEventListener('click', runSync);
    var ff = findFfmpeg();
    $('ffmpeg').textContent = ff ? 'ffmpeg: ' + ff : 'ffmpeg not found — run: ' + (isWin ? 'winget install Gyan.FFmpeg' : 'brew install ffmpeg');
    $('ffmpeg').className = 'foot ' + (ff ? '' : 'error');
  });
})();
