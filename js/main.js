/* WaveSync panel logic: talks to Premiere (host.jsx), runs ffmpeg, calls SyncCore and Layout. */
(function () {
  'use strict';

  var nodeRequire = (typeof cep_node !== 'undefined' && cep_node.require) ? cep_node.require : require;
  var cp = nodeRequire('child_process'), fs = nodeRequire('fs'), path = nodeRequire('path');

  var isWin = process.platform === 'win32';
  var extDir = path.dirname(decodeURIComponent(window.location.pathname).replace(/^\/([A-Za-z]:)/, '$1'));
  var $ = function (id) { return document.getElementById(id); };
  var pcmCache = {};   // media path -> { mtime, pcm, env }
  var probeCache = {}; // media path -> { mtime, info }

  var SETTINGS_KEY = 'wavesync.settings';
  var DEFAULTS = { cameraAudio: 'mute', unusedAudio: 'park', trimAudio: 'video', link: 'camera', layout: 'device' };
  var state = null;    // the last sync, kept so the report can rebuild the timeline without re-analysing

  function evalHost(script) {
    return new Promise(function (resolve, reject) {
      window.__adobe_cep__.evalScript(script, function (res) {
        try { resolve(JSON.parse(res)); } catch (e) { reject(new Error('Premiere returned: ' + res)); }
      });
    });
  }

  function callHost(fn, arg) {
    return evalHost('WaveSync.' + fn + '(' + (arg === undefined ? '' : JSON.stringify(arg)) + ')');
  }

  function loadDefaults() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) {}
    return Object.assign({}, DEFAULTS, s);
  }

  function saveDefaults(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  }

  function findFfmpeg() {
    var exe = isWin ? 'ffmpeg.exe' : 'ffmpeg';
    var c = [path.join(extDir, 'bin', exe), '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
    // Panels don't get the user's shell PATH on macOS, but on Windows (winget, choco) PATH is where ffmpeg lives.
    (process.env.PATH || '').split(path.delimiter).forEach(function (d) { if (d) c.push(path.join(d, exe)); });
    for (var i = 0; i < c.length; i++) if (fs.existsSync(c[i])) return c[i];
    return null;
  }

  function findFfprobe(ffmpeg) {
    var p = path.join(path.dirname(ffmpeg), isWin ? 'ffprobe.exe' : 'ffprobe');
    return fs.existsSync(p) ? p : null;
  }

  function run(exe, args) {
    return new Promise(function (resolve, reject) {
      var proc = cp.spawn(exe, args), chunks = [], total = 0, err = '';
      proc.stdout.on('data', function (d) { chunks.push(d); total += d.length; });
      proc.stderr.on('data', function (d) { err += d; });
      proc.on('error', reject);
      proc.on('close', function (code) {
        if (code !== 0) return reject(new Error(err.trim() || exe + ' failed'));
        resolve(Buffer.concat(chunks, total));
      });
    });
  }

  function extractPcm(ffmpeg, file) {
    var mtime = fs.statSync(file).mtimeMs, hit = pcmCache[file];
    if (hit && hit.mtime === mtime) return Promise.resolve(hit);
    var args = ['-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', String(SyncCore.SR), '-f', 'f32le', 'pipe:1'];
    return run(ffmpeg, args).then(function (buf) {
      if (buf.length < 4) throw new Error('no audio stream');
      var ab = new ArrayBuffer(buf.length - (buf.length % 4));
      new Uint8Array(ab).set(buf.subarray(0, ab.byteLength));
      var entry = { mtime: mtime, pcm: new Float32Array(ab) };
      entry.env = SyncCore.envelope(entry.pcm);
      pcmCache[file] = entry;
      return entry;
    });
  }

  // Duration plus a format fingerprint (codec, size, frame rate / sample rate) used to tell devices apart.
  function probeMedia(ffprobe, file) {
    var mtime = fs.statSync(file).mtimeMs, hit = probeCache[file];
    if (hit && hit.mtime === mtime) return Promise.resolve(hit.info);
    if (!ffprobe) return Promise.resolve({ duration: 0, format: '' });
    var args = ['-v', 'error', '-of', 'json', '-show_entries',
      'format=duration:format_tags=com.apple.quicktime.model,model,encoder:' +
      'stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels', file];
    return run(ffprobe, args).then(function (buf) {
      var j = JSON.parse(buf.toString()), streams = j.streams || [], tags = (j.format && j.format.tags) || {};
      var v = streams.filter(function (s) { return s.codec_type === 'video'; })[0];
      var a = streams.filter(function (s) { return s.codec_type === 'audio'; })[0];
      var fmt = v ? [v.codec_name, v.width + 'x' + v.height, v.r_frame_rate].join(' ')
                  : a ? [a.codec_name, a.sample_rate, a.channels].join(' ') : '';
      var model = tags['com.apple.quicktime.model'] || tags.model || tags.encoder || '';
      var info = { duration: Number(j.format && j.format.duration) || 0, format: fmt + (model ? ' ' + model : '') };
      probeCache[file] = { mtime: mtime, info: info };
      return info;
    }).catch(function () { return { duration: 0, format: '' }; });
  }

  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function setStatus(id, msg, kind) {
    var el = $(id);
    el.textContent = msg;
    el.className = 'status ' + (kind || '');
    el.hidden = !msg;
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

  function fmtSec(s) {
    var sign = s < 0 ? '−' : '+', a = Math.abs(s), m = Math.floor(a / 60);
    return sign + m + ':' + (a - m * 60).toFixed(3).padStart(6, '0');
  }

  function showView(name) {
    $('setup').hidden = name !== 'setup';
    $('report').hidden = name !== 'report';
  }

  // ---------- Sync ----------

  async function runSync() {
    var btn = $('sync'), t0 = Date.now();
    btn.disabled = true;
    try {
      var ffmpeg = findFfmpeg();
      if (!ffmpeg) throw new Error('ffmpeg not found. Install it with: ' + (isWin ? 'winget install Gyan.FFmpeg' : 'brew install ffmpeg'));
      var ffprobe = findFfprobe(ffmpeg);

      var useAll = $('scope-all').checked;
      setStatus('status', 'Reading clips from the sequence…');
      var sel = await callHost('getItems', useAll);
      if (!sel.ok) throw new Error(sel.error);

      // One entry per media file; every timeline clip of that file is replaced by the layout.
      var skipped = [], byPath = {}, media = [];
      sel.items.forEach(function (it) {
        if (!it.path) { skipped.push(it.name + ' (no media file)'); return; }
        if (Math.abs(it.speed - 1) > 1e-6) { skipped.push(it.name + ' (speed changed)'); return; }
        var m = byPath[it.path];
        if (!m) { m = byPath[it.path] = { id: it.path, items: [], tracks: [], curStart: Infinity }; media.push(m); }
        m.items.push(it);
        m.curStart = Math.min(m.curStart, it.start);
        var key = it.type + (it.track + 1);
        if (m.tracks.indexOf(key) < 0) m.tracks.push(key);
      });
      media.forEach(function (m) {
        var v = m.items.filter(function (it) { return it.type === 'V'; })[0], first = v || m.items[0];
        m.kind = v ? 'video' : 'audio';
        m.trackKey = first.type + (first.track + 1);
        m.trackOrder = (v ? 0 : 100) + first.track;
      });
      if (media.length < 2)
        throw new Error(useAll ? 'The sequence needs clips from at least two different files.'
                               : 'Select clips from at least two different files (cameras + mic audio).');

      var files = [];
      for (var i = 0; i < media.length; i++) {
        var m = media[i];
        setStatus('status', 'Reading audio ' + (i + 1) + '/' + media.length + ': ' + path.basename(m.id));
        await tick();
        try {
          var e = await extractPcm(ffmpeg, m.id), info = await probeMedia(ffprobe, m.id);
          m.duration = info.duration || e.pcm.length / SyncCore.SR;
          m.sig = Layout.nameSignature(m.id) + '|' + info.format;
          files.push({ id: m.id, pcm: e.pcm, env: e.env, audioOnly: m.kind === 'audio', tracks: m.tracks, sig: m.sig });
        } catch (err) {
          skipped.push(path.basename(m.id) + ' (' + err.message + ')');
          m.failed = true;
        }
      }
      media = media.filter(function (x) { return !x.failed; });
      if (files.length < 2) throw new Error('Could not read audio from enough files.');

      var pairs = SyncCore.candidatePairs(files), edges = [];
      for (i = 0; i < pairs.length; i++) {
        if (i % 3 === 0) { setStatus('status', 'Matching waveforms… ' + (i + 1) + '/' + pairs.length); await tick(); }
        var edge = SyncCore.matchPair(pairs[i][0], pairs[i][1], {});
        if (edge) edges.push(edge);
      }
      var groups = SyncCore.buildGroups(files, edges);
      var matchedFiles = 0;
      groups.forEach(function (g) { var n = Object.keys(g.members).length; if (n > 1) matchedFiles += n; });
      if (!matchedFiles) {
        setStatus('status', 'No matching audio found between these files, so nothing was changed.', 'warn');
        return;
      }

      var settings = loadDefaults();
      state = {
        seq: { id: sel.sequenceId, name: sel.sequence, frameDur: sel.frameDur },
        media: media, groups: groups, settings: settings, backup: $('backup').checked,
        devices: Layout.detectDevices(media, Layout.computePositions(media, groups, settings).pos),
        placed: [], tracks: {}, backupId: '', skipped: skipped,
        stats: { synced: matchedFiles, failed: media.length - matchedFiles }
      };
      setStatus('status', 'Building the timeline…');
      await tick();
      await apply(true);
      state.stats.seconds = (Date.now() - t0) / 1000;
      setStatus('status', '');
      renderReport();
      showView('report');
    } catch (err) {
      setStatus('status', err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // Lays the timeline out from state. The first run replaces the original clips; later runs
  // replace what the previous run placed.
  async function apply(initial) {
    var plan = Layout.buildPlan(state.media, state.groups, state.devices, state.settings, state.seq.frameDur);
    function lanes(list) {
      return list.map(function (l) {
        return { device: l.device, clips: l.clips.map(function (c) {
          return { path: c.id, start: c.start, mediaIn: c.mediaIn, mediaOut: c.mediaOut,
                   trimmed: c.trimmed, scene: c.scene, color: c.color, device: c.device };
        }) };
      });
    }
    var remove = initial ? [].concat.apply([], state.media.map(function (m) {
      return m.items.map(function (it) { return it.nodeId; });
    })) : state.placed;
    var res = await callHost('build', JSON.stringify({
      sequenceId: state.seq.id, backup: initial && state.backup, removeNodeIds: remove,
      cameraAudio: state.settings.cameraAudio, link: state.settings.link,
      videoLanes: lanes(plan.videoLanes), audioLanes: lanes(plan.audioLanes)
    }));
    if (!res.ok) throw new Error(res.error);
    state.placed = res.placed;
    state.tracks = res.tracks;
    state.warnings = res.warnings || [];
    state.removedCount = plan.removed.length;
    if (res.backupId) { state.backupId = res.backupId; state.backupName = res.backup; }
  }

  // Report edits rebuild the timeline; edits made while one is running are folded into the next.
  var applying = false, pending = false;
  async function reapply() {
    if (state.remember) saveDefaults(state.settings);
    if (applying) { pending = true; return; }
    applying = true;
    setStatus('status2', 'Updating the timeline…');
    try {
      do {
        pending = false;
        await apply(false);
      } while (pending);
      setStatus('status2', state.warnings.length ? state.warnings.slice(0, 4).join('\n') : '', state.warnings.length ? 'warn' : '');
    } catch (err) {
      setStatus('status2', err.message, 'error');
    } finally {
      applying = false;
      renderReport();
    }
  }

  // ---------- Report ----------

  function range(prefix, nums) {
    if (!nums || !nums.length) return '';
    nums = nums.slice().sort(function (a, b) { return a - b; });
    var contiguous = nums[nums.length - 1] - nums[0] === nums.length - 1;
    if (nums.length === 1) return prefix + nums[0];
    return contiguous ? prefix + nums[0] + '–' + nums[nums.length - 1] : nums.map(function (n) { return prefix + n; }).join(',');
  }

  function trackLabel(d) {
    var t = state.tracks[d.id];
    if (!t) return '—';
    var v = range('V', t.v), a = range('A', t.a);
    return v && a ? v + ' + ' + a : (v || a || '—');
  }

  function renderReport() {
    var s = state.stats;
    $('st-synced').textContent = s.synced;
    $('st-time').textContent = (s.seconds || 0).toFixed(1) + 's';
    $('st-failed').textContent = s.failed;

    ['cameraAudio', 'unusedAudio', 'trimAudio', 'link', 'layout'].forEach(function (k) { $('set-' + k).value = state.settings[k]; });
    $('set-remember').checked = !!state.remember;
    $('seq-original').disabled = !state.backupId;
    $('seq-original').title = state.backupId ? state.backupName : 'Turn on "Back up the sequence first" to keep the original';

    var compact = state.settings.layout === 'compact';
    var rows = state.devices.map(function (d, i) {
      var same = state.devices.filter(function (x) { return x.kind === d.kind; });
      var opts = same.map(function (x, k) {
        return '<option value="' + k + '"' + (x === d ? ' selected' : '') + '>' + esc(trackLabel(x)) + '</option>';
      }).join('');
      var label = Layout.LABELS[d.color];
      return '<tr>' +
        '<td class="kind">' + (d.kind === 'video' ? '▣' : '♪') + '</td>' +
        '<td class="dev" title="' + esc(d.files.join('\n')) + '">' + esc(d.name) + '<span class="sub"> · ' + d.files.length + '</span></td>' +
        '<td><button class="swatch" data-dev="' + i + '" title="' + label.name + '" style="background:' + label.hex + '"></button></td>' +
        '<td class="nudge"><button data-nudge="-1" data-dev="' + i + '" title="1 frame earlier">‹</button>' +
        '<button data-nudge="1" data-dev="' + i + '" title="1 frame later">›</button>' +
        '<span class="sub">' + (d.nudge ? (d.nudge > 0 ? '+' : '') + d.nudge + 'f' : '') + '</span></td>' +
        '<td><select class="tracks" data-dev="' + i + '"' + (compact || same.length < 2 ? ' disabled' : '') + '>' + opts + '</select></td>' +
        '</tr>';
    });
    $('devices').innerHTML = rows.join('');
    renderMoreInfo();
  }

  function renderMoreInfo() {
    var html = '', n = 0;
    state.groups.forEach(function (g) {
      var ids = Object.keys(g.members);
      if (ids.length < 2) return;
      html += '<div class="scene">Scene ' + (++n) + '</div><table class="info">';
      ids.forEach(function (id) {
        var m = g.members[id];
        var label = m.status === 'ref' ? 'anchor' : fmtSec(m.offset) + (m.status === 'low' ? ' (check)' : '');
        html += '<tr class="' + m.status + '"><td title="' + esc(id) + '">' + esc(path.basename(id)) + '</td><td>' + label + '</td></tr>';
      });
      html += '</table>';
    });
    var unmatched = [];
    state.groups.forEach(function (g) { var ids = Object.keys(g.members); if (ids.length === 1) unmatched.push(ids[0]); });
    if (unmatched.length) {
      html += '<div class="scene">No match found</div><table class="info">' + unmatched.map(function (id) {
        return '<tr class="fail"><td title="' + esc(id) + '">' + esc(path.basename(id)) + '</td><td>—</td></tr>';
      }).join('') + '</table>';
    }
    if (state.skipped.length) html += '<div class="scene">Skipped</div><div class="sub">' + esc(state.skipped.join(', ')) + '</div>';
    $('results').innerHTML = html;
  }

  function openPalette(btn) {
    var dev = state.devices[Number(btn.dataset.dev)], pal = $('palette');
    pal.innerHTML = Layout.LABELS.map(function (l, i) {
      return '<button data-color="' + i + '" title="' + l.name + '" style="background:' + l.hex + '"' +
             (i === dev.color ? ' class="on"' : '') + '></button>';
    }).join('');
    var r = btn.getBoundingClientRect();
    pal.style.top = (r.bottom + window.scrollY + 4) + 'px';
    pal.style.left = Math.max(8, Math.min(r.left - 60, window.innerWidth - 140)) + 'px';
    pal.dataset.dev = btn.dataset.dev;
    pal.hidden = false;
  }

  function onReportClick(e) {
    var t = e.target;
    if (t.classList.contains('swatch')) { openPalette(t); return; }
    if (t.dataset.color !== undefined) {
      state.devices[Number($('palette').dataset.dev)].color = Number(t.dataset.color);
      $('palette').hidden = true;
      reapply();
      return;
    }
    if (!$('palette').hidden && !$('palette').contains(t)) $('palette').hidden = true;
    if (t.dataset.nudge !== undefined) {
      state.devices[Number(t.dataset.dev)].nudge += Number(t.dataset.nudge);
      reapply();
    }
  }

  function onReportChange(e) {
    var t = e.target;
    if (t.classList.contains('tracks')) {
      // Swap this device with the one that currently holds the chosen tracks.
      var d = state.devices[Number(t.dataset.dev)];
      var same = state.devices.filter(function (x) { return x.kind === d.kind; });
      var other = same[Number(t.value)], a = state.devices.indexOf(d), b = state.devices.indexOf(other);
      state.devices[a] = other;
      state.devices[b] = d;
      reapply();
      return;
    }
    if (t.id === 'set-remember') {
      state.remember = t.checked;
      if (t.checked) saveDefaults(state.settings);
      return;
    }
    if (t.id && t.id.indexOf('set-') === 0) {
      state.settings[t.id.slice(4)] = t.value;
      reapply();
    }
  }

  async function onSequenceButton(which) {
    try {
      if (which === 'duplicate') {
        var r = await callHost('duplicate', state.seq.id);
        setStatus('status2', r.ok ? 'Duplicated as "' + r.name + '".' : r.error, r.ok ? 'ok' : 'error');
        return;
      }
      var id = which === 'original' ? state.backupId : state.seq.id;
      var res = await callHost('openSequence', id);
      if (!res.ok) throw new Error(res.error);
      $('seq-synced').classList.toggle('on', which === 'synced');
      $('seq-original').classList.toggle('on', which === 'original');
    } catch (err) {
      setStatus('status2', err.message, 'error');
    }
  }

  window.addEventListener('load', function () {
    $('sync').addEventListener('click', runSync);
    $('report').addEventListener('click', onReportClick);
    $('report').addEventListener('change', onReportChange);
    $('palette').addEventListener('click', onReportClick);
    $('seq-synced').addEventListener('click', function () { onSequenceButton('synced'); });
    $('seq-original').addEventListener('click', function () { onSequenceButton('original'); });
    $('seq-duplicate').addEventListener('click', function () { onSequenceButton('duplicate'); });
    $('done').addEventListener('click', function () { setStatus('status', ''); showView('setup'); });
    var ff = findFfmpeg();
    $('ffmpeg').textContent = ff ? 'ffmpeg: ' + ff : 'ffmpeg not found — run: ' + (isWin ? 'winget install Gyan.FFmpeg' : 'brew install ffmpeg');
    $('ffmpeg').className = 'foot ' + (ff ? '' : 'error');
    showView('setup');
  });
})();
