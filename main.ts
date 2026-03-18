import { checkConnection, getDriveClient } from "helpers/drive";
import { refreshAccessToken } from "helpers/ky";
import {
	buildAuthorizationUrl,
	createOAuthPending,
	exchangeAuthorizationCode,
	parseOAuthCallbackInput,
} from "helpers/oauth";
import { pull } from "helpers/pull";
import { push } from "helpers/push";
import { reset } from "helpers/reset";
import {
	App,
	debounce,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	Menu,
} from "obsidian";

interface PluginSettings {
	oauthClientId: string;
	oauthRedirectUri: string;
	accessToken: string;
	accessTokenExpiresAt: number;
	oauthState: string;
	oauthCodeVerifier: string;
	oauthStartedAt: number;
	refreshToken: string;
	operations: Record<string, "create" | "delete" | "modify">;
	driveIdToPath: Record<string, string>;
	lastSyncedAt: number;
	changesToken: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	oauthClientId: "",
	oauthRedirectUri: "obsidian://google-drive-sync-oauth",
	accessToken: "",
	accessTokenExpiresAt: 0,
	oauthState: "",
	oauthCodeVerifier: "",
	oauthStartedAt: 0,
	refreshToken: "",
	operations: {},
	driveIdToPath: {},
	lastSyncedAt: 0,
	changesToken: "",
};

export default class ObsidianGoogleDrive extends Plugin {
	settings: PluginSettings;
	accessToken = {
		token: "",
		expiresAt: 0,
	};
	drive = getDriveClient(this);
	ribbonIcon: HTMLElement;
	syncing: boolean;
	private static readonly OAUTH_ACTION = "google-drive-sync-oauth";

	async onload() {
		const { vault } = this.app;

		await this.loadSettings();
		this.registerObsidianProtocolHandler(
			ObsidianGoogleDrive.OAUTH_ACTION,
			(params) => {
				void this.completeOAuth(params);
			}
		);

		this.addSettingTab(new SettingsTab(this.app, this));

		if (this.settings.accessToken && this.settings.accessTokenExpiresAt > Date.now()) {
			this.accessToken = {
				token: this.settings.accessToken,
				expiresAt: this.settings.accessTokenExpiresAt,
			};
		}

		if (!this.settings.refreshToken) {
			new Notice(
				"Google Drive Sync is not connected yet. Open plugin settings and complete Google OAuth setup.",
				0
			);
			return;
		}

		this.ribbonIcon = this.addRibbonIcon(
			"refresh-cw",
			"Obsidian Google Drive",
			(event) => {
				if (this.syncing) return;
				const menu = new Menu();

				menu.addItem((item) =>
					item
						.setTitle("Pull from Drive")
						.setIcon("cloud-download")
						.onClick(() => {
							pull(this);
						})
				);

				menu.addItem((item) =>
					item
						.setTitle("Push to Drive")
						.setIcon("cloud-upload")
						.onClick(() => {
							push(this);
						})
				);
				menu.addItem((item) =>
					item
						.setTitle("Reset from Drive")
						.setIcon("triangle-alert")
						.onClick(() => {
							reset(this);
						})
				);
				menu.showAtMouseEvent(event);
			}
		);

		this.addCommand({
			id: "push",
			name: "Push to Google Drive",
			callback: () => push(this),
		});

		this.addCommand({
			id: "pull",
			name: "Pull from Google Drive",
			callback: () => pull(this),
		});

		this.addCommand({
			id: "reset",
			name: "Reset local vault to Google Drive",
			callback: () => reset(this),
		});

		this.registerEvent(
			this.app.workspace.on("quit", () => this.saveSettings())
		);

		this.app.workspace.onLayoutReady(() =>
			this.registerEvent(vault.on("create", this.handleCreate.bind(this)))
		);
		this.registerEvent(vault.on("delete", this.handleDelete.bind(this)));
		this.registerEvent(vault.on("modify", this.handleModify.bind(this)));
		this.registerEvent(vault.on("rename", this.handleRename.bind(this)));

		checkConnection().then(async (connected) => {
			if (connected) {
				this.syncing = true;
				this.ribbonIcon.addClass("spin");
				await pull(this, true);
				await this.endSync();
			}
		});
	}

	onunload() {
		return this.saveSettings();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);

