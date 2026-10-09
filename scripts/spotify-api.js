// Thin wrapper around the Spotify Web API endpoints this widget needs.
// Every function takes a valid access token (see spotify-auth.js) as its last/only
// token argument — callers are responsible for refreshing it first.

const SpotifyApi = (function () {
	const BASE = 'https://api.spotify.com/v1';

	class SpotifyApiError extends Error {
		constructor(message, status) {
			super(message);
			this.status = status;
		}
	}

	// Circuit breaker, scoped per endpoint category rather than shared globally.
	// Observed behavior: the player endpoints (currently-playing, play/pause/skip,
	// Liked Songs) keep working reliably even while /me/playlists and playlist-track
	// endpoints get rate-limited — Spotify appears to apply a separate, stricter
	// quota to the playlists endpoints specifically (likely because playlist
	// export/scraping is a common abuse pattern there). A single shared breaker was
	// pausing the background now-playing poll too whenever only playlists were
	// blocked, which dropped the whole display into a scary "Connection Issue"
	// state over a problem that was never in the player endpoints. Cross-origin
	// fetch() responses also only expose a small safelist of headers to JavaScript,
	// and Retry-After generally isn't one of them unless the server opts in via
	// Access-Control-Expose-Headers, so the real wait time is often simply not
	// readable here — hence the fallback cooldown.
	const RATE_LIMIT_FALLBACK_COOLDOWN_MS = 60 * 1000;
	const rateLimitedUntilByCategory = { player: 0, playlists: 0 };

	async function request(path, accessToken, options, category) {
		options = options || {};
		category = category || 'player';

		const until = rateLimitedUntilByCategory[category] || 0;
		if (Date.now() < until) {
			const waitSec = Math.ceil((until - Date.now()) / 1000);
			throw new SpotifyApiError('Rate limited by Spotify — pausing ' + category + ' requests for ' + waitSec + 's.', 429);
		}

		const response = await fetch(BASE + path, {
			method: options.method || 'GET',
			headers: Object.assign(
				{ Authorization: 'Bearer ' + accessToken },
				options.body ? { 'Content-Type': 'application/json' } : {}
			),
			body: options.body ? JSON.stringify(options.body) : undefined
		});

		if (response.status === 429) {
			const retryAfterSec = Number(response.headers.get('Retry-After'));
			const cooldownMs = (Number.isFinite(retryAfterSec) && retryAfterSec > 0)
				? retryAfterSec * 1000
				: RATE_LIMIT_FALLBACK_COOLDOWN_MS;
			rateLimitedUntilByCategory[category] = Date.now() + cooldownMs;
			throw new SpotifyApiError(
				'Rate limited by Spotify — pausing ' + category + ' requests for ' + Math.ceil(cooldownMs / 1000) + 's.',
				429
			);
		}

		if (response.status === 204 || response.status === 202) return null;

		if (!response.ok) {
			let detail = '';
			try {
				const errJson = await response.json();
				detail = (errJson.error && errJson.error.message) || '';
			} catch (e) {}
			throw new SpotifyApiError(detail || ('Spotify API error ' + response.status), response.status);
		}

		if (response.status === 200) {
			const text = await response.text();
			return text ? JSON.parse(text) : null;
		}

		return null;
	}

	// --- Now playing & playback control ---

	function getCurrentlyPlaying(accessToken) {
		return request('/me/player/currently-playing?additional_types=track', accessToken);
	}

	function play(accessToken) {
		return request('/me/player/play', accessToken, { method: 'PUT' }, 'player');
	}

	function pause(accessToken) {
		return request('/me/player/pause', accessToken, { method: 'PUT' }, 'player');
	}

	function next(accessToken) {
		return request('/me/player/next', accessToken, { method: 'POST' }, 'player');
	}

	function previous(accessToken) {
		return request('/me/player/previous', accessToken, { method: 'POST' }, 'player');
	}

	// --- Liked Songs ---

	async function isTrackLiked(accessToken, trackId) {
		const result = await request('/me/tracks/contains?ids=' + encodeURIComponent(trackId), accessToken, null, 'player');
		return !!(result && result[0]);
	}

	function setTrackLiked(accessToken, trackId, liked) {
		return request('/me/tracks?ids=' + encodeURIComponent(trackId), accessToken, {
			method: liked ? 'PUT' : 'DELETE'
		}, 'player');
	}

	function getCurrentUser(accessToken) {
		return request('/me', accessToken, null, 'player');
	}

	// --- Playlists ---
	// Tagged as a separate 'playlists' category — Spotify appears to rate-limit
	// these endpoints independently and more strictly than the player endpoints
	// above, so a block here shouldn't pause those.

	async function getAllPlaylists(accessToken) {
		const playlists = [];
		let url = '/me/playlists?limit=50';
		while (url) {
			const page = await request(url, accessToken, null, 'playlists');
			if (!page) break;
			playlists.push.apply(playlists, page.items.filter(Boolean));
			url = page.next ? page.next.replace(BASE, '') : null;
		}
		return playlists;
	}

	// Returns true/false for whether trackUri appears anywhere in the given playlist.
	// Paginates through the playlist's tracks requesting only the URI field to keep
	// payloads small.
	async function playlistContainsTrack(accessToken, playlistId, trackUri) {
		let url = '/playlists/' + encodeURIComponent(playlistId) +
			'/tracks?fields=items(track(uri))%2Cnext&limit=100';
		while (url) {
			const page = await request(url, accessToken, null, 'playlists');
			if (!page) break;
			const found = page.items.some(function (item) {
				return item && item.track && item.track.uri === trackUri;
			});
			if (found) return true;
			url = page.next ? page.next.replace(BASE, '') : null;
		}
		return false;
	}

	function addTrackToPlaylist(accessToken, playlistId, trackUri) {
		return request('/playlists/' + encodeURIComponent(playlistId) + '/tracks', accessToken, {
			method: 'POST',
			body: { uris: [trackUri] }
		}, 'playlists');
	}

	function removeTrackFromPlaylist(accessToken, playlistId, trackUri) {
		return request('/playlists/' + encodeURIComponent(playlistId) + '/tracks', accessToken, {
			method: 'DELETE',
			body: { tracks: [{ uri: trackUri }] }
		}, 'playlists');
	}

	return {
		SpotifyApiError,
		getCurrentUser,
		getCurrentlyPlaying,
		play,
		pause,
		next,
		previous,
		isTrackLiked,
		setTrackLiked,
		getAllPlaylists,
		playlistContainsTrack,
		addTrackToPlaylist,
		removeTrackFromPlaylist
	};
})();
