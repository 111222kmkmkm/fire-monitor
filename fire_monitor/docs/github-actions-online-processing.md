# GitHub Actions Online Processing

This project can run the Himawari fire-processing pipeline on GitHub Actions and publish the latest result bundle through GitHub Pages.

## What Gets Added

- Workflow: `.github/workflows/fire-monitor-cloud.yml`
- CI config generator: `fire_monitor/scripts/write-github-actions-config.mjs`
- Local pull example: `fire_monitor/.pull-cloud-results.github-pages.example.json`

## How It Works

1. GitHub Actions can be triggered manually, by an external scheduler, or by GitHub's own schedule trigger.
2. The workflow installs Node and Python dependencies.
3. It generates CI-only runtime config files:
   - `.sync.config.github.json`
   - `.process-himawari-fire.github.json`
   - `.cloud-pipeline.config.github.json`
4. It initializes `fire_monitor.geodatabase` on the runner.
5. It runs `scripts/cloud-pipeline.mjs --once`.
6. The pipeline publishes a small static bundle to `fire_monitor/cloud-build/pages`.
7. GitHub Pages serves that bundle.

The published Pages bundle contains:

- `manifest.json`
- `catalog.json`
- `algorithm/latest/candidate_fire.geojson`
- `algorithm/latest/candidate_fire_summary.json`

## One-Time GitHub Setup

### 1. Enable GitHub Actions

Make sure Actions are enabled for the repository.

### 2. Enable GitHub Pages

In the repository:

- `Settings`
- `Pages`
- Source: `GitHub Actions`

### 3. Optional Secrets

The workflow works without secrets for NOAA/AWS Himawari downloads.

If you want JAXA FTP fallback for Band 03, add these repository secrets:

- `JAXA_FTP_USER`
- `JAXA_FTP_PASSWORD`

If those secrets are absent, the workflow disables FTP fallback automatically.

## Trigger The First Cloud Run

1. Open the repository `Actions` tab.
2. Open `Fire Monitor Cloud Pipeline`.
3. Click `Run workflow`.

## Recommended Stable Trigger

If GitHub's built-in `schedule` trigger does not fire reliably for this repository, use an external scheduler to call the GitHub Actions dispatch API directly. This keeps the processing inside GitHub Actions, but removes dependency on GitHub's scheduled-run queue.

### Why This Works Better

- GitHub documents that `schedule` runs can be delayed and, during periods of high load, some queued jobs may be dropped.
- The workflow dispatch API triggers the same workflow directly, so the workflow still runs on `main`, still publishes to GitHub Pages, and your local app keeps pulling from the same `manifest.json`.

### One-Time Setup With cron-job.org

1. Create a fine-grained GitHub personal access token.
2. Limit the token to repository `111222kmkmkm/fire-monitor`.
3. Give it repository permission `Actions: Write`.
4. Save the token somewhere safe. You will use it only in cron-job.org.

GitHub API endpoint to trigger this workflow:

`https://api.github.com/repos/111222kmkmkm/fire-monitor/actions/workflows/fire-monitor-cloud.yml/dispatches`

Request settings for cron-job.org:

- Method: `POST`
- URL: `https://api.github.com/repos/111222kmkmkm/fire-monitor/actions/workflows/fire-monitor-cloud.yml/dispatches`
- Schedule: every 5 minutes
- Timeout: keep the default or set a higher timeout if you want response logging

Custom headers:

- `Accept: application/vnd.github+json`
- `Authorization: Bearer YOUR_GITHUB_TOKEN`
- `X-GitHub-Api-Version: 2022-11-28`
- `Content-Type: application/json`

Request body:

```json
{
  "ref": "main"
}
```

Expected result:

- GitHub returns HTTP `204 No Content`
- A new workflow run appears in `Actions`
- The workflow publishes a refreshed `manifest.json` and `catalog.json`

### Quick Manual Test

You can test the same trigger outside cron-job.org with:

```bash
curl -L \
  -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer YOUR_GITHUB_TOKEN" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/111222kmkmkm/fire-monitor/actions/workflows/fire-monitor-cloud.yml/dispatches \
  -d "{\"ref\":\"main\"}"
```

If that request returns `204`, the external trigger is configured correctly.

For this repository, the expected Pages URL is:

`https://111222kmkmkm.github.io/fire-monitor/`

The manifest URL will be:

`https://111222kmkmkm.github.io/fire-monitor/manifest.json`

## Pull Results Back To Local

Copy `fire_monitor/.pull-cloud-results.github-pages.example.json` to a local config file if you want your own copy. The example already points to:

```json
{
  "manifestUrl": "https://111222kmkmkm.github.io/fire-monitor/manifest.json",
  "targetRoot": "./public/data"
}
```

Then run:

```bash
npm run pull:cloud-results:once -- --config ./.pull-cloud-results.github-pages.example.json
```

If you want scheduled local pulls:

```bash
npm run pull:cloud-results -- --config ./.pull-cloud-results.github-pages.example.json
```

## Notes

- The runner is ephemeral, so the workflow recreates `fire_monitor.geodatabase` every run.
- Published bundles contain processed outputs, not your private local config.
- CI-generated config files are ignored by Git and stay local to the runner.
- GitHub documents that scheduled workflows can be delayed or dropped during high load, which is why external dispatch is the recommended production trigger for this repository.
