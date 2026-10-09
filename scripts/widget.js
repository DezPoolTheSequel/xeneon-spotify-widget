// Redirect URI registered on the Spotify Developer dashboard — a static page in this
// repo's GitHub Pages site. See README.md for setup.
const SPOTIFY_REDIRECT_URI = 'https://dezpoolthesequel.github.io/xeneon-spotify-widget/callback.html';

const PLAYLISTS_CACHE_MS = 5 * 60 * 1000;
const CONTAINMENT_CONCURRENCY = 2;
const CONTAINMENT_STAGGER_MS = 120;

let lastSeenAuthCode = '';
let pollTimer = null;
let currentTrack = null; // { id, uri, name, artist, imageUrl, durationMs, progressMs, isPlaying }
let likedState = null;
let playlistsCache = null;
let playlistsCacheAt = 0;
let containmentState = {}; // playlistId -> true | false | 'checking'
let currentUserId = null;
let consecutiveErrors = 0;

// --- iCUE property access (see references/html-template.md for rationale) ---

function getIcueProperty(name) {
	if (typeof window !== 'undefined' && Object.prototype.hasOwnProperty.call(window, name)) {
		const value = window[name];
		if (value !== undefined && value !== null && value !== '') return value;
	}
	try {
		const value = Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')();
		if (value !== undefined && value !== null && value !== '') return value;
	} catch (e) {}
	return undefined;
}

function clampRange(v, min, max, d) {
	v = Number(v);
	if (!Number.isFinite(v)) return d;
	return Math.max(min, Math.min(max, v));
}

function resolveMediaPath(value) {
	if (!value) return '';
	if (typeof value === 'string') return value;
	if (value.pathToAsset) return value.pathToAsset;
	if (value.path) return value.path;
	return '';
}

function normalizeMediaConfig(rawMedia) {
	const mediaPath = resolveMediaPath(rawMedia);
	if (!mediaPath) return null;
	const base = (rawMedia && typeof rawMedia === 'object') ? rawMedia : {};
	return {
		path: base.pathToAsset || mediaPath,
		baseWidth: Number(base.baseWidth) || 0,
		baseHeight: Number(base.baseHeight) || 0,
		scale: Number.isFinite(Number(base.scale)) ? Number(base.scale) : 1,
		positionX: Number(base.positionX) || 0,
		positionY: Number(base.positionY) || 0,
		angle: Number(base.angle) || 0
	};
}

// --- Media background ---

const mediaMount = document.getElementById('media-background');

function createMediaBackgroundComponent(container) {
	if (!container) return { clear: function () {}, loadMedia: function () {} };

	if (typeof MediaViewer === 'function') {
		const viewer = new MediaViewer({
			container: container,
			onMediaError: function (error) { console.error('Media background error:', error); }
		});
		return {
			clear: function () { viewer.clear(); },
			loadMedia: function (config) { viewer.loadMedia(config); }
		};
	}

	// Static fallback when MediaViewer is unavailable (e.g. plain browser testing)
	return {
		clear: function () { container.style.backgroundImage = ''; container.style.visibility = 'hidden'; },
		loadMedia: function (config) {
			const p = config && config.path;
			if (!p) { container.style.backgroundImage = ''; container.style.visibility = 'hidden'; return; }
			container.style.backgroundImage = "url('" + String(p).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "')";
			container.style.backgroundRepeat = 'no-repeat';
			container.style.backgroundSize = 'cover';
			container.style.backgroundPosition = 'center';
			container.style.visibility = 'visible';
		}
	};
}

const mediaBackgroundComponent = createMediaBackgroundComponent(mediaMount);

