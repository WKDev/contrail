<p align="center">
  <img src="docs/images/hero.svg" alt="Drone Library — flight video merge · HUD overlay · goggles OSD" width="100%">
</p>

<p align="center">
  <a href="README.md">한국어</a> · <b>English</b>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3b82f6">
  <img alt="Avata 2" src="https://img.shields.io/badge/Avata%202-tested-22c55e">
  <img alt="Goggles 3" src="https://img.shields.io/badge/Goggles%203-tested-22c55e">
  <img alt="Chrome / Edge" src="https://img.shields.io/badge/Chrome%20%2F%20Edge-desktop-64748b">
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-f59e0b">
</p>

**Drone Library** is a web app that takes the clips scattered across your drone's SD card, **groups and joins them per flight**, **draws a HUD** from the flight data embedded in the video, and **composites the OSD from your goggles recording** on top.
There's nothing to install and no server. The browser reads and writes your local folder directly, and your footage never leaves your computer.

> The primary target is **DJI Avata 2 + DJI Goggles 3**. The app was built and verified on real recordings from both devices.
> Other aircraft and goggles may work if their files are structured similarly. Share a sample and we can widen support. See [Contributing](#contributing).

<br>

## What it does

<p align="center">
  <img src="docs/images/pipeline.svg" alt="SD card → group & merge per flight → HUD + goggles OSD → done" width="100%">
</p>

- **Per-flight lossless merge.** It joins the 7:40 auto-split files and clips you restarted right away into one flight. No re-encoding, and the result is verified by frame count. You can inspect any seam and split or drop clips yourself.
- **HUD overlay.** Instruments are drawn from the attitude, heading, speed, altitude and GPS stored inside the video file. There are 12 widgets, 15 themes and 8 layout templates. You lay them out by dragging on the player, and they snap to edges, spacing and circle-to-circle tangency.
- **Goggles OSD.** Goggles 3 recordings are **synced automatically** by timestamp and motion correlation. Only the OSD is keyed out and laid over the full-quality drone footage, and stretches showing menus or warning dialogs are skipped.
- **Flight record summary.** It reads `DJIFlightRecord_*.txt` headers and pairs flight time, distance and max altitude/speed with each video. Only the header is read, since the body is encrypted.
- **Process all.** One button merges every pending flight and renders the HUD videos, one after another. You can cancel at any point, and a failed flight doesn't stop the rest.
- **YouTube upload (optional).** Hidden unless you turn it on in Settings.

<br>

## HUD gallery

<table>
  <tr>
    <td width="50%"><img src="docs/images/hud-classic.jpg" alt="Classic theme"><br><sub><b>Classic</b> · bottom gauges</sub></td>
    <td width="50%"><img src="docs/images/hud-fighter.jpg" alt="Fighter HUD theme"><br><sub><b>Fighter HUD</b> · pitch ladder</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/hud-racing.jpg" alt="Racing theme"><br><sub><b>Racing</b> · big speedo</sub></td>
    <td width="50%"><img src="docs/images/hud-glass.jpg" alt="Glass theme"><br><sub><b>Glass</b> · corners</sub></td>
  </tr>
</table>

<sub>These images were rendered by the app's real HUD code (`src/hud.ts`) using synthetic flight data over a drawn backdrop. With a Google Map Tiles API key, the minimap shows satellite imagery.</sub>

<br>

## Getting started

**You need:**
- Desktop **Chrome** or **Edge**. The app relies on the File System Access API and WebCodecs, so Firefox and Safari aren't supported yet.
- A folder containing the `DJI_*.MP4` files copied from the drone's SD card.
- Optionally, the goggles' SD card or a folder of goggles recordings.

**Steps:**
1. Open the app and pick your **drone footage folder**, plus the goggles folder if you have one.
2. Clips are grouped into flights. Open a flight to preview the merged result in the player.
3. Tune the instruments in the **HUD** tab and the OSD region in the **Goggles** tab. Changes save instantly, and Ctrl+Z undoes them.
4. Click **Merge and build overlay**, or **Process all** in the library.

Finished videos land in `2_ready/` inside your folder. Originals are never deleted; they're moved to `_sources/`.

<br>

## Privacy

- Video, flight data and location are processed **only inside your browser**. The app has no server.
- Only two things can make network requests, and both are opt-in:
  - **The satellite minimap** fetches map tiles for the flight area from Google once you add a Map Tiles API key.
  - **YouTube upload** sends the videos you choose once you enable it and connect a Google account.

<br>

## Development

```sh
pnpm install
pnpm dev        # http://localhost:5173
pnpm test       # unit tests (tests needing real footage run only when DJI_TEST_DIR is set)
pnpm build      # type-check + static build → dist/
```

`dist/` can be deployed to any static host that serves HTTPS. Copy `.env.example` to `.env` for default map and upload settings.
`VITE_` values are bundled verbatim, so **restrict API keys by HTTP referrer**. Users can also enter keys in the app's Settings.

The detailed behavior is documented, in Korean, in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). It covers the grouping rules, goggles sync, OSD keying and render safeguards.

<br>

## Contributing

Collaboration and contributions are **always welcome**, and they don't have to be code:

- **Samples from other aircraft or goggles** (Mini, Air, Mavic, Neo, Goggles 2, Goggles N3, …). Even one short recording helps.
- **Bug reports.** Include your browser version, aircraft and goggles models, and what you clicked. The "Copy error details" button on the app's error screen helps most.
- **Translations.** Korean and English ship today (`src/i18n.ts`).
- **HUD theme and widget ideas**, docs, and feedback.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgements

- [telemetry-parser](https://github.com/AdrianEddy/telemetry-parser) was the reference for DJI's `djmd` metadata layout.
- [dji-log-parser](https://github.com/lvauvillier/dji-log-parser) was the reference for the flight record format.
- [Pretendard](https://github.com/orioncactus/pretendard), [Lucide](https://lucide.dev) and [Preact](https://preactjs.com)

## License

[MIT](LICENSE)

DJI, Avata and DJI Goggles are trademarks of SZ DJI Technology Co., Ltd. This is an unofficial project and is not affiliated with DJI.
