# Himawari fire validation

The evaluator performs object-level one-to-one spatiotemporal matching between Himawari candidates and accepted NASA FIRMS VIIRS/MODIS active-fire observations.

Reference pixels are first grouped into fire-event clusters so that a large fire containing many VIIRS pixels does not artificially inflate the recall denominator.

Outputs:

- `public/data/algorithm/evaluation/himawari_vs_firms_latest.json`
- `public/data/algorithm/evaluation/himawari_vs_firms_matches.geojson`

Run with:

```bash
npm run evaluate:himawari-fire
```

Metrics are reported for multiple time windows. A window without accepted reference detections is marked `no_reference_detections` and does not report zero-valued metrics.

FIRMS fire-point CSV files do not contain a complete overpass footprint or cloud-obscuration mask. Therefore unmatched Himawari candidates are labelled apparent false positives, not confirmed false alarms. Operational accuracy should be reported only after adding reference swath/cloud coverage or field-confirmed fire reports.