		if (
			this.settings.oauthState &&
			Date.now() - this.settings.oauthStartedAt > 10 * 60 * 1000
		) {
			this.clearOAuthPending();
		}
	}

	saveSettings() {
		return this.saveData(this.settings);
	}

	debouncedSaveSettings = debounce(this.saveSettings.bind(this), 500, true);

	private clearOAuthPending() {
		this.settings.oauthState = "";
		this.settings.oauthCodeVerifier = "";
		this.settings.oauthStartedAt = 0;
	}

	private getOAuthPending() {
		if (!this.settings.oauthState || !this.settings.oauthCodeVerifier) {
			return;
		}

		return {
			state: this.settings.oauthState,
			codeVerifier: this.settings.oauthCodeVerifier,
			issuedAt: this.settings.oauthStartedAt,
		};
	}

	private isVaultReadyForInitialSync() {
		if (this.settings.changesToken) {
			return true;
		}

		const hasLocalFiles =
			this.app.vault
				.getAllLoadedFiles()
				.filter(({ path }) => path !== "/").length > 0;

		if (hasLocalFiles) {
			new Notice(
				"Your current vault is not empty. Clear the vault before first-time Google Drive onboarding, or reconnect from an already-synced vault.",
				0
			);
			return false;
		}

		return true;
	}

	async startOAuthFlow() {
		if (!this.settings.oauthClientId.trim()) {
			new Notice("Set a Google OAuth client ID in plugin settings first.", 0);
			return;
		}

		if (!this.isVaultReadyForInitialSync()) {
			return;
		}

		const pending = await createOAuthPending();
		this.settings.oauthState = pending.state;
		this.settings.oauthCodeVerifier = pending.codeVerifier;
		this.settings.oauthStartedAt = pending.issuedAt;
		await this.saveSettings();

		const url = await buildAuthorizationUrl({
			clientId: this.settings.oauthClientId.trim(),
			redirectUri: this.settings.oauthRedirectUri.trim(),
			pending,
		});

		window.open(url, "_blank", "noopener");
		new Notice(
			"Browser opened for Google sign-in. If Obsidian does not return automatically, paste the full callback URL in plugin settings.",
			0
		);
	}

	async completeOAuthFromInput(input: string) {
		const params = parseOAuthCallbackInput(input);
		await this.completeOAuth(params);
	}

	async completeOAuth(params: Record<string, string | "true">) {
		if (typeof params.error === "string") {
			new Notice(`Google OAuth error: ${params.error}`, 0);
			this.clearOAuthPending();
			await this.saveSettings();
			return;
		}

		const code = typeof params.code === "string" ? params.code : "";
		if (!code) {
			new Notice("Missing OAuth code in callback.", 0);
			return;
		}

		const pending = this.getOAuthPending();
		if (!pending) {
			new Notice(
				"OAuth session was not found. Start 'Connect Google Account' again.",
				0
			);
			return;
		}

		const incomingState =
			typeof params.state === "string" ? params.state : "";
		if (incomingState && incomingState !== pending.state) {
			new Notice("OAuth state mismatch. Please retry sign-in.", 0);
			this.clearOAuthPending();
			await this.saveSettings();
			return;
		}

		try {
			const tokens = await exchangeAuthorizationCode({
				clientId: this.settings.oauthClientId.trim(),
				redirectUri: this.settings.oauthRedirectUri.trim(),
				code,
				codeVerifier: pending.codeVerifier,
			});

			if (!tokens.refreshToken && !this.settings.refreshToken) {
				new Notice(
					"OAuth succeeded but no refresh token was returned. Revoke app access in your Google account and try connecting again.",
					0
				);
				return;
			}

			this.settings.refreshToken = tokens.refreshToken || this.settings.refreshToken;
			this.settings.accessToken = tokens.accessToken;
			this.settings.accessTokenExpiresAt =
				Date.now() + tokens.expiresIn * 1000;
			this.accessToken = {
				token: this.settings.accessToken,
				expiresAt: this.settings.accessTokenExpiresAt,
			};

			if (!this.settings.changesToken) {
				const changesToken = await this.drive.getChangesStartToken();
				if (!changesToken) {
					new Notice("Connected, but failed to fetch Drive changes token.", 0);
					return;
				}
				this.settings.changesToken = changesToken;
			}

			this.clearOAuthPending();
			await this.saveSettings();
			new Notice(
				"Google account connected. Reload Obsidian to activate full sync events and ribbon actions.",
				0
			);
		} catch (error) {
			new Notice("Google OAuth code exchange failed. Please try again.", 0);
		}
	}

	async disconnectOAuth() {
		this.clearOAuthPending();
		this.settings.refreshToken = "";
		this.settings.accessToken = "";
		this.settings.accessTokenExpiresAt = 0;
		this.accessToken = {
			token: "",
			expiresAt: 0,
		};
		await this.saveSettings();
		new Notice("Google account disconnected from this plugin.");
	}

	handleCreate(file: TAbstractFile) {
		if (this.settings.operations[file.path] === "delete") {
			if (file instanceof TFile) {
				this.settings.operations[file.path] = "modify";
			} else {
				delete this.settings.operations[file.path];
			}
		} else {
			this.settings.operations[file.path] = "create";
		}
		this.debouncedSaveSettings();
	}

	handleDelete(file: TAbstractFile) {
		if (this.settings.operations[file.path] === "create") {
			delete this.settings.operations[file.path];
		} else {
			this.settings.operations[file.path] = "delete";
		}
		this.debouncedSaveSettings();
	}

	handleModify(file: TFile) {
		const operation = this.settings.operations[file.path];
		if (operation === "create" || operation === "modify") {
			return;
		}
		this.settings.operations[file.path] = "modify";
		this.debouncedSaveSettings();
	}

	handleRename(file: TAbstractFile, oldPath: string) {
		this.handleDelete({ ...file, path: oldPath });
		this.handleCreate(file);
		this.debouncedSaveSettings();
	}

	async createFolder(path: string) {
		const oldOperation = this.settings.operations[path];
		await this.app.vault.createFolder(path);
		this.settings.operations[path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[path];
	}

	async createFile(
		path: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[path];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.createBinary(path, content, {
			mtime: modificationDate,
		});
		this.settings.operations[path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[path];
	}

	async modifyFile(
		file: TFile,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[file.path];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.modifyBinary(file, content, {
			mtime: modificationDate,
		});
		this.settings.operations[file.path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[file.path];
	}

	async upsertFile(
		file: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[file];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.adapter.writeBinary(file, content, {
			mtime: modificationDate,
		});
		this.settings.operations[file] = oldOperation;
		if (!oldOperation) delete this.settings.operations[file];
	}

	async deleteFile(file: TAbstractFile) {
		const oldOperation = this.settings.operations[file.path];
		await this.app.fileManager.trashFile(file);
		delete this.settings.operations[file.path];
		if (!oldOperation) delete this.settings.operations[file.path];
	}

	async startSync() {
		if (!(await checkConnection())) {
			throw new Notice(
				"You are not connected to the internet, so you cannot sync right now. Please try syncing once you have connection again."
			);
		}
		this.ribbonIcon.addClass("spin");
		this.syncing = true;
		return new Notice("Syncing (0%)", 0);
	}

	async endSync(syncNotice?: Notice, retainConfigChanges = true) {
		if (retainConfigChanges) {
			const configFilesToSync = await this.drive.getConfigFilesToSync();

			this.settings.lastSyncedAt = Date.now();

			await Promise.all(
				configFilesToSync.map(async (file) =>
					this.app.vault.adapter.writeBinary(
						file,
						await this.app.vault.adapter.readBinary(file),
						{ mtime: Date.now() }
					)
				)
			);
		} else {
			this.settings.lastSyncedAt = Date.now();
		}

		const changesToken = await this.drive.getChangesStartToken();
		if (!changesToken) {
			return new Notice(
				"An error occurred fetching Google Drive changes token."
			);
		}
		this.settings.changesToken = changesToken;
		await this.saveSettings();
		this.ribbonIcon.removeClass("spin");
		this.syncing = false;
		syncNotice?.hide();
	}
}

class SettingsTab extends PluginSettingTab {
	plugin: ObsidianGoogleDrive;

	constructor(app: App, plugin: ObsidianGoogleDrive) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h3", { text: "Google OAuth" });

		new Setting(containerEl)
			.setName("OAuth client ID")
			.setDesc(
				"Google OAuth client ID for this plugin. Use an app/client configured for Obsidian protocol redirects."
			)
			.addText((text) => {
				text
					.setPlaceholder("Enter Google OAuth client ID")
					.setValue(this.plugin.settings.oauthClientId)
					.onChange((value) => {
						this.plugin.settings.oauthClientId = value.trim();
						this.plugin.debouncedSaveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Redirect URI")
			.setDesc(
				"Obsidian callback URI. Keep default unless you have a custom protocol setup."
			)
			.addText((text) => {
				text
					.setPlaceholder("obsidian://google-drive-sync-oauth")
					.setValue(this.plugin.settings.oauthRedirectUri)
					.onChange((value) => {
						this.plugin.settings.oauthRedirectUri = value.trim();
						this.plugin.debouncedSaveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Account")
			.setDesc(
				this.plugin.settings.refreshToken
					? "Connected"
					: "Not connected"
			)
			.addButton((button) =>
				button.setButtonText("Connect Google Account").onClick(async () => {
					await this.plugin.startOAuthFlow();
				})
			)
			.addButton((button) =>
				button.setButtonText("Disconnect").onClick(async () => {
					await this.plugin.disconnectOAuth();
					this.display();
				})
			);

		let callbackInput = "";
		new Setting(containerEl)
			.setName("Manual callback URL or code")
			.setDesc(
				"Fallback for Android/desktop if callback does not auto-return to Obsidian. Paste the full callback URL or just the code."
			)
			.addText((text) => {
				text
					.setPlaceholder("obsidian://google-drive-sync-oauth?code=...")
					.onChange((value) => {
						callbackInput = value;
					});
			})
			.addButton((button) =>
				button.setButtonText("Complete OAuth").onClick(async () => {
					await this.plugin.completeOAuthFromInput(callbackInput);
					this.display();
				})
			);

		containerEl.createEl("p", {
			text: "After connecting, reload Obsidian if sync ribbon/actions are not visible yet.",
		});
	}
}
