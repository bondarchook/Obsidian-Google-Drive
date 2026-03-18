# OAuth Refactor Plan (No Implementation)

## Goal
Replace the current hosted-token flow (https://ogd.richardxiong.com) with a first-party Google OAuth flow in the plugin, using browser-based sign-in that works on both Windows and Android.

## Current State Summary
- Hosted auth dependency is currently used for token exchange and connectivity checks.
- Existing plugin settings store only a refresh token and expect the user to paste it manually.
- Key touchpoints:
  - `helpers/ky.ts`: refresh token -> access token via hosted endpoint.
  - `helpers/drive.ts`: internet check via hosted ping endpoint.
  - `main.ts`: settings UI links users to hosted website and asks for pasted refresh token.
  - `README.md`: setup depends on hosted sign-in page.

## Target Architecture
Implement OAuth 2.0 Authorization Code + PKCE directly in-plugin, without any custom backend.

### Core OAuth Flow
1. User clicks `Connect Google Account` in plugin settings.
2. Plugin generates and stores temporary PKCE state:
   - `code_verifier`
   - `code_challenge` (S256)
   - `state`
   - `issuedAt`
3. Plugin opens browser to Google authorization URL.
4. User signs in and consents.
5. Browser redirects back to Obsidian using plugin callback route.
6. Plugin validates `state`, exchanges `code` directly with Google token endpoint.
7. Plugin stores tokens and enables sync.

## Cross-Platform Callback Strategy (Windows + Android)
Use an Obsidian protocol callback as primary strategy.

### Primary
- Register plugin callback handler using Obsidian protocol support.
- Use a redirect URI compatible with both desktop and mobile Obsidian deep links.
- Browser returns auth code directly into plugin handler.

### Fallback
- If protocol callback is unavailable on a platform/version, provide a manual one-time paste flow:
  - Browser lands on Google redirect page with auth code.
  - User pastes code into plugin dialog.
  - Plugin continues token exchange.

### Decision Gate
Before coding, verify exact Obsidian protocol handler API behavior and callback URL format on:
- Windows desktop Obsidian
- Android Obsidian app

If callback format differs by platform, normalize in one parser utility.

## Planned Code Changes

### 1. Token Model and Settings
Update settings model to support OAuth lifecycle:
- Add fields:
  - `refreshToken`
  - `accessToken`
  - `accessTokenExpiresAt`
  - `oauthPending` (state + verifier + timestamp)
  - Optional: `connectedAccountEmail` (if fetched)
- Add migration logic for existing settings shape.

### 2. New OAuth Helper Module
Create `helpers/oauth.ts` with:
- PKCE utilities (verifier/challenge/state generation).
- Authorization URL builder.
- Callback parser + state validator.
- Code exchange (`authorization_code`) against Google token endpoint.
- Refresh flow (`refresh_token`) against Google token endpoint.

### 3. Replace Hosted Exchange in HTTP Layer
Refactor `helpers/ky.ts`:
- Remove hosted endpoint call.
- Refresh access token directly against Google OAuth endpoint.
- Keep automatic refresh in request hooks.
- Improve error handling for:
  - revoked consent
  - expired/invalid refresh token
  - missing refresh token

### 4. Replace Hosted Connectivity Check
Refactor `helpers/drive.ts`:
- Remove hosted ping URL.
- Replace with a neutral connectivity strategy:
  - either lightweight Google endpoint check
  - or optimistic request strategy with explicit network error handling

### 5. Settings UI and UX Refactor
Refactor settings section in `main.ts`:
- Remove `Get refresh token` external website link.
- Remove manual refresh-token-first onboarding.
- Add buttons/actions:
  - `Connect Google Account`
  - `Reconnect`
  - `Disconnect`
- Add status text:
  - connected/disconnected
  - token validity state
- Add callback completion notices and actionable errors.

### 6. Startup and Sync Guards
Adjust plugin startup behavior:
- If no valid token state, do not start pull/push automatically.
- Prompt user to connect account.
- Preserve existing sync state machine when connected.

### 7. Documentation and Metadata
Update docs and public metadata:
- `README.md` setup instructions for in-plugin OAuth.
- Remove statements that mention hosted token conversion/ping dependency.
- Review `manifest.json` and wording to ensure auth path is accurately described.

## Security and Privacy Requirements
- No client secret embedded in plugin.
- PKCE required for authorization code flow.
- Strict state validation to prevent CSRF.
- Clear pending OAuth state after success/failure/timeout.
- Avoid logging tokens or auth codes.
- Store only minimum token state needed for operation.

## Backward Compatibility and Migration
- Existing users with valid saved refresh token continue to work.
- On first token refresh failure due to revocation, require reconnect instead of silent failure.
- Do not remove legacy fields until migration confirms success.

## Testing Plan

### Functional
- Fresh install auth flow on Windows.
- Fresh install auth flow on Android.
- Reconnect flow after disconnect.
- Token refresh after expiry.
- Startup behavior when offline.

### Failure Cases
- User cancels consent.
- State mismatch.
- Callback not received.
- Invalid/revoked refresh token.
- Network timeout during exchange/refresh.

### Regression
- Pull, push, and reset still work post-auth change.
- Existing vault operations tracking unaffected.

## Rollout Steps
1. Implement callback plumbing and OAuth helper first.
2. Swap token refresh path.
3. Replace settings UI and onboarding.
4. Remove hosted dependencies and docs references.
5. Run cross-platform manual QA matrix.
6. Ship with clear release notes about new sign-in flow.

## Acceptance Criteria
- No runtime dependency on https://ogd.richardxiong.com for auth or connectivity.
- User can connect account entirely in-plugin using browser OAuth on Windows and Android.
- Access token refresh works without manual copy/paste after initial consent.
- Auth errors are user-actionable and do not corrupt sync state.
- README setup steps reflect only the new OAuth flow.

---

## Phase 2 Plan: Switch To Google Device Authorization Flow

## Why Phase 2 Is Required
- Google OAuth redirect URI policies reject custom scheme redirects like `obsidian://...` for this client configuration.
- Device Authorization flow avoids redirect URI entirely and is designed for apps with limited browser callback control.
- This is the most reliable path for both Windows and Android in Obsidian.

## Phase 2 Goal
Replace the current authorization-code callback flow with Google OAuth Device Authorization flow, while preserving the direct Google token refresh path already implemented.

## Target Flow (Device Code)
1. User clicks `Connect Google Account`.
2. Plugin requests a device code from Google's device authorization endpoint.
3. Plugin shows:
   - `user_code`
   - `verification_url`
   - optional `verification_url_complete`
   - expiration countdown
4. Plugin opens browser to verification URL.
5. User signs in and approves scopes on any browser.
6. Plugin polls token endpoint at provider-specified interval.
7. On success, plugin stores refresh/access token and enables sync.

## API Endpoints (Google)
- Device authorization endpoint: `https://oauth2.googleapis.com/device/code`
- Token endpoint: `https://oauth2.googleapis.com/token`

## Planned Code Changes (Phase 2)

### 1. OAuth Helper Rewrite
Refactor [helpers/oauth.ts](helpers/oauth.ts) to:
- Remove PKCE/callback-state logic.
- Add `startDeviceAuthorization(clientId, scope)`.
- Add `pollDeviceAuthorization({ clientId, deviceCode, interval, expiresIn })`.
- Handle polling statuses:
  - `authorization_pending`
  - `slow_down`
  - `access_denied`
  - `expired_token`

### 2. Main Plugin Auth Flow Update
Refactor [main.ts](main.ts):
- Remove protocol callback dependency for auth completion.
- Replace `completeOAuth` callback path with polling lifecycle.
- Add connect UI states:
  - idle
  - waiting_for_user_approval
  - polling
  - success
  - canceled/expired/error
- Add `Cancel Sign-In` action to stop polling cleanly.

### 3. Settings Model Migration
Update settings in [main.ts](main.ts):
- Remove no-longer-needed fields after migration window:
  - `oauthRedirectUri`
  - `oauthState`
  - `oauthCodeVerifier`
  - `oauthStartedAt`
- Add transient runtime state (not persisted long-term) for in-progress device flow.
- Keep persisted:
  - `oauthClientId`
  - `refreshToken`
  - `accessToken`
  - `accessTokenExpiresAt`

### 4. Token Refresh Layer
Keep [helpers/ky.ts](helpers/ky.ts) direct Google refresh flow.
- Validate compatibility with tokens issued by device flow.
- Keep reconnect behavior for revoked tokens.

### 5. UX and Copy
Update settings UI and notices in [main.ts](main.ts):
- Replace callback URL instructions with device-code instructions.
- Display clear step-by-step in plugin UI:
  1. open link
  2. enter code
  3. wait for approval
- Provide explicit timeout and retry messaging.

### 6. Documentation
Update [README.md](README.md):
- Replace redirect/callback setup instructions.
- Add device-code onboarding flow for Windows and Android.
- Document required Google OAuth client type for device flow.

## Google Console Setup Requirements (Phase 2)
- Use OAuth client type that supports Device Authorization flow.
- No redirect URI configuration required.
- Add test users if app is in testing mode.
- Keep Drive API enabled and consent screen configured.

## Error Handling Requirements
- Network offline during polling: retry with backoff and user notice.
- `slow_down`: increase poll interval per provider guidance.
- `access_denied`: stop immediately and show actionable message.
- `expired_token`: end flow and prompt user to restart connect.
- Polling timeout: stop without corrupting existing token state.

## Security Requirements (Phase 2)
- No client secret embedded.
- Do not log `device_code`, refresh token, or access token.
- Clear in-progress auth state after completion/cancel/timeout.
- Persist only required token fields.

## Testing Plan (Phase 2)

### Functional
- New connect flow on Windows desktop.
- New connect flow on Android.
- Reconnect after disconnect.
- Token refresh after access token expiry.

### Failure Cases
- User never approves (timeout).
- User denies consent.
- Polling rate-limit (`slow_down`).
- Internet loss mid-poll.

### Regression
- Pull, push, reset unaffected by auth flow change.
- Existing users with valid refresh tokens continue syncing.

## Rollout Plan (Phase 2)
1. Implement device-code helper APIs.
2. Switch settings UI and auth state machine in plugin.
3. Remove callback-only auth code paths.
4. Update docs and setup instructions.
5. Validate on Windows and Android with manual QA checklist.
6. Release with migration notes.

## Phase 2 Acceptance Criteria
- No redirect URI is required for user onboarding.
- Auth setup works on Windows and Android with a single documented flow.
- User can complete sign-in even when Obsidian protocol callbacks are unavailable.
- Token refresh and sync behavior remain stable after migration.
