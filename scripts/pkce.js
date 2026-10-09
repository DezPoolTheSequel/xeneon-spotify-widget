// PKCE (Proof Key for Code Exchange) helpers for Spotify's Authorization Code flow.
// No client secret is used anywhere — the code verifier/challenge pair is what proves
// the token exchange request comes from the same app that started the login.

function pkceGenerateVerifier() {
	const bytes = new Uint8Array(64);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes).slice(0, 128);
}

async function pkceGenerateChallenge(verifier) {
	const data = new TextEncoder().encode(verifier);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkceGenerateState() {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}
