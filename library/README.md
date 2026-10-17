# Relay video library

Search, sort, organize, and play your human demonstrations and robot rollouts.

```sh
./start-library.sh
```

Run the command from the project root. Open http://127.0.0.1:8791. This is a local application and binds to loopback only. Node 24+ and FFmpeg/FFprobe are expected; the latter generate measured durations, dimensions, and thumbnails. The application still retains and serves originals if preview extraction is unavailable. HEVC recordings receive an H.264 playback copy. iPhone HLG / BT.2020 footage uses the included HLG-to-Rec.709 LUT for an SDR preview; the untouched original remains available through Download original. Portrait rotation is applied to the preview and shown correctly in video dimensions.

The library automatically discovers the existing human upload under `artifacts/uploads/` and recordings from the robot console under `artifacts/runs/`. The SDR/H264 conversions of the same original are grouped into one initial upload. Simulation clips are labeled and have a separate navigation filter. Upload multiple MP4, WebM, MOV, or M4V videos (up to 300 MB each). Browser codec support varies; download an original when it cannot play inline.

Search matches all typed words across the title, filename, description, and tags. Sort by date, name, duration, or file size. Filter by source, status, or recent upload date. Favorites, titles, descriptions, and tags persist in `artifacts/library/`, which is excluded from Git. MP4/WebM bytes are streamed to disk with bounded upload sizes, and playback supports byte ranges for seeking. New robot recordings and saved captures appear on refresh or the 15-second refresh while the library is visible.

## Capture → library

A newly loaded Capture page has a **Video library** link and **Save to library** after finishing a recording. The save action opens the local library and transfers the original Blob plus Relay session JSON through a checked-origin popup bridge. The library saves the video, attaches its session, and acknowledges persistence before Capture displays success. It retains the original recording in Capture if saving fails. No VAST upload, camera restart, or credential transfer occurs.

An already open Capture page needs a reload to get the new controls. Finish and download any existing capture before reloading. Existing recording/camera tabs were intentionally left running during implementation.

You can also upload a previously downloaded video and attach its `relay.capture.v1` session JSON from video details. The library shows verified checkpoint counts and landmark samples. **Sequence verified** means the capture's existing checkpoint evidence says the full sequence completed; it does not certify robot execution or training. Raw landmark coordinates and complete evidence remain in the downloadable session JSON.

## Optional VAST connection

**Connect VAST** accepts the VSS v2 workspace URL and an existing access token. The connection is checked before it is shown as connected; credentials live only in server memory for this session. For configuration across restarts, copy `.env.example` to `.env`, set `VAST_BASE_URL` and `VAST_ACCESS_TOKEN`, and restart the library. Environment credentials never appear in the browser or local playback URLs. Keep `.env` private and excluded from Git.

The earlier upload workspace was recovered as `https://team-26-vss.thecosmoslabs.com`. A live visit on 17 October 2026 reached **Cloudflare Access sign-in**, so authenticated browse, semantic search, and streaming against that workspace have not been verified. A Cloudflare Access protected deployment may require an organizer-provided API-access route or service credentials in addition to the VSS token. The connector does not bypass Cloudflare authentication and never labels a failed connection as connected.

The connector follows the official [VAST video browsing contract](https://github.com/vast-data/vast-builders-challenge/blob/main/.cursor/skills/retrieval/videos/SKILL.md) and [search contract](https://github.com/vast-data/vast-builders-challenge/blob/main/.cursor/skills/retrieval/search/SKILL.md): paginated `/api/v1/videos/explore`, `/api/v1/search`, and server-proxied `/api/v1/videos/stream`. VAST search results support jumping to a matched segment. Browse caps at 480 entries, search at 100 matches; the UI explicitly reports these limits.

**Local uploads are not automatically sent to VAST.** Local metadata search and remote VAST content search are separate, labeled views. Sending new recordings to VAST ingestion still requires the workspace's authenticated upload configuration. No synthetic search results or placeholder recordings are used.

## Validation

```sh
cd library
npm run check
npm test
```

Tests cover upload persistence, invalid files and cleanup, byte-range playback, favorites, metadata edits, attached capture evidence, reopening the store, source and origin guards, combined filtering and sorting, and VAST request/response handling with credential isolation. VAST tests use fixtures and prove the connector contract, not a successful live connection.
