# Hosted demos

Production: [real-sim-physical.vercel.app](https://real-sim-physical.vercel.app/). Project: [yavol's Vercel workspace](https://vercel.com/yavols-projects/real-sim-physical).

One Vercel project serves the launch page at `/`, the collection studio at `/collect`, the robot console at `/robot`, and the video library at `/library`. Production builds use the repository root, `npm ci`, `npm run build`, and output directory `dist`. The connected `yavol/real-sim-physical` repository deploys each push to `main` automatically.

## Credentials and access

Configure the variables listed in `.env.example` as private Vercel environment variables. Actual values live in the ignored `.env.local` on the development machine and in Vercel, never in Git or browser code. Production uses `DEMO_PUBLIC=true`: judges and anyone with the URL can browse all pages, play videos, and use the live collection and robot actions without an account or access code. API and gateway credentials remain server-side. In an installation with public mode disabled, live actions require the signed demo session; library browsing remains public.

The collection API uses the existing OpenRouter and OpenAI integrations. Body/hand tracking runs in the visitor's browser; compressed checkpoint frames go to the vision provider, and optional live voice uses OpenAI. Visitors can download recordings/session JSON or explicitly save them to the shared cloud library.

## Video library

`modal_library.py` runs the existing Node library with FFmpeg in a separate CPU service. Original videos, compatible playback versions, thumbnails, session evidence, and metadata persist in the `real-sim-physical-library` Modal volume. The service also imports completed recordings from the shared robot runs volume. Only allowlisted library API routes are exposed by Vercel. Streaming and uploads use short-lived links scoped to an exact route and method; upload links also specify the file name and byte count. Large videos travel directly to the library service. A successful upload acknowledgement follows the persistent volume commit.

The library is public to anyone with the demo URL, including new uploads. VAST indexing and semantic search remain unconnected until a real workspace is verified; title, description, and tag search works on the saved archive. Deploy library source updates separately with `.venv/bin/modal deploy --profile yavol modal_library.py`, then configure its endpoint as `LIBRARY_BACKEND_URL` in Vercel.

## Robot gateway

The learned GPU policy continues to run in the existing `vast-gr1-tabletop` Modal app. `modal_web.py` creates a separate, single-container CPU gateway in the same Modal workspace. Only `server.py` and the robot's static UI are included in its image. A Modal secret named `real-sim-physical-web` supplies `ROBOT_WEB_TOKEN`, which must match the private Vercel variable of the same name. Requests without that token are rejected. Vercel forwards only the allowlisted robot routes and validated recording paths, and never returns this credential to visitors.

Recordings persist in the `real-sim-physical-runs` Modal volume. The browser reconnects the event stream with its last event ID before HTTP timeouts; rollout execution remains in the Modal gateway. No model training, new GPU app, or simulator changes are part of this deployment.

To update the gateway after modifying its Python source:

```sh
.venv/bin/modal deploy --profile yavol modal_web.py
```

Pushes to `main` deploy the Vercel frontend and API adapter. Changes to the Modal gateway require the separate command above. Both original local entrypoints remain available.

## Development and checks

```sh
npm ci
npm run build
npm run dev
npm run check
npm test
npm --prefix capture test
.venv/bin/python -m unittest discover -s web/test -p 'test_*.py'
```

The combined local site uses `http://127.0.0.1:8780`. Its ignored `.env.local` contains the hosted gateway URL and demo access settings. The recorded policy example bundled on the public launch page is the existing seed-44 bottle placement; it is labeled as a recording and does not imply a live rollout or a connection between human capture and robot training.
