# GitHub Actions Online Processing

This project can run the Himawari fire-processing pipeline on GitHub Actions and publish the latest result bundle through GitHub Pages.

## What Gets Added

- Workflow: `.github/workflows/fire-monitor-cloud.yml`
- CI config generator: `fire_monitor/scripts/write-github-actions-config.mjs`
- Local pull example: `fire_monitor/.pull-cloud-results.github-pages.example.json`

## How It Works

1. GitHub Actions starts every 5 minutes, or you trigger it manually.
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
