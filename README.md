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

1. Put the clips in a sequence, with **each camera and each audio recorder on its own track** (for example, Cam A on V1/A1, Cam B on V2/A2, lav recorder on A3). Takes from the same device go on the same track. Rough placement is fine.
2. Select the clips, or choose "All clips in the sequence".
3. Keep **Back up the sequence first** ticked, and press **Sync**.

WaveSync compares every file with every other file. Matching files are grouped into **scenes**: for example, a camera clip and its audio take, or a whole multicam podcast. Each scene is synced, and the scenes are laid out on the timeline in their current order, 2 seconds apart. You don't need one master recording that covers everything.

| Result | Meaning |
|---|---|
| anchor | The file the rest of the scene is lined up to |
| +0:01.914 (green) | Synced with high confidence |
| (check) (yellow) | Synced, but give it a quick look |
| No match found (red) | No matching audio. The clip is placed in order but not synced |

To undo, open the backup sequence ("<your sequence> - Backup") in your Project panel. Your original sequence stays open while you sync.

## Limits

- The panel won't move a clip on top of another clip. If anything would overlap, it stops and tells you which clips are in the way.
- Clips with speed changes, nested sequences, and graphics are skipped.
- Video clips snap to frame boundaries, so sync accuracy is about half a frame.
- Clock drift on very long takes is reported but not corrected.

## How it works

- `js/synccore.js`: sync math, with no dependencies. A coarse pass cross-correlates 100 Hz loudness envelopes. A fine pass runs GCC-PHAT on the 8 kHz waveform for sub-millisecond offsets. Files are matched pairwise and joined into scenes with a maximum spanning forest.
- `js/main.js`: panel logic. Runs ffmpeg and talks to Premiere.
- `jsx/host.jsx`: Premiere scripting. Reads clips and moves them.
- `CSXS/manifest.xml`: CEP panel registration.

## Development

- `bash install.sh` installs from a local checkout.
- `bash build.sh` builds the release zip into `dist/`.
- While Premiere is running, open http://localhost:8098 in Chrome to get the panel's devtools.

## Uninstall

Delete the `com.wavesync.panel` folder from:

- macOS: `~/Library/Application Support/Adobe/CEP/extensions/`
- Windows: `%APPDATA%\Adobe\CEP\extensions\`
