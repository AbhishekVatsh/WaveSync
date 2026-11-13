# WaveSync

A free, PluralEyes-style panel for Adobe Premiere Pro. It syncs multiple cameras and separately recorded audio by matching their waveforms, then moves the clips into place on your timeline. It works for multicam podcasts, interviews, talking heads, and shoots with many separate takes.

Works with Premiere Pro 2022 and newer, on macOS and Windows.

## Install

**macOS**: paste into Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/AbhishekVatsh/WaveSync/main/get.sh | bash
```

**Windows**: paste into PowerShell:

```powershell
irm https://raw.githubusercontent.com/AbhishekVatsh/WaveSync/main/get.ps1 | iex
```

Then restart Premiere Pro and open **Window → Extensions → WaveSync**.

The installer also installs [ffmpeg](https://ffmpeg.org), which WaveSync uses to read audio. On Mac this needs [Homebrew](https://brew.sh); on Windows it uses winget. Run the same command again to update to the latest version.

**Prefer not to use the terminal?** Download the zip from [Releases](https://github.com/AbhishekVatsh/WaveSync/releases/latest), unzip it, and double-click the installer for your system.

## Use

1. Put all your camera clips and audio files in a sequence. They can all go on one track, or you can give each device its own track. Rough placement is fine.
2. Select the clips, or choose "All clips in the sequence".
3. Keep **Back up the sequence first** ticked, and press **Sync**.

WaveSync compares every file with every other file and groups matching files into **scenes**: for example, a camera clip with its audio takes, or a whole multicam podcast. You don't need one master recording that covers everything.

It then rebuilds the timeline:

- **One track per device.** Each camera gets its own video track, with its audio below. Each audio recorder gets its own audio track. Devices are recognized from how you laid the clips out, the file-name pattern (`C0449.MP4`, `TX01_MIC004_….wav`) and the media format.
- **Overlapping clips get their own track.** If two clips from the same device would overlap after syncing, the second one moves to an extra track.
- **Color labels.** Each device gets its own label color, on the timeline clips and in the Project panel.
- **Scenes run in order,** 2 seconds apart.

### The sync report

After syncing, the panel shows clips synced, time taken, and clips that didn't sync. Everything below updates the timeline straight away.

| Setting | Options |
|---|---|
| Camera audio | **Keep**, **Mute** (kept but switched off), or **Delete** (mics then start at A1) |
| Unused audio | Audio with no matching video is **Parked at end**, **Kept in order**, or **Removed** |
| Trim audio | **To video** (recorder files are cut to the length of their scene's video) or **Full length** |
| Link groups | **Camera + its audio**, or **Camera + mic audio** (each mic clip is linked to the camera clip it overlaps most) |
| Track layout | **Per device**, or **Compact** (fewest tracks) |
| Use these settings from now on | Saves them as the default for every new sync |

- **Track order:** each device row has a color picker, a **‹ ›** nudge that moves that device one frame earlier or later, and a track menu. Picking another device's tracks swaps the two.
- **Sequences:** **Synced** and **Original** switch between the synced sequence and the backup, and **Duplicate sequence** makes a copy.
- **More info:** shows every scene's offsets.

To undo everything, open the backup sequence ("<your sequence> - Backup") in your Project panel.

## Limits

- Clips are placed again at full length, so trims you made before syncing are not kept. The backup sequence has your original.
- Premiere's scripting can't create multicam source sequences, so there is no "Create Multicam" button.
- Clips with speed changes, nested sequences, and graphics are left where they are. The synced layout starts above them, so nothing of yours is overwritten.
- Video clips snap to frame boundaries, so sync accuracy is about half a frame.
- Clock drift on very long takes is reported but not corrected.

## How it works

- `js/synccore.js`: sync math, with no dependencies. A coarse pass cross-correlates 100 Hz loudness envelopes. A fine pass runs GCC-PHAT on the 8 kHz waveform for sub-millisecond offsets. Files are matched pairwise and joined into scenes with a maximum spanning forest.
- `js/layout.js`: turns sync results into a timeline plan: scene positions, device detection, one lane per device with extra lanes for overlaps, trims, parking, nudges.
- `js/main.js`: panel logic. Runs ffmpeg/ffprobe, talks to Premiere, and draws the sync report.
- `jsx/host.jsx`: Premiere scripting. Reads clips and rebuilds the timeline from the plan (tracks, labels, camera audio, links).
- `test/layout.test.js`: offline tests for the layout. Run with `jsc test/layout.test.js -- js/layout.js` (macOS: `/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc`).
- `CSXS/manifest.xml`: CEP panel registration.

## Development

- `bash install.sh` installs from a local checkout.
- `bash build.sh` builds the release zip into `dist/`.
- While Premiere is running, open http://localhost:8098 in Chrome to get the panel's devtools.

## Uninstall

Delete the `com.wavesync.panel` folder from:

- macOS: `~/Library/Application Support/Adobe/CEP/extensions/`
- Windows: `%APPDATA%\Adobe\CEP\extensions\`