function applyStyles() {
	const root = document.documentElement;

	const bgTransparency = clampRange(getIcueProperty('transparency'), 0, 100, 100) / 100;
	root.style.setProperty('--bg-opacity', bgTransparency);

	const tc = getIcueProperty('textColor');
	const ac = getIcueProperty('accentColor');
	const bgc = getIcueProperty('backgroundColor');
	root.style.setProperty('--text-color', (typeof tc === 'string' && tc) ? tc : '#ffffff');
	root.style.setProperty('--accent-color', (typeof ac === 'string' && ac) ? ac : '#1db954');
	root.style.setProperty('--bg-color', (typeof bgc === 'string' && bgc) ? bgc : '#000000');
	root.style.setProperty('--bg-blur', clampRange(getIcueProperty('glassBlur'), 0, 30, 0) + 'px');

	const mediaConfig = normalizeMediaConfig(getIcueProperty('backgroundMedia'));
	if (!mediaConfig) {
		mediaBackgroundComponent.clear();
	} else {
		mediaBackgroundComponent.loadMedia(mediaConfig);
	}
}

// --- State machine ---

function showState(state) {
	const panels = ['disconnected-state', 'loading-state', 'empty-state', 'error-state'];
	panels.forEach(function (cls) {
		document.querySelector('.' + cls).classList.toggle('is-active', cls.indexOf(state) === 0);
	});
	document.getElementById('content').classList.toggle('is-active', state === 'content');
}

function showError(title, body) {
	document.getElementById('errorTitle').textContent = title;
	document.getElementById('errorBody').textContent = body || '';
	showState('error');
}

let toastTimer = null;
function showToast(message) {
	const toast = document.getElementById('toast');
	toast.textContent = message;
	toast.classList.add('is-visible');
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(function () { toast.classList.remove('is-visible'); }, 4000);
	console.error(message);
}

// --- Spotify link opening (system browser, not the widget's own webview) ---

function openExternalLink(url) {
	if (window.plugins && window.plugins.Linkprovider && typeof pluginLinkprovider_initialized !== 'undefined' && pluginLinkprovider_initialized) {
		window.plugins.Linkprovider.open(url);
	} else {
		window.open(url, '_blank');
	}
}

async function handleConnectClick() {
	const clientId = getIcueProperty('spotifyClientId');
	if (!clientId) {
		showError('Client ID Missing', 'Enter your Spotify Client ID in the widget settings first.');
		return;
	}
	const url = await SpotifyAuth.buildAuthorizeUrl(clientId, SPOTIFY_REDIRECT_URI);
	openExternalLink(url);
}

async function checkAuthCodeChanged() {
	const code = getIcueProperty('spotifyAuthCode');
	if (!code || code === lastSeenAuthCode) return;
	lastSeenAuthCode = code;

	const clientId = getIcueProperty('spotifyClientId');
	if (!clientId) {
		showError('Client ID Missing', 'Enter your Spotify Client ID in the widget settings first.');
		return;
	}

	showState('loading');
	try {
		await SpotifyAuth.exchangeCode(code, clientId, SPOTIFY_REDIRECT_URI);
		startPolling();
	} catch (e) {
		showError('Couldn’t Connect', e.message || 'Tap "Connect to Spotify" again to retry.');
	}
}

// --- Polling / now playing ---

function formatTime(ms) {
	const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	return m + ':' + (s < 10 ? '0' : '') + s;
}

function startPolling() {
	if (pollTimer) clearInterval(pollTimer);
	const intervalSec = clampRange(getIcueProperty('pollIntervalSec'), 2, 10, 3);
	pollNow();
	pollTimer = setInterval(pollNow, intervalSec * 1000);
}

async function pollNow() {
	const clientId = getIcueProperty('spotifyClientId');
	if (!clientId) return;

	const accessToken = await SpotifyAuth.getValidAccessToken(clientId);
	if (!accessToken) {
		if (pollTimer) clearInterval(pollTimer);
		showState('disconnected');
		return;
	}

	try {
		const data = await SpotifyApi.getCurrentlyPlaying(accessToken);
		consecutiveErrors = 0;

		if (!data || !data.item) {
			currentTrack = null;
			showState('empty');
			return;
		}

		await updateTrackUI(data, accessToken);
		showState('content');
	} catch (e) {
		consecutiveErrors++;
		// Tolerate transient blips (rate limiting, brief network issues) by keeping the
		// last known content on screen. Only surface an error after repeated failures.
		if (consecutiveErrors >= 3 || !currentTrack) {
			showError('Connection Issue', e.message || 'Could not reach Spotify.');
		}
	}
}

