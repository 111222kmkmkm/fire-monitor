# Himawari Fire Detection Strict Paper Mode

Reference paper:

- ESSD manuscript: https://essd.copernicus.org/preprints/essd-2022-435/essd-2022-435-manuscript-version3.pdf

This project currently has two different states:

1. A working realtime fallback detector based on Himawari `B07/B13/B14`.
2. A strict-paper mode that is now wired to fail fast unless the paper-required inputs and implementation are complete.

## Why strict mode blocks execution

The referenced paper requires inputs and filters that the current realtime chain does not yet provide:

- Visible reflectance input (`Rvis`) for the candidate tests and daytime filtering.
- A non-vegetation mask for `Pv` in Eq. (9).
- A ground thermal source database for the static thermal source removal described in Section 3.3.3.

In addition, the current `detect_fire_pixels(...)` routine is still the project's heuristic fallback detector. It is not yet a full equation-by-equation implementation of the paper.

Because of that, `paperStrictMode: true` is intentionally configured to stop execution instead of emitting misleading fire points.

## What must be added before a real strict-paper run is possible

- Download or derive the visible reflectance band used by the paper.
- Add a China-ready non-vegetation mask aligned to the Himawari grid.
- Add a ground thermal source database aligned to the processing ROI.
- Replace the current heuristic detector with a full paper-faithful implementation.

Until those steps are complete, any result should be treated as a fallback engineering detector rather than a paper-faithful product.
