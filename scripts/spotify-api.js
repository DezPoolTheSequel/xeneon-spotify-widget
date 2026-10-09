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

	async function request(path, accessToken, options) {
		options = options || {};

		const response = await fetch(BASE + path, {
			method: options.method || 'GET',
			headers: Object.assign(
				{ Authorization: 'Bearer ' + accessToken },
				options.body ? { 'Content-Type': 'application/json' } : {}
			),
			body: options.body ? JSON.stringify(options.body) : undefined
		});

		// Fail fast on a 429 instead of silently retrying — during a sustained block
		// (as opposed to a brief burst), each retry is itself another request against
		// an already-exhausted quota, which can extend the block rather than ride it
		// out. Surface Spotify's actual Retry-After value so it's clear whether this
		// is a few seconds or much longer.
		if (response.status === 429) {
			const retryAfterSec = Number(response.headers.get('Retry-After'));
			const waitMsg = Number.isFinite(retryAfterSec) && retryAfterSec > 0
				? ('Rate limited by Spotify — try again in ' + retryAfterSec + 's.')
				: 'Rate limited by Spotify — try again shortly.';
			throw new SpotifyApiError(waitMsg, 429);
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
		return request('/me/player/play', accessToken, { method: 'PUT' });
	}

	function pause(accessToken) {
		return request('/me/player/pause', accessToken, { method: 'PUT' });
	}

	function next(accessToken) {
		return request('/me/player/next', accessToken, { method: 'POST' });
	}

	function previous(accessToken) {
		return request('/me/player/previous', accessToken, { method: 'POST' });
	}

	// --- Liked Songs ---

	async function isTrackLiked(accessToken, trackId) {
		const result = await request('/me/tracks/contains?ids=' + encodeURIComponent(trackId), accessToken);
		return !!(result && result[0]);
	}

	function setTrackLiked(accessToken, trackId, liked) {
		return request('/me/tracks?ids=' + encodeURIComponent(trackId), accessToken, {
			method: liked ? 'PUT' : 'DELETE'
		});
	}

	function getCurrentUser(accessToken) {
		return request('/me', accessToken);
	}

	// --- Playlists ---

	async function getAllPlaylists(accessToken) {
		const playlists = [];
		let url = '/me/playlists?limit=50';
		while (url) {
			const page = await request(url, accessToken);
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
			const page = await request(url, accessToken);
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
		});
	}

	function removeTrackFromPlaylist(accessToken, playlistId, trackUri) {
		return request('/playlists/' + encodeURIComponent(playlistId) + '/tracks', accessToken, {
			method: 'DELETE',
			body: { tracks: [{ uri: trackUri }] }
		});
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
