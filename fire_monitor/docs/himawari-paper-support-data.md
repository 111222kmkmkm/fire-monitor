# Himawari Paper Support Data

Strict paper mode expects two China-focused support datasets:

## 1. Non-vegetation mask

Path:

- `public/data/support/china_non_vegetation_mask.geojson`

Accepted formats:

- `GeoJSON` polygons or multipolygons
- `NPY/NPZ` boolean raster aligned to the processing grid

The mask should cover non-vegetation surfaces used for `Pv` in Eq. (9), such as:

- deserts
- bare land
- rocky land
- large built-up impervious surfaces if your production standard treats them as non-vegetated background

## 2. Static thermal source database

Path:

- `public/data/support/china_static_thermal_sources.geojson`

Accepted formats:

- `GeoJSON` points, multipoints, polygons, multipolygons
- `CSV` with `lon/lat` or `longitude/latitude`

Optional point properties:

- `radiusKm`

This dataset should include known stable thermal interference sources, such as:

- industrial furnaces
- steel plants
- petrochemical flare facilities
- power plants
- other persistent non-fire heat sources

The current repository contains a small engineering seed dataset only. It is sufficient for exercising the processing chain, but it is not comparable to the nationwide, annually updated interference database used by Chen et al. (2023). Production accuracy assessment must therefore report the auxiliary-data version and coverage instead of inheriting the paper's published accuracy.

## Extended photovoltaic and thermal-candidate data

- `china_photovoltaic_facilities.geojson`
  - 1,318 China solar facilities from WRI Global Power Plant Database v1.3.0.
  - Registry coordinates and capacity are retained for provenance.
  - A conservative `0.25–2.5 km` influence radius is derived from capacity.
- `china_persistent_thermal_candidates.geojson`
  - Seven-day NOAA-20 VIIRS spatial clusters detected on at least four distinct days.
  - These entries have `autoReject: false`; imagery or infrastructure verification is required before promotion to the automatic interference database.
- `fire_interference_data_summary.json`
  - Records source versions, counts and construction criteria.

Rebuild with:

```bash
npm run build:fire-interference-data
```