async function updateTrackUI(data, accessToken) {
	const item = data.item;
	const isNewTrack = !currentTrack || currentTrack.id !== item.id;

	currentTrack = {
		id: item.id,
		uri: item.uri,
		name: item.name,
		artist: (item.artists || []).map(function (a) { return a.name; }).join(', '),
		imageUrl: item.album && item.album.images && item.album.images[0] ? item.album.images[0].url : '',
		durationMs: item.duration_ms,
		progressMs: data.progress_ms || 0,
		isPlaying: !!data.is_playing
	};

	document.getElementById('trackName').textContent = currentTrack.name;
	document.getElementById('trackArtist').textContent = currentTrack.artist;
	const art = document.getElementById('albumArt');
	if (art.src !== currentTrack.imageUrl) art.src = currentTrack.imageUrl;

	document.getElementById('timeElapsed').textContent = formatTime(currentTrack.progressMs);
	document.getElementById('timeTotal').textContent = formatTime(currentTrack.durationMs);
	const pct = currentTrack.durationMs ? (currentTrack.progressMs / currentTrack.durationMs) * 100 : 0;
	document.getElementById('progressFill').style.width = clampRange(pct, 0, 100, 0) + '%';

	document.getElementById('playIcon').style.display = currentTrack.isPlaying ? 'none' : '';
	document.getElementById('pauseIcon').style.display = currentTrack.isPlaying ? '' : 'none';

	if (isNewTrack) {
		likedState = null;
		containmentState = {};
		refreshLikedState(accessToken);
		refreshPlaylistsAndContainment(accessToken);
	}
}

// --- Playback controls ---

async function withAccessToken(fn) {
	const clientId = getIcueProperty('spotifyClientId');
	if (!clientId) return;
	const accessToken = await SpotifyAuth.getValidAccessToken(clientId);
	if (!accessToken) { showState('disconnected'); return; }
	try {
		await fn(accessToken);
	} catch (e) {
		console.error(e);
	}
}

let playPauseCooldownUntil = 0;

function wirePlaybackControls() {
	document.getElementById('playPauseBtn').addEventListener('click', function () {
		if (!currentTrack) return;

		// Backstop against any duplicate/rapid-fire click event (touchscreens can
		// synthesize more than one) — a genuine second tap this fast would just be
		// ignored, which is fine for a play/pause button.
		const now = Date.now();
		if (now < playPauseCooldownUntil) return;
		playPauseCooldownUntil = now + 500;

		// Flip the icon immediately instead of waiting for the next poll to confirm —
		// Spotify's own playback state can take a second or two to propagate, which
		// otherwise reads as a laggy button even though the music itself responds
		// right away.
		currentTrack.isPlaying = !currentTrack.isPlaying;
		document.getElementById('playIcon').style.display = currentTrack.isPlaying ? 'none' : '';
		document.getElementById('pauseIcon').style.display = currentTrack.isPlaying ? '' : 'none';

		withAccessToken(async function (accessToken) {
			if (currentTrack.isPlaying) {
				await SpotifyApi.play(accessToken);
			} else {
				await SpotifyApi.pause(accessToken);
			}
			setTimeout(pollNow, 600);
		});
	});

	document.getElementById('nextBtn').addEventListener('click', function () {
		withAccessToken(async function (accessToken) {
			await SpotifyApi.next(accessToken);
			setTimeout(pollNow, 300);
		});
	});

	document.getElementById('prevBtn').addEventListener('click', function () {
		withAccessToken(async function (accessToken) {
			await SpotifyApi.previous(accessToken);
			setTimeout(pollNow, 300);
		});
	});

	document.getElementById('likeBtn').addEventListener('click', function () {
		if (!currentTrack) return;
		const likeBtn = document.getElementById('likeBtn');
		const nextLiked = !likedState;
		withAccessToken(async function (accessToken) {
			try {
				await SpotifyApi.setTrackLiked(accessToken, currentTrack.id, nextLiked);
				likedState = nextLiked;
				likeBtn.classList.toggle('is-liked', likedState);
			} catch (e) {
				console.error('Failed to update Liked Songs:', e);
			}
		});
	});

	document.getElementById('connectBtn').addEventListener('click', handleConnectClick);
}

