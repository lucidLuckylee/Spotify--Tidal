# Spotify → Tidal Library Sync

Firefox extension that copies your Spotify library — liked songs, playlists,
followed artists — over to Tidal.

## How it works

While you browse Spotify Web Player and Tidal, the extension
passively watches your own outgoing requests to learn the API operation
hashes, auth headers, and Tidal bearer token it needs to replay them on
your behalf. Nothing is injected into the page and no credentials are ever
asked for.

## Run unsigned in Firefox

`about:debugging` → This Firefox → Load Temporary Add-on → pick
`manifest.json`.

## Permissions

| Permission            | Why                                                            |
| --------------------- | -------------------------------------------------------------- |
| `webRequest`          | Observe your own Spotify/Tidal API calls to learn auth headers. Read-only; nothing is modified. |
| `storage`             | Cache the captured library and which tracks are already exported. `browser.storage.local`, on-device only. |
| `tabs`                | Detect whether Spotify/Tidal tabs are open and open per-track search links. Never reads tab content. |
| `*://*.spotify.com/*` | Replay Spotify API calls.                                      |
| `*://*.tidal.com/*`   | Search Tidal and write playlists/favorites.                    |

`data_collection_permissions: ["none"]` — no data leaves the device except
to Spotify and Tidal themselves.

## Privacy

- No analytics, no telemetry, no third-party endpoints.
- All network traffic goes to `*.spotify.com` or `*.tidal.com` only.
- All persisted data lives in `browser.storage.local` and can be wiped by
  removing the extension.
- The extension reuses the user's existing logged-in sessions; it never asks
  for passwords and does not store credentials.

## License

GPL-3.0 — see `LICENSE`.
