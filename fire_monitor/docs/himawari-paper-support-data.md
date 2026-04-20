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

The current template files are intentionally empty. Strict paper mode will still stop until they are replaced with real China support data.