async function refreshLikedState(accessToken) {
	if (!currentTrack) return;
	const trackId = currentTrack.id;
	try {
		const liked = await SpotifyApi.isTrackLiked(accessToken, trackId);
		if (!currentTrack || currentTrack.id !== trackId) return; // track changed mid-flight
		likedState = liked;
		document.getElementById('likeBtn').classList.toggle('is-liked', likedState);
	} catch (e) {
		console.error('Failed to read Liked Songs state:', e);
	}
}

// --- Playlists panel ---

let playlistRowEls = {}; // playlistId -> row element, rebuilt whenever playlistsCache changes

async function refreshPlaylistsAndContainment(accessToken) {
	const now = Date.now();
	if (!playlistsCache || now - playlistsCacheAt > PLAYLISTS_CACHE_MS) {
		let fetched;
		try {
			fetched = await SpotifyApi.getAllPlaylists(accessToken);
		} catch (e) {
			showToast('Couldn’t load playlists: ' + (e.message || e));
			return;
		}

		// Best-effort only — the playlist list must still render even if this fails,
		// just without ownership info yet (isEditable defaults to true below, so a
		// row simply behaves as it did before ownership checks existed until this
		// succeeds on a later refresh).
		if (!currentUserId) {
			try {
				const me = await SpotifyApi.getCurrentUser(accessToken);
				currentUserId = me.id;
			} catch (e) {
				console.error('Failed to read current Spotify user:', e);
			}
		}

		fetched.forEach(function (p) {
			// Spotify returns 403 if you try to add/remove tracks on a playlist you
			// don't own and isn't marked collaborative — only those are editable here.
			p.isEditable = currentUserId
				? !!(p.collaborative || (p.owner && p.owner.id === currentUserId))
				: true;
		});
		fetched.sort(function (a, b) {
			return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
		});
		playlistsCache = fetched;
		playlistsCacheAt = now;
		renderPlaylistsList();
	}

	checkContainmentForCurrentTrack(accessToken);
}

// Full rebuild — only called when the playlist set itself changes (new fetch),
// not on every containment check result, so an in-progress tap never lands on a
// row that's about to be torn down and rebuilt out from under it.
function renderPlaylistsList() {
	const list = document.getElementById('playlistsList');
	list.innerHTML = '';
	playlistRowEls = {};
	if (!playlistsCache) return;

	playlistsCache.forEach(function (playlist) {
		const row = document.createElement('div');
		row.className = 'playlist-row';
		row.dataset.playlistId = playlist.id;
		row.classList.toggle('is-readonly', !playlist.isEditable);

		const name = document.createElement('div');
		name.className = 'playlist-name';
		name.textContent = playlist.name;

		const check = document.createElement('div');
		check.className = 'playlist-check';

		row.appendChild(name);
		row.appendChild(check);
		row.addEventListener('click', function () {
			if (!playlist.isEditable) {
				showToast('Can’t edit “' + playlist.name + '” — you don’t own it.');
				return;
			}
			togglePlaylistMembership(playlist.id);
		});
		list.appendChild(row);

		playlistRowEls[playlist.id] = row;
		updatePlaylistRowUI(playlist.id);
	});
}

// Updates one row in place from containmentState — never rebuilds the list, so it
// can run freely (once per playlist as containment checks resolve) without ever
// stealing an in-flight tap on another row.
function updatePlaylistRowUI(playlistId) {
	const row = playlistRowEls[playlistId];
	if (!row) return;
	const member = containmentState[playlistId];
	row.classList.toggle('is-member', member === true);
	row.classList.toggle('is-checking', member === 'checking');
	row.querySelector('.playlist-check').innerHTML = member === 'checking'
		? '<div class="mini-spinner"></div>'
		: '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
}

