# Spotify Now Playing — Xeneon Edge Widget

A custom [CORSAIR iCUE widget](https://docs.elgato.com/icue/widgets/) for the
[XENEON EDGE](https://www.corsair.com/ww/en/p/monitors/cc-9011306-ww/xeneon-edge-14-5-lcd-touchscreen-cc-9011306-ww)
that shows the currently playing Spotify track with playback controls — and a playlist
picker that highlights which of your playlists already contain the current song, so adding
a track is a single tap.

- **Small** slot: album art + playback controls only.
- **Medium / Large / Extra Large** slots: also shows your playlists below the controls
  (to the side in horizontal/landscape mounting), with the current track's playlists
  highlighted. Tap any playlist to add or remove the current track from it.
- A Liked Songs heart button next to the controls, same as stock Spotify.
- Works in both horizontal and vertical Xeneon Edge mounting.

## Requirements

- Windows 10+
- [iCUE 5.47+](https://www.corsair.com/downloads) with a CORSAIR XENEON EDGE
- A **Spotify Premium** account — playback control (play/pause/skip) and some playlist
  endpoints require Premium; without it, now-playing display and Liked Songs still work
  but transport controls will fail silently against Spotify's API.
- A free [Spotify Developer](https://developer.spotify.com/dashboard) account
- [Node.js](https://nodejs.org/) 20+, for the `icuewidget` packaging CLI

## Setup

### 1. Create a Spotify app

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → **Create app**.
2. App name/description: anything you like (e.g. "Xeneon Edge Widget").
3. **Redirect URI**: add exactly
   ```
   https://dezpoolthesequel.github.io/xeneon-spotify-widget/callback.html
   ```
   This is a static page in this repo (see [`docs/callback.html`](docs/callback.html)) —
   it's the only way the widget can receive Spotify's login result, since the widget
   itself is an embedded view with no address Spotify could redirect to directly.
4. Which API/SDKs are you planning to use: **Web API**.
5. Save, then open the app and copy its **Client ID** (you won't need the Client Secret —
   this widget uses the PKCE flow, which doesn't use one).

### 2. Install the widget

Download `spotify-now-playing.icuewidget` from the
[latest release](https://github.com/DezPoolTheSequel/xeneon-spotify-widget/releases/latest).

In iCUE, go to the Widgets panel → **+** → select the downloaded `.icuewidget` file, and
add it to your XENEON EDGE at whatever size you like.

<details>
<summary>Building from source instead</summary>

```sh
git clone https://github.com/DezPoolTheSequel/xeneon-spotify-widget.git
cd xeneon-spotify-widget
npm install -g icuewidget-cli
icuewidget validate .
icuewidget package .
```

This produces the same `.icuewidget` file at the repo root.
</details>

### 3. Connect your Spotify account

1. Open the widget's settings in iCUE and paste your **Spotify Client ID** under
   *Spotify Connection*.
2. The widget now shows a **Connect to Spotify** button — tap it. This opens Spotify's
   login/consent page in your system browser (not inside the widget).
3. Approve access. Spotify redirects your browser to the callback page above, which
   shows an authorization code with a **Copy Code** button.
4. Paste that code into the widget's **Paste Authorization Code** field in settings.
   The widget exchanges it for an access token automatically and starts showing your
   current track within a few seconds.

You only need to repeat this if you explicitly disconnect or Spotify revokes access —
the widget keeps itself signed in using a refresh token (see **Token storage** below).

## What this widget sends and stores

- Requests go only to `accounts.spotify.com` and `api.spotify.com`, over HTTPS.
- Scopes requested, and why:
  | Scope | Why |
  |---|---|
  | `user-read-currently-playing`, `user-read-playback-state` | show the current track, progress, and play/pause state |
  | `user-modify-playback-state` | play/pause/skip buttons |
  | `user-library-read`, `user-library-modify` | the Liked Songs heart button |
  | `playlist-read-private`, `playlist-read-collaborative` | list your playlists and check which contain the current track |
  | `playlist-modify-public`, `playlist-modify-private` | the add/remove-from-playlist tap action |
- **Token storage:** Corsair's widget security guidelines recommend never persisting
  tokens in `localStorage`. This widget does so anyway, deliberately — it's the only
  persistent storage a widget gets, this is a personal-use widget (not distributed via
  Marketplace), and the alternative is re-running the full browser login every time iCUE
  or your PC restarts. The refresh token lives only in this widget's own storage slot on
  your machine. Revoke it anytime from
  [spotify.com/account/apps](https://www.spotify.com/account/apps/).

## Sizing reference

| Size | Horizontal | Vertical | Shows playlists? |
|---|---|---|---|
| Small | 840×344 | 696×416 | No — art + controls only |
| Medium | 840×696 | 696×840 | Yes |
| Large | 1688×696 | 696×1688 | Yes |
| Extra Large | 2536×696 | 696×2536 | Yes |

## Known limitations

- Playback controls need an active Spotify Connect device (phone, desktop app, another
  speaker) — if nothing is open anywhere, Spotify's API has nothing to control.
- Checking which playlists already contain the current track means paging through each
  playlist's tracks; with a large number of playlists this fills in over a second or two
  rather than instantly (each row shows a small spinner until it resolves).
- The refresh interval (Settings → Playback) polls Spotify every 2–10 seconds; it does
  not use real-time push updates.

## Development

```sh
npm install -g icuewidget-cli
icuewidget validate .     # checks manifest + markup against the widget spec
icuewidget package .      # produces dist/*.icuewidget
```

You can also open `index.html` directly in a browser for quick iteration — the Spotify
connect button falls back to a normal `window.open`, and personalization properties fall
back to the CSS defaults, since iCUE isn't injecting them outside of iCUE itself.

## License

Do whatever you want with it.
