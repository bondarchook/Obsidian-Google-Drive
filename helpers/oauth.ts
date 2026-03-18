import { requestUrl } from "obsidian";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export const OAUTH_SCOPE = "https://www.googleapis.com/auth/drive";

export interface OAuthPending {
	state: string;
	codeVerifier: string;
	issuedAt: number;
}

export interface OAuthTokens {
	accessToken: string;
	refreshToken?: string;
	expiresIn: number;
	tokenType: string;
	scope?: string;
}

const bytesToBase64Url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");

const randomBase64Url = (bytes = 32) => {
	const random = new Uint8Array(bytes);
	crypto.getRandomValues(random);
	return bytesToBase64Url(random);
};

const sha256Base64Url = async (value: string) => {
	const encoded = new TextEncoder().encode(value);
	const hash = await crypto.subtle.digest("SHA-256", encoded);
	return bytesToBase64Url(new Uint8Array(hash));
};

export const createOAuthPending = async (): Promise<OAuthPending> => {
	const codeVerifier = randomBase64Url(64);
	return {
		state: randomBase64Url(32),
		codeVerifier,
		issuedAt: Date.now(),
	};
};

export const buildAuthorizationUrl = async ({
	clientId,
	redirectUri,
	pending,
}: {
	clientId: string;
	redirectUri: string;
	pending: OAuthPending;
}) => {
	const codeChallenge = await sha256Base64Url(pending.codeVerifier);
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: OAUTH_SCOPE,
		state: pending.state,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		access_type: "offline",
		prompt: "consent",
		include_granted_scopes: "true",
	});
	return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
};

const exchangeToken = async (
	payload: Record<string, string>
): Promise<OAuthTokens> => {
	const result = await requestUrl({
		url: GOOGLE_TOKEN_ENDPOINT,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams(payload).toString(),
		throw: false,
	});

	if (result.status >= 400) {
		throw new Error(result.text || `OAuth token request failed (${result.status}).`);
	}

	return {
		accessToken: result.json.access_token,
		refreshToken: result.json.refresh_token,
		expiresIn: Number(result.json.expires_in || 0),
		tokenType: result.json.token_type,
		scope: result.json.scope,
	};
};

export const exchangeAuthorizationCode = async ({
	clientId,
	redirectUri,
	code,
	codeVerifier,
}: {
	clientId: string;
	redirectUri: string;
	code: string;
	codeVerifier: string;
}) =>
	exchangeToken({
		client_id: clientId,
		redirect_uri: redirectUri,
		grant_type: "authorization_code",
		code,
		code_verifier: codeVerifier,
	});

export const refreshWithGoogle = async ({
	clientId,
	refreshToken,
}: {
	clientId: string;
	refreshToken: string;
}) =>
	exchangeToken({
		client_id: clientId,
		refresh_token: refreshToken,
		grant_type: "refresh_token",
	});

export const parseOAuthCallbackInput = (input: string) => {
	const trimmed = input.trim();
	if (!trimmed) {
		return {} as Record<string, string>;
	}

	if (trimmed.includes("://") || trimmed.includes("?")) {
		const url = new URL(trimmed);
		return Object.fromEntries(url.searchParams.entries());
	}

	return { code: trimmed };
};
