# Starlink Tracker

Watch ~4,000 Starlink satellites move in real time on an interactive 3D globe. Built with Next.js and the SpaceX API.

![Dark globe with satellites orbiting Earth]

---

## What it does

Pulls live TLE (Two-Line Element) data from SpaceX — the standard format for describing a satellite's orbit — runs SGP4 propagation in the browser, and renders everything on a canvas. You can spin the globe, zoom in, filter by orbital shell, click a satellite to see its trajectory, and crank the simulation up to 1000x speed.

The SpaceX API sometimes takes 5–15 seconds to respond on first load — that's normal.

## Stack

- **Next.js 16** — App Router, server-side data fetching
- **satellite.js** — SGP4 orbit propagation
- **topojson-client** — country borders on the globe
- **Once UI** — component library / theming
- **HTML5 Canvas** — all the rendering

## Running it

```bash
npm install
npm run dev
```

Open [localhost:3000](http://localhost:3000).

## Controls

| Action | How |
|--------|-----|
| Rotate globe | Click + drag |
| Pan | Right click + drag |
| Zoom | Scroll wheel |
| Select satellite | Click on a dot |
| Toggle orbital shell | Click the shell filter |
| Simulation speed | Pause / 1x / 100x / 1000x |

## Orbital shells

Satellites are color-coded by inclination:

- **~53°** — mid-latitude coverage
- **~70°** — high-latitude coverage
- **~97°** — polar orbit, covers everything including the poles

## Data

Live from the [SpaceX API](https://api.spacexdata.com/v4/starlink/query). Cached for 5 minutes so you're not hammering it on every refresh.
