import ky, { Hooks } from "ky";
import ObsidianGoogleDrive from "main";
import { Notice } from "obsidian";
import { checkConnection } from "./drive";
import { refreshWithGoogle } from "./oauth";

const getHooks = (t: ObsidianGoogleDrive): Hooks => ({
	beforeRequest: [
		async (request) => {
			if (
				!t.accessToken.token ||
				t.accessToken.expiresAt - Date.now() < 60000
			) {
				await refreshAccessToken(t);
			}

			if (t.accessToken.token) {
				request.headers.set("Authorization", `Bearer ${t.accessToken.token}`);
			}
			return request;
		},
	],
	afterResponse: [
		async (request, options, response) => {
			if (!response.ok) {
				new Notice(`Error: ${await response.text()}`);
				return new Response();
			}
			return response;
		},
	],
});

export const getDriveKy = (t: ObsidianGoogleDrive) => {
	return ky.extend({
		prefixUrl: "https://www.googleapis.com",
		hooks: getHooks(t),
		timeout: 120_000,
	});
};

export const refreshAccessToken = async (t: ObsidianGoogleDrive) => {
	if (!t.settings.oauthClientId) {
		new Notice(
			"Google OAuth client ID is not configured. Set it in plugin settings before syncing.",
			0
		);
		return;
	}

	if (!t.settings.refreshToken) {
		new Notice(
			"No Google refresh token found. Reconnect your Google account in plugin settings.",
			0
		);
		return;
	}

	try {
		const tokens = await refreshWithGoogle({
			clientId: t.settings.oauthClientId,
			refreshToken: t.settings.refreshToken,
			clientSecret: t.settings.oauthClientSecret?.trim() || undefined,
		});

		t.accessToken = {
			token: tokens.accessToken,
			expiresAt: Date.now() + tokens.expiresIn * 1000,
		};

		t.settings.accessToken = t.accessToken.token;
		t.settings.accessTokenExpiresAt = t.accessToken.expiresAt;
		await t.saveSettings();
		return t.accessToken;
	} catch (e: any) {
		if (!(await checkConnection())) {
			return new Notice(
				"Something is wrong with your internet connection, so we could not fetch a new access token. Once you're back online, try syncing again.",
				0
			);
		}

		t.settings.refreshToken = "";
		t.settings.accessToken = "";
		t.settings.accessTokenExpiresAt = 0;
		t.accessToken = {
			token: "",
			expiresAt: 0,
		};

		new Notice(
			"Google OAuth refresh failed. Reconnect your Google account in plugin settings.",
			0
		);
		await t.saveSettings();
		return;
	}
};
