# [ GLOBE ] — UNNAMED · V0

Geo-social music discovery — a monochrome orthographic globe of what's playing right now, everywhere.

Drag to rotate. Tap a dot to open the neighbourhood card. Share a link to drop your own pin.

## Stack

- Vite + React 19
- D3 (`geoOrthographic`, `geoPath`, inline TopoJSON decoder)
- IBM Plex Mono / Sans, ASCII-architectural editorial palette

## Run

```sh
npm install
npm run dev
```

## Design

Flat off-white `#F0EBDF` background, rust `#B0411E` reserved for live pulses and hover states only. Covers are procedurally generated glyphs — a djb2 hash of `artist|track` picks one of 12 geometric compositions. No raster art, no images — everything renders from primitives.
