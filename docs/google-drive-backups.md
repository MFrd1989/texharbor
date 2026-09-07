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

- **External / Testing:** suitable for initial setup. Add every Google account that will test backups under **Test users**. Testing is limited to 100 users, and TeXHarbor's refresh-token grants expire after seven days.
- **Internal:** only for users in the same Google Workspace organization.
- **External / In production:** appropriate for long-lived public use. Google may require basic app and branding verification; `drive.file` itself is a non-sensitive Drive scope.

Open **Data Access → Add or remove scopes** and add only:

```text
https://www.googleapis.com/auth/drive.file
```

Do not add the broader `drive` scope. `drive.file` lets TeXHarbor access only files and folders it creates or that the user explicitly opens with the app.

Test users must be added on the **Audience** page of the same Google Cloud project that owns the deployed OAuth client. Adding an account under **IAM & Admin** does not make it an OAuth test user. You can identify the active project by the number before the first hyphen in `GOOGLE_CLIENT_ID`; for example, client ID `123456789-example.apps.googleusercontent.com` belongs to project number `123456789`.

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

Recreate only the stateless application container so Compose reloads the environment. This explicit stop/remove/create sequence is compatible with the legacy `docker-compose` 1.29.2 installed on the current server and does not touch the database, worker, or named volumes:

```bash
sudo docker-compose stop app
sudo docker-compose rm -f app
sudo docker-compose up -d --no-deps --no-build app
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
2. Select **Versions** in the dashboard sidebar.
3. Save a local version to verify the local history first.
4. Click **Connect Google Drive**.
5. Select an allowed Google account and approve the requested Drive permission.
6. Confirm that the browser returns to TeXHarbor and the dialog shows the connected account.
7. Select a project and click **Save to Drive**.
8. Open Google Drive and confirm that **TeXHarbor Backups** contains a `.texharbor.zip` file.
9. Change a project file and create another version. Clicking the same destination again without changes should report that no new version is needed.
10. Test restoration on a non-critical project: choose an older local or Drive version, click **Restore**, confirm the warning, then reopen the project and verify its files.

## 7. Configure Scheduled Backups

Each owned project has its own schedule under **Versions → Scheduled backups**:

- **Destination:** local PostgreSQL storage, Google Drive, or both.
- **Frequency:** hourly, every 6 or 12 hours, daily, or weekly.
- **Retention:** 5 to 100 scheduled versions per destination.

Scheduled backups run in the API service and flush active collaborative documents before creating an archive. They are content-aware, so an unchanged project does not create a duplicate version. Retention removes only older scheduled versions; manual versions and automatic pre-restore safety checkpoints are never removed automatically. Google retention also deletes the corresponding file from Drive.

The schedule page reports the next run, last successful run, and the latest error. In Google OAuth Testing mode, refresh tokens expire after seven days, so Drive schedules will eventually report that the account must be reconnected. Use an appropriately published OAuth app for reliable long-running Drive schedules.

Restoration is owner-only, verifies project identity and file hashes, disconnects active collaboration sessions, and creates a local safety checkpoint before replacing project state.

## Troubleshooting

### “Google Drive is not configured”

The variables were not loaded. Recheck `.env`, recreate the `app` container, and run the non-printing variable check above.

### Legacy Compose reports `KeyError: 'ContainerConfig'`

Docker Compose 1.29.2 can fail while trying to inspect an existing container created from a newer Docker image. The project data is not damaged. Remove and recreate only the stateless app container:

```bash
sudo docker-compose stop app
sudo docker-compose rm -f app
sudo docker-compose up -d --no-deps --no-build app
curl -f http://127.0.0.1:3000/api/health
```

Never remove the `db` container or either named volume to resolve this error.

### `redirect_uri_mismatch`

Compare the URI displayed by Google with the authorized redirect URI character for character. Confirm `PUBLIC_ORIGIN` uses the browser-visible HTTPS origin and has no path.

### `access_denied` or the account cannot continue

For an External app in Testing, add the exact Google account under **Google Auth Platform → Audience → Test users**. Then verify all of the following:

1. Open the OAuth client used by TeXHarbor and note its client ID.
2. Confirm its numeric prefix matches the project number of the currently selected Cloud project.
3. Confirm the deployed `GOOGLE_CLIENT_ID` is that same client ID.
4. Add the account as an OAuth **Test user**, not as an IAM principal.
5. Save, allow time for Google’s settings to propagate, and retry in a private browser window with the exact account.

If Google reaches the consent screen and reports that only developer-approved testers may continue, the redirect URI and TeXHarbor callback have already been reached far enough to identify the client; a redirect problem instead reports `redirect_uri_mismatch`. A Google Workspace administrator may separately block unapproved third-party apps.

### The unverified-app warning appears

This is expected while an External app is in Testing or awaiting verification. Use only explicitly trusted test accounts, or complete Google’s production verification process.

### Drive backups or schedules stop working after several days

Testing-mode authorizations expire after seven days for TeXHarbor's Drive access. Reconnect Drive for testing, or move the properly configured application to production and complete any required verification.

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
- Choose a schedule and retention policy for each important project, and monitor the last-run status.
- Retain PostgreSQL and project-storage backups; Drive is a secondary recovery layer.
- Perform periodic backup and restore drills with a non-critical project.

Official references: [Drive API setup](https://developers.google.com/workspace/drive/api/quickstart/js), [OAuth for web-server applications](https://developers.google.com/identity/protocols/oauth2/web-server), [OAuth audience configuration](https://support.google.com/cloud/answer/15549945), and [sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).
