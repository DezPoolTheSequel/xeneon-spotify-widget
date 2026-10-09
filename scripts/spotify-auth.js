// Spotify Authorization Code + PKCE flow, and token persistence.
//
// NOTE on token storage: Corsair's widget security checklist says widgets should never
// store tokens/credentials in localStorage. This widget deliberately stores the refresh
// token there anyway — localStorage is the only persistent storage a widget gets, this
// widget is for personal use only (not Marketplace distribution), and the alternative is
// re-running the full browser login every time iCUE or the PC restarts. The token is
// scoped to this widget's own storage key and can be revoked anytime from
// https://www.spotify.com/account/apps/. This is a deliberate, documented exception —
// see README.md.

const SPOTIFY_AUTH_SCOPES = [
	'user-read-currently-playing',
	'user-read-playback-state',
	'user-modify-playback-state',
	'playlist-read-private',
	'playlist-read-collaborative',
	'playlist-modify-public',
	'playlist-modify-private',
	'user-library-read',
	'user-library-modify'
].join(' ');

const SpotifyAuth = (function () {
	let pendingVerifier = null;
	let pendingState = null;

	function storageKey() {
		return (typeof uniqueId !== 'undefined' && uniqueId) ? uniqueId : 'browser-preview';
	}

	function readStorage() {
		try {
			const raw = localStorage.getItem(storageKey());
			return raw ? JSON.parse(raw) : {};
		} catch (e) {
			return {};
		}
	}

	function writeStorage(partial) {
		const current = readStorage();
		Object.assign(current, partial);
		try {
			localStorage.setItem(storageKey(), JSON.stringify(current));
		} catch (e) {
			// Storage unavailable (e.g. private/sandboxed preview) — degrade silently,
			// the widget will just ask the user to reconnect more often.
		}
	}

	function getTokens() {
		const data = readStorage();
		return data.spotifyAuth || null;
	}

	function saveTokens(tokens) {
		writeStorage({ spotifyAuth: tokens });
	}

	function clearTokens() {
		writeStorage({ spotifyAuth: null });
	}

	async function buildAuthorizeUrl(clientId, redirectUri) {
		pendingVerifier = pkceGenerateVerifier();
		pendingState = pkceGenerateState();
		const challenge = await pkceGenerateChallenge(pendingVerifier);

		const params = new URLSearchParams({
			client_id: clientId,
			response_type: 'code',
			redirect_uri: redirectUri,
			code_challenge_method: 'S256',
			code_challenge: challenge,
			state: pendingState,
			scope: SPOTIFY_AUTH_SCOPES
		});

		return 'https://accounts.spotify.com/authorize?' + params.toString();
	}

	async function exchangeCode(code, clientId, redirectUri) {
		if (!pendingVerifier) {
			throw new Error('No login in progress. Tap "Connect to Spotify" again before pasting the code.');
		}

		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			code: code,
			redirect_uri: redirectUri,
			client_id: clientId,
			code_verifier: pendingVerifier
		});

		const response = await fetch('https://accounts.spotify.com/api/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString()
		});

		pendingVerifier = null;
		pendingState = null;

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error('Spotify rejected the authorization code (' + response.status + '). ' + text);
		}

		const json = await response.json();
		saveTokens({
			accessToken: json.access_token,
			refreshToken: json.refresh_token,
			expiresAt: Date.now() + (json.expires_in * 1000)
		});
		return true;
	}

	async function refreshTokens(clientId) {
		const tokens = getTokens();
		if (!tokens || !tokens.refreshToken) return null;

		const body = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: tokens.refreshToken,
			client_id: clientId
		});

		const response = await fetch('https://accounts.spotify.com/api/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: body.toString()
		});

		if (!response.ok) {
			// Refresh token revoked/expired — clear it so the widget prompts to reconnect
			// instead of retrying a doomed request forever.
			if (response.status === 400 || response.status === 401) clearTokens();
			return null;
		}

		const json = await response.json();
		const updated = {
			accessToken: json.access_token,
			// Spotify doesn't always rotate the refresh token — keep the old one if absent.
			refreshToken: json.refresh_token || tokens.refreshToken,
			expiresAt: Date.now() + (json.expires_in * 1000)
		};
		saveTokens(updated);
		return updated;
	}

	async function getValidAccessToken(clientId) {
		const tokens = getTokens();
		if (!tokens) return null;

		const EXPIRY_BUFFER_MS = 60 * 1000;
		if (tokens.accessToken && tokens.expiresAt && Date.now() < tokens.expiresAt - EXPIRY_BUFFER_MS) {
			return tokens.accessToken;
		}

		const refreshed = await refreshTokens(clientId);
		return refreshed ? refreshed.accessToken : null;
	}

	function isConnected() {
		return !!(getTokens() && getTokens().refreshToken);
	}

	function disconnect() {
		clearTokens();
	}

	return {
		buildAuthorizeUrl,
		exchangeCode,
		getValidAccessToken,
		isConnected,
		disconnect
	};
})();
