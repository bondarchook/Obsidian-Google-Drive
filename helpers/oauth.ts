import { requestUrl } from "obsidian";

const GOOGLE_DEVICE_ENDPOINT = "https://oauth2.googleapis.com/device/code";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export const OAUTH_SCOPE = "https://www.googleapis.com/auth/drive";

export interface OAuthTokens {
	accessToken: string;
	refreshToken?: string;
	expiresIn: number;
	tokenType: string;
	scope?: string;
}

export interface DeviceAuthorizationResponse {
	deviceCode: string;
	userCode: string;
	verificationUrl: string;
	verificationUrlComplete?: string;
	expiresIn: number;
	interval: number;
}

export type DeviceAuthorizationError =
	| "authorization_pending"
	| "slow_down"
	| "access_denied"
	| "expired_token"
	| "unknown";

export class DeviceAuthorizationPollingError extends Error {
	code: DeviceAuthorizationError;

	constructor(code: DeviceAuthorizationError, message: string) {
		super(message);
		this.code = code;
	}
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => window.setTimeout(resolve, ms));

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

export const startDeviceAuthorization = async ({
	clientId,
	scope = OAUTH_SCOPE,
}: {
	clientId: string;
	scope?: string;
}) =>
	requestUrl({
		url: GOOGLE_DEVICE_ENDPOINT,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams({
			client_id: clientId,
			scope,
		}).toString(),
		throw: false,
	}).then((result) => {
		if (result.status >= 400) {
			throw new Error(
				result.text || `Device authorization failed (${result.status}).`
			);
		}

		return {
			deviceCode: result.json.device_code,
			userCode: result.json.user_code,
			verificationUrl: result.json.verification_url,
			verificationUrlComplete: result.json.verification_url_complete,
			expiresIn: Number(result.json.expires_in || 0),
			interval: Number(result.json.interval || 5),
		} as DeviceAuthorizationResponse;
	});

const exchangeDeviceCode = async ({
	clientId,
	deviceCode,
}: {
	clientId: string;
	deviceCode: string;
}) =>
	requestUrl({
		url: GOOGLE_TOKEN_ENDPOINT,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams({
				client_id: clientId,
			device_code: deviceCode,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		}).toString(),
		throw: false,
	});

export const pollDeviceAuthorization = async ({
	clientId,
	deviceCode,
	interval,
	expiresIn,
	isCancelled,
}: {
	clientId: string;
	deviceCode: string;
	interval: number;
	expiresIn: number;
	isCancelled?: () => boolean;
}) => {
	const startedAt = Date.now();
	let pollIntervalMs = interval * 1000;

	while (Date.now() - startedAt < expiresIn * 1000) {
		if (isCancelled?.()) {
			throw new DeviceAuthorizationPollingError(
				"unknown",
				"Device authorization canceled by user."
			);
		}

		const result = await exchangeDeviceCode({ clientId, deviceCode });
		if (result.status < 400) {
			return {
				accessToken: result.json.access_token,
				refreshToken: result.json.refresh_token,
				expiresIn: Number(result.json.expires_in || 0),
				tokenType: result.json.token_type,
				scope: result.json.scope,
			} as OAuthTokens;
		}

		const code =
			typeof result.json?.error === "string"
				? (result.json.error as DeviceAuthorizationError)
				: "unknown";

		if (code === "authorization_pending") {
			await sleep(pollIntervalMs);
			continue;
		}

		if (code === "slow_down") {
			pollIntervalMs += 5000;
			await sleep(pollIntervalMs);
			continue;
		}

		if (code === "access_denied") {
			throw new DeviceAuthorizationPollingError(
				"access_denied",
				"Google sign-in was denied by the user."
			);
		}

		if (code === "expired_token") {
			throw new DeviceAuthorizationPollingError(
				"expired_token",
				"Device authorization session expired."
			);
		}

		throw new DeviceAuthorizationPollingError(
			"unknown",
			result.text || "Device authorization failed."
		);
	}

	throw new DeviceAuthorizationPollingError(
		"expired_token",
		"Device authorization timed out."
	);
};