async function checkContainmentForCurrentTrack(accessToken) {
	if (!currentTrack || !playlistsCache) return;
	const trackUri = currentTrack.uri;
	const trackId = currentTrack.id;

	playlistsCache.forEach(function (p) {
		containmentState[p.id] = 'checking';
		updatePlaylistRowUI(p.id);
	});

	let firstError = null;
	let index = 0;
	async function worker() {
		while (index < playlistsCache.length) {
			const playlist = playlistsCache[index++];
			try {
				const contains = await SpotifyApi.playlistContainsTrack(accessToken, playlist.id, trackUri);
				if (!currentTrack || currentTrack.id !== trackId) return; // track changed mid-flight
				containmentState[playlist.id] = contains;
			} catch (e) {
				if (!currentTrack || currentTrack.id !== trackId) return;
				containmentState[playlist.id] = false;
				if (!firstError) firstError = e;
			}
			updatePlaylistRowUI(playlist.id);

			// Small stagger between requests so a large playlist library doesn't burst
			// the whole sweep at once and trip Spotify's rate limit.
			if (index < playlistsCache.length) {
				await new Promise(function (resolve) { setTimeout(resolve, CONTAINMENT_STAGGER_MS); });
			}
		}
	}

	const workers = [];
	for (let i = 0; i < CONTAINMENT_CONCURRENCY; i++) workers.push(worker());
	await Promise.all(workers);

	if (firstError) {
		showToast('Playlist check failed: ' + (firstError.message || firstError));
	}
}

async function togglePlaylistMembership(playlistId) {
	if (!currentTrack) return;
	const trackId = currentTrack.id;
	const trackUri = currentTrack.uri;
	const wasMember = containmentState[playlistId] === true;

	containmentState[playlistId] = !wasMember;
	updatePlaylistRowUI(playlistId);

	withAccessToken(async function (accessToken) {
		try {
			if (wasMember) {
				await SpotifyApi.removeTrackFromPlaylist(accessToken, playlistId, trackUri);
			} else {
				await SpotifyApi.addTrackToPlaylist(accessToken, playlistId, trackUri);
			}
		} catch (e) {
			showToast('Couldn’t update playlist: ' + (e.message || e));
			if (currentTrack && currentTrack.id === trackId) {
				containmentState[playlistId] = wasMember;
				updatePlaylistRowUI(playlistId);
			}
		}
	});
}

// --- Lifecycle ---

function onIcueDataUpdated() {
	applyStyles();
	checkAuthCodeChanged();

	const clientId = getIcueProperty('spotifyClientId');
	if (!pollTimer && clientId && SpotifyAuth.isConnected()) {
		startPolling();
	} else if (!clientId && !SpotifyAuth.isConnected()) {
		showState('disconnected');
	}
}

let hasInitialized = false;
function onIcueInitialized() {
	// Both this module's own boot-retry loop and iCUE's own callback invocation can
	// end up calling this — guard so wirePlaybackControls() (and its click listeners)
	// never gets attached twice, which otherwise fires every button's handler twice
	// per tap (e.g. play/pause flipping state forward then immediately back).
	if (hasInitialized) return;
	hasInitialized = true;

	applyStyles();
	wirePlaybackControls();

	// Seed with whatever is already sitting in the field (e.g. a code pasted in a
	// previous session, already consumed) so we only react to a genuinely new paste
	// going forward — authorization codes are single-use and a stale one would just
	// fail. See README for the full connect flow.
	lastSeenAuthCode = getIcueProperty('spotifyAuthCode') || '';

	if (SpotifyAuth.isConnected()) {
		startPolling();
	} else {
		showState('disconnected');
	}
}

// iCUE API binding — bare assignment is intentional, see references/lifecycle-and-plugins.md
icueEvents = {
	onDataUpdated: onIcueDataUpdated,
	onICUEInitialized: onIcueInitialized
};

var bootAttempts = 0, BOOT_RETRY_MS = 100, BOOT_RETRY_MAX = 15;
function bootCheck() {
	if (typeof iCUE_initialized !== 'undefined' && iCUE_initialized) { onIcueInitialized(); return; }
	if (bootAttempts < BOOT_RETRY_MAX) { bootAttempts++; setTimeout(bootCheck, BOOT_RETRY_MS); return; }
	onIcueInitialized(); // plain-browser fallback for local development
}
bootCheck();
