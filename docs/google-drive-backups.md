# Google Drive Backup Setup

TeXHarbor uses Google’s server-side OAuth authorization-code flow with offline access. Google Drive is optional: PostgreSQL remains authoritative, and projects continue working when Drive is disconnected.

## 1. Confirm the Public URL

Choose the exact HTTPS origin users open in their browser. For the current deployment:

```text
https://latex-vm.tail84d91b.ts.net
```

The OAuth redirect URI is therefore:

```text
https://latex-vm.tail84d91b.ts.net/api/cloud/google/callback
```

The scheme, hostname, port, path, and trailing slash must match exactly. Production installations should use a stable domain controlled by the operator.

## 2. Create or Select a Google Cloud Project

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Select an existing project or create a dedicated project such as `texharbor-production`.
3. Open **APIs & Services → Library**.
4. Search for **Google Drive API**, open it, and click **Enable**.

Use separate Google Cloud projects for development and production when practical.

## 3. Configure the Google Auth Platform

Open **Google Auth Platform → Branding**. If prompted, click **Get started**, then configure:

- App name: `TeXHarbor`
- User support email: an actively monitored address
- Developer contact email: an actively monitored address
- Home page and privacy policy: required before public verification

Open **Audience** and select one option:

- **External / Testing:** suitable for initial setup. Add every Google account that will test backups under **Test users**. Testing is limited to 100 users and grants can expire after seven days.
- **Internal:** only for users in the same Google Workspace organization.
- **External / In production:** appropriate for long-lived public use. Google may require brand and sensitive-scope verification.

Open **Data Access → Add or remove scopes** and add only:

```text
https://www.googleapis.com/auth/drive.file
```

Do not add the broader `drive` scope. `drive.file` lets TeXHarbor access only files and folders it creates or that the user explicitly opens with the app.

## 4. Create the OAuth Client

1. Open **Google Auth Platform → Clients**.
2. Click **Create client**.
3. Select **Web application**.
4. Name it `TeXHarbor Web`.
5. Under **Authorized redirect URIs**, add:

   ```text
   https://latex-vm.tail84d91b.ts.net/api/cloud/google/callback
   ```

6. Click **Create** and copy the client ID and client secret.

TeXHarbor uses a server callback, so the callback belongs under **Authorized redirect URIs**, not **Authorized JavaScript origins**.

## 5. Configure TeXHarbor

Edit the repository’s untracked `.env` file:

```env
PUBLIC_ORIGIN=https://latex-vm.tail84d91b.ts.net
GOOGLE_CLIENT_ID=123456789-example.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-example
```

Keep `SESSION_SECRET` stable. TeXHarbor derives the encryption key for stored refresh tokens from it; changing it invalidates existing cloud connections. Never commit `.env` or paste credentials into browser code, logs, issues, or chat.

Recreate only the application container so Compose reloads the environment:

```bash
sudo docker-compose up -d --no-deps --force-recreate app
sudo docker-compose ps
curl -f http://127.0.0.1:3000/api/health
```

For Docker installations with the Compose plugin, replace `docker-compose` with `docker compose`.

Confirm both variables reached the container without printing their values:

```bash
sudo docker-compose exec -T app sh -c \
  'test -n "$GOOGLE_CLIENT_ID" && test -n "$GOOGLE_CLIENT_SECRET" && echo "Google OAuth variables loaded"'
```

## 6. Connect and Test

1. Open TeXHarbor and sign in with a TeXHarbor account.
2. Select **Cloud backup** in the dashboard sidebar.
3. Click **Connect Google Drive**.
4. Select an allowed Google account and approve the requested Drive permission.
5. Confirm that the browser returns to TeXHarbor and the dialog shows the connected account.
6. Select a project and click **Back up now**.
7. Open Google Drive and confirm that **TeXHarbor Backups** contains a `.texharbor.zip` file.
8. Change a project file and create another backup. Clicking again without changes should report that no new backup is needed.
9. Test restoration on a non-critical project: choose an older backup, click **Restore**, confirm the warning, then reopen the project and verify its files.

Restoration is owner-only, verifies project identity and file hashes, disconnects active collaboration sessions, and creates a local safety checkpoint before replacing project state.

## Troubleshooting

### “Google Drive is not configured”

The variables were not loaded. Recheck `.env`, recreate the `app` container, and run the non-printing variable check above.

### `redirect_uri_mismatch`

Compare the URI displayed by Google with the authorized redirect URI character for character. Confirm `PUBLIC_ORIGIN` uses the browser-visible HTTPS origin and has no path.

### `access_denied` or the account cannot continue

For an External app in Testing, add the Google account under **Audience → Test users**. A Google Workspace administrator may also block unapproved third-party apps.

### The unverified-app warning appears

This is expected while an External app is in Testing or awaiting verification. Use only explicitly trusted test accounts, or complete Google’s production verification process.

### Backups stop working after several days

Testing-mode authorizations can expire after seven days. Reconnect Drive for testing, or move the properly configured application to production and complete any required verification.

### “Authorization expired; reconnect Google Drive”

The user revoked access, the refresh token expired, or the encryption secret changed. Disconnect and reconnect Drive. If Google does not issue offline access, remove TeXHarbor under the Google Account’s third-party access settings and connect again.

### Inspect application errors safely

```bash
sudo docker-compose logs --tail=200 app
```

TeXHarbor does not intentionally log OAuth tokens. Do not add token logging while troubleshooting.

## Production Checklist

- Use a stable HTTPS domain and exact redirect URI.
- Keep `SESSION_SECRET` and the OAuth client secret backed up securely.
- Publish accurate branding, support, home-page, and privacy-policy information.
- Complete Google verification when required for the selected audience and scope.
- Retain PostgreSQL and project-storage backups; Drive is a secondary recovery layer.
- Perform periodic backup and restore drills with a non-critical project.

Official references: [Drive API setup](https://developers.google.com/workspace/drive/api/quickstart/js), [OAuth for web-server applications](https://developers.google.com/identity/protocols/oauth2/web-server), [OAuth audience configuration](https://support.google.com/cloud/answer/15549945), and [sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).
