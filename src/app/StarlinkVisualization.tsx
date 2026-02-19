'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Column, Row, Heading, Text, Grid } from '@once-ui-system/core';
import * as satellite from 'satellite.js';
// @ts-ignore
import * as topojson from 'topojson-client';
import worldAtlas from 'world-atlas/countries-110m.json';
import styles from './Tracker.module.scss';

interface SatelliteData {
  satrec: any;
  name: string;
  inc: number;
  group: string;
  color: { r: number; g: number; b: number };
  // Pre-built rgba strings to avoid per-frame string interpolation
  colorDot: string;
  colorGlow: string;
}

// Pre-computed world map geometry (lon/lat → 3D XYZ on unit sphere, scaled to EARTH_R)
interface PrecomputedRing {
  coords3D: Float32Array; // interleaved x,y,z
}

export default function StarlinkVisualization() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [loadingText, setLoadingText] = useState('Loading satellite data...');
  const [loadingSub, setLoadingSub] = useState('Fetching from SpaceX API');
  const [stats, setStats] = useState({
    total: 0,
    tle: 0,
    visible: 0,
  });
  const [inclinationGroups, setInclinationGroups] = useState<Array<{
    range: string;
    minInc: number;
    maxInc: number;
    count: number;
    color: { r: number; g: number; b: number };
    enabled: boolean;
  }>>([]);
  const [speed, setSpeed] = useState(1);
  const [autoRotate, setAutoRotate] = useState(false);
  const [showAllTrajectories, setShowAllTrajectories] = useState(false);
  const [trajectoryMinutes, setTrajectoryMinutes] = useState(270); // 3 orbits default

  const satellitesRef = useRef<SatelliteData[]>([]);
  // Pre-computed world geometry (computed once on load)
  const precomputedRingsRef = useRef<PrecomputedRing[]>([]);
  const timeOffsetRef = useRef(0);
  const pausedTimeRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef(0);
  const isDraggingRef = useRef(false);
  const isRightDraggingRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const dragRotRef = useRef({ x: -0.25, y: 0.44 });
  const panOffsetRef = useRef({ x: 0, y: 0 });
  const autoRotateAngleRef = useRef(0);
  const autoRotateRef = useRef(false);
  const speedRef = useRef(1);
  const frameCountRef = useRef(0);
  const lastSatUpdateRef = useRef(0);
  const cachedSatPositionsRef = useRef<any[]>([]);
  const zoomRef = useRef(1);
  const mouseCanvasRef = useRef({ x: -1000, y: -1000 });
  const hoveredSatRef = useRef<{ name: string; x: number; y: number } | null>(null);
  const selectedSatRef = useRef<{ name: string; satrec: any; color: { r: number; g: number; b: number } } | null>(null);
  const showAllTrajectoriesRef = useRef(false);
  const trajectoryMinutesRef = useRef(270);
  const inclinationGroupsRef = useRef<Array<{
    range: string;
    minInc: number;
    maxInc: number;
    count: number;
    color: { r: number; g: number; b: number };
    enabled: boolean;
  }>>([]);

  // ── Cached gradient/draw state (invalidated when cx/cy/zoom changes) ──
  const lastGradientStateRef = useRef({ cx: -1, cy: -1, zoom: -1 });
  const cachedAtmoGradRef = useRef<CanvasGradient | null>(null);
  const cachedEarthGradRef = useRef<CanvasGradient | null>(null);

  // ── Pre-computed star positions (computed once, never changes) ──
  const starCacheRef = useRef<Array<{ px: number; py: number; alpha: string }> | null>(null);
  // Star positions are relative to [0,1] so they need canvas size
  const lastStarSizeRef = useRef({ w: -1, h: -1 });

  // ── Trajectory validity cache: satrec → { valid, lastChecked } ──
  const trajValidCacheRef = useRef<Map<any, { valid: boolean; ts: number }>>(new Map());

  const EARTH_R = 210;

  // Group inclinations into 10-degree buckets
  const getInclinationBucket = (inc: number) => {
    return Math.floor(inc / 10) * 10;
  };

  // Generate color for inclination group - using same color schema as reference
  const getColorForInclination = (bucket: number) => {
    if (bucket >= 50 && bucket < 60) {
      return { r: 99, g: 102, b: 241 };
    } else if (bucket >= 60 && bucket < 80) {
      return { r: 52, g: 211, b: 153 };
    } else if (bucket >= 90) {
      return { r: 251, g: 146, b: 60 };
    } else {
      if (bucket < 50) {
        return { r: 59, g: 130, b: 246 };
      } else if (bucket >= 80 && bucket < 90) {
        return { r: 163, g: 230, b: 53 };
      } else {
        return { r: 34, g: 211, b: 238 };
      }
    }
  };

  const loadWorldMap = async () => {
    try {
      const geo = topojson.feature(worldAtlas as any, (worldAtlas as any).objects.countries);
      const rings: PrecomputedRing[] = [];

      for (const feature of geo.features) {
        const geom = feature.geometry;
        const rawRings: number[][][] =
          geom.type === 'Polygon'
            ? geom.coordinates
            : geom.type === 'MultiPolygon'
            ? geom.coordinates.flat()
            : [];

        for (const ring of rawRings) {
          // Pre-compute the interpolated 3D coords once, store as flat Float32Array
          const coords3DList: number[] = [];

          for (let i = 0; i < ring.length; i++) {
            const [lon1, lat1] = ring[i];
            const [lon2, lat2] = ring[(i + 1) % ring.length];

            const [x1, y1, z1] = geoToXYZ(lon1, lat1, EARTH_R * 0.998);
            const [x2, y2, z2] = geoToXYZ(lon2, lat2, EARTH_R * 0.998);

            const len1 = Math.sqrt(x1 * x1 + y1 * y1 + z1 * z1);
            const len2 = Math.sqrt(x2 * x2 + y2 * y2 + z2 * z2);
            const dot = (x1 * x2 + y1 * y2 + z1 * z2) / (len1 * len2);
            const angularDist = Math.acos(Math.max(-1, Math.min(1, dot)));

            coords3DList.push(x1, y1, z1);

            if (angularDist > 0.05) {
              const steps = Math.ceil(angularDist / 0.05);
              const sinAngle = Math.sin(angularDist);
              if (sinAngle > 0.001) {
                for (let s = 1; s < steps; s++) {
                  const t = s / steps;
                  const a = Math.sin((1 - t) * angularDist) / sinAngle;
                  const b = Math.sin(t * angularDist) / sinAngle;
                  coords3DList.push(
                    a * x1 + b * x2,
                    a * y1 + b * y2,
                    a * z1 + b * z2
                  );
                }
              }
            }
          }

          rings.push({ coords3D: new Float32Array(coords3DList) });
        }
      }

      precomputedRingsRef.current = rings;
    } catch (e) {
      console.error('Map load failed:', e);
    }
  };

  const loadStarlink = async () => {
    try {
      setLoadingText('Fetching satellite data...');
      setLoadingSub('Querying SpaceX API (5-15 sec)');

      const resp = await fetch('/api/starlink');
      const data = await resp.json();
      const allDocs = data.docs || data;

      setLoadingText('Processing TLE data...');
      setLoadingSub(`${allDocs.length} satellites fetched`);

      let tleCount = 0;
      const inclinationBuckets = new Map<number, number>();

      satellitesRef.current = [];
      for (const sat of allDocs) {
        const st = sat.spaceTrack;
        if (!st || !st.TLE_LINE1 || !st.TLE_LINE2) continue;
        if (st.DECAYED === 1 || st.DECAY_DATE) continue;

        try {
          const satrec = satellite.twoline2satrec(st.TLE_LINE1, st.TLE_LINE2);
          if (satrec.error !== 0) continue;

          if (satrec.ecco && satrec.ecco > 0.01) continue;

          const testDate = new Date();
          const testPos = satellite.propagate(satrec, testDate);
          if (!testPos || !testPos.position) continue;

          const testTimes = [
            new Date(testDate.getTime()),
            new Date(testDate.getTime() + 10 * 60 * 1000),
            new Date(testDate.getTime() + 20 * 60 * 1000),
          ];

          let isValid = true;
          const testPositions = [];

          for (const time of testTimes) {
            const pos = satellite.propagate(satrec, time);
            if (!pos || !pos.position || typeof pos.position !== 'object') {
              isValid = false;
              break;
            }

            try {
              const gmst = satellite.gstime(time);
              const geo = satellite.eciToGeodetic(pos.position, gmst);
              const alt = geo.height;

              if (isNaN(alt) || alt < 200 || alt > 1000) {
                isValid = false;
                break;
              }

              testPositions.push(alt);
            } catch (e) {
              isValid = false;
              break;
            }
          }

          if (isValid && testPositions.length === 3) {
            const maxAlt = Math.max(...testPositions);
            const minAlt = Math.min(...testPositions);
            if (maxAlt - minAlt > 50) {
              isValid = false;
            }
          }

          if (!isValid) continue;

          const inc = st.INCLINATION || 0;
          const bucket = getInclinationBucket(inc);
          inclinationBuckets.set(bucket, (inclinationBuckets.get(bucket) || 0) + 1);
          tleCount++;

          const color = getColorForInclination(bucket);
          satellitesRef.current.push({
            satrec,
            name: st.OBJECT_NAME || 'Unknown',
            inc,
            group: bucket.toString(),
            color,
            // Pre-build color strings once
            colorDot: `rgba(${color.r},${color.g},${color.b},0.8)`,
            colorGlow: `rgba(${color.r},${color.g},${color.b},0.15)`,
          });
        } catch (e) {
          // skip bad TLE
        }
      }

      const groups = Array.from(inclinationBuckets.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([bucket, count]) => ({
          range: `${bucket}-${bucket + 10}°`,
          minInc: bucket,
          maxInc: bucket + 10,
          count,
          color: getColorForInclination(bucket),
          enabled: true,
        }));

      setStats({
        total: allDocs.length,
        tle: tleCount,
        visible: 0,
      });
      setInclinationGroups(groups);

      setLoadingText(`${tleCount} satellites ready!`);
      setLoadingSub('Starting visualization...');

      setTimeout(() => setLoading(false), 800);
    } catch (e) {
      console.error('API error:', e);
      setLoadingText('API Error');
      setLoadingSub('Could not fetch data. Retrying...');
      setTimeout(loadStarlink, 3000);
    }
  };

  // Update speedRef when speed changes
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  // Update autoRotateRef when autoRotate changes
  useEffect(() => {
    autoRotateRef.current = autoRotate;
  }, [autoRotate]);

  // Update inclinationGroupsRef when inclinationGroups changes
  useEffect(() => {
    inclinationGroupsRef.current = inclinationGroups;
  }, [inclinationGroups]);

  // Update trajectory refs when they change
  useEffect(() => {
    showAllTrajectoriesRef.current = showAllTrajectories;
  }, [showAllTrajectories]);

  useEffect(() => {
    trajectoryMinutesRef.current = trajectoryMinutes;
  }, [trajectoryMinutes]);

  useEffect(() => {
    Promise.all([loadWorldMap(), loadStarlink()]);
  }, []);

  // Handle canvas resize to match display size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(dpr, dpr);
      }

      // Invalidate cached gradients and stars on resize
      lastGradientStateRef.current = { cx: -1, cy: -1, zoom: -1 };
      lastStarSizeRef.current = { w: -1, h: -1 };
    };

    resizeCanvas();

    const resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
    };
  }, [loading]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || loading) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const mouseDownPosRef = { x: 0, y: 0 };

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 2) {
        isRightDraggingRef.current = true;
      } else {
        isDraggingRef.current = true;
      }
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      mouseDownPosRef.x = e.clientX;
      mouseDownPosRef.y = e.clientY;
    };

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    const handleCanvasMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseCanvasRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingRef.current) {
        dragRotRef.current.x += (e.clientX - lastMouseRef.current.x) * 0.008;
        dragRotRef.current.y += (e.clientY - lastMouseRef.current.y) * 0.008;
        dragRotRef.current.y = Math.max(-1.4, Math.min(1.4, dragRotRef.current.y));
        lastMouseRef.current = { x: e.clientX, y: e.clientY };
      } else if (isRightDraggingRef.current) {
        panOffsetRef.current.x += e.clientX - lastMouseRef.current.x;
        panOffsetRef.current.y += e.clientY - lastMouseRef.current.y;
        lastMouseRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    const handleClick = (e: MouseEvent) => {
      const dx = e.clientX - mouseDownPosRef.x;
      const dy = e.clientY - mouseDownPosRef.y;
      const wasDrag = Math.sqrt(dx * dx + dy * dy) > 4;

      if (hoveredSatRef.current) {
        const sat = satellitesRef.current.find(s => s.name === hoveredSatRef.current!.name);
        if (sat) {
          selectedSatRef.current = {
            name: sat.name,
            satrec: sat.satrec,
            color: sat.color,
          };
        }
      } else if (!wasDrag) {
        selectedSatRef.current = null;
      }
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      isRightDraggingRef.current = false;
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        isDraggingRef.current = true;
        lastMouseRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!isDraggingRef.current || e.touches.length !== 1) return;
      dragRotRef.current.x += (e.touches[0].clientX - lastMouseRef.current.x) * 0.008;
      dragRotRef.current.y += (e.touches[0].clientY - lastMouseRef.current.y) * 0.008;
      dragRotRef.current.y = Math.max(-1.4, Math.min(1.4, dragRotRef.current.y));
      lastMouseRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };

    const handleTouchEnd = () => {
      isDraggingRef.current = false;
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.92 : 1.08;
      zoomRef.current = Math.max(0.3, Math.min(20, zoomRef.current * factor));
      // Invalidate gradient cache on zoom
      lastGradientStateRef.current.zoom = -1;
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('contextmenu', handleContextMenu);
    canvas.addEventListener('mousemove', handleCanvasMouseMove);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('click', handleClick);
    canvas.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    window.addEventListener('touchend', handleTouchEnd);
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    const rotateY = (x: number, y: number, z: number, a: number) => {
      const c = Math.cos(a), s = Math.sin(a);
      return [x * c + z * s, y, -x * s + z * c];
    };

    const rotateX = (x: number, y: number, z: number, a: number) => {
      const c = Math.cos(a), s = Math.sin(a);
      return [x, y * c - z * s, y * s + z * c];
    };

    const project = (x: number, y: number, z: number, cx: number, cy: number, vr: number, vt: number, zoom: number) => {
      let [px, py, pz] = rotateY(x, y, z, vr);
      [px, py, pz] = rotateX(px, py, pz, vt);
      return { x: cx + px * zoom, y: cy - py * zoom, z: pz };
    };

    const getSatLatLonAlt = (satrec: any, date: Date, gmst: number) => {
      try {
        const posVel = satellite.propagate(satrec, date);
        if (!posVel || !posVel.position || typeof posVel.position !== 'object') return null;
        const geo = satellite.eciToGeodetic(posVel.position, gmst);
        return {
          lat: satellite.degreesLat(geo.latitude),
          lon: satellite.degreesLong(geo.longitude),
          alt: geo.height,
        };
      } catch (e) {
        return null;
      }
    };

    const draw = (now: number) => {
      const dt = now - lastFrameTimeRef.current;
      lastFrameTimeRef.current = now;

      const currentSpeed = speedRef.current;
      if (currentSpeed === 0) {
        if (pausedTimeRef.current === null) {
          pausedTimeRef.current = Date.now() + timeOffsetRef.current;
        }
        timeOffsetRef.current = pausedTimeRef.current - Date.now();
      } else {
        pausedTimeRef.current = null;
        if (currentSpeed > 0) {
          timeOffsetRef.current += dt * (currentSpeed - 1);
        }
      }

      const rect = canvas.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      const cx = W / 2 + panOffsetRef.current.x;
      const cy = H / 2 + panOffsetRef.current.y;
      const zoom = zoomRef.current;

      if (autoRotateRef.current && !isDraggingRef.current) {
        autoRotateAngleRef.current += 0.002;
      }
      const viewRot = dragRotRef.current.x + autoRotateAngleRef.current;
      const viewTilt = dragRotRef.current.y;

      ctx.clearRect(0, 0, W, H);

      // ── Background ──
      ctx.fillStyle = 'rgb(10, 10, 10)';
      ctx.fillRect(0, 0, W, H);

      // ── Stars (pre-compute when canvas size changes) ──
      const starCache = starCacheRef.current;
      if (!starCache || lastStarSizeRef.current.w !== W || lastStarSizeRef.current.h !== H) {
        const newStars = [];
        for (let i = 0; i < 100; i++) {
          newStars.push({
            px: (i * 7919 + 42) % W,
            py: (i * 6271 + 42) % H,
            alpha: `rgba(200,210,230,${(0.15 + (i % 5) * 0.08).toFixed(2)})`,
          });
        }
        starCacheRef.current = newStars;
        lastStarSizeRef.current = { w: W, h: H };

        for (const s of newStars) {
          ctx.fillStyle = s.alpha;
          ctx.fillRect(s.px, s.py, 1, 1);
        }
      } else {
        for (const s of starCache) {
          ctx.fillStyle = s.alpha;
          ctx.fillRect(s.px, s.py, 1, 1);
        }
      }

      const earthR = EARTH_R * zoom;

      // ── Cached gradients (rebuild only when cx/cy/zoom changes) ──
      const gs = lastGradientStateRef.current;
      if (gs.cx !== cx || gs.cy !== cy || gs.zoom !== zoom) {
        const glow = ctx.createRadialGradient(cx, cy, earthR - 5, cx, cy, earthR + 25);
        glow.addColorStop(0, 'rgba(56, 189, 248, 0.07)');
        glow.addColorStop(1, 'transparent');
        cachedAtmoGradRef.current = glow;

        const earthGrad = ctx.createRadialGradient(cx - 40 * zoom, cy - 40 * zoom, 10 * zoom, cx, cy, earthR);
        earthGrad.addColorStop(0, '#1e4976');
        earthGrad.addColorStop(0.7, '#122d4f');
        earthGrad.addColorStop(1, '#0a1a30');
        cachedEarthGradRef.current = earthGrad;

        lastGradientStateRef.current = { cx, cy, zoom };
      }

      // Atmosphere glow
      ctx.fillStyle = cachedAtmoGradRef.current!;
      ctx.beginPath();
      ctx.arc(cx, cy, earthR + 25, 0, Math.PI * 2);
      ctx.fill();

      // Earth
      ctx.fillStyle = cachedEarthGradRef.current!;
      ctx.beginPath();
      ctx.arc(cx, cy, earthR, 0, Math.PI * 2);
      ctx.fill();

      // ── Countries (using pre-computed 3D geometry) ──
      const cosVR = Math.cos(viewRot), sinVR = Math.sin(viewRot);
      const cosVT = Math.cos(viewTilt), sinVT = Math.sin(viewTilt);

      // Inline projection (avoids function call overhead in tight loop)
      const projectInline = (x: number, y: number, z: number) => {
        // rotateY
        const px = x * cosVR + z * sinVR;
        const py_r = y;
        const pz_r = -x * sinVR + z * cosVR;
        // rotateX
        const py2 = py_r * cosVT - pz_r * sinVT;
        const pz2 = py_r * sinVT + pz_r * cosVT;
        return { sx: cx + px * zoom, sy: cy - py2 * zoom, sz: pz2 };
      };

      for (const ring of precomputedRingsRef.current) {
        const c3d = ring.coords3D;
        const n = c3d.length / 3;

        // Project all points
        const projX = new Float32Array(n);
        const projY = new Float32Array(n);
        const projZ = new Float32Array(n);

        for (let i = 0; i < n; i++) {
          const i3 = i * 3;
          const { sx, sy, sz } = projectInline(c3d[i3], c3d[i3 + 1], c3d[i3 + 2]);
          projX[i] = sx;
          projY[i] = sy;
          projZ[i] = sz;
        }

        // ── Fill ──
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, earthR, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = 'rgba(34, 80, 60, 0.4)';

        type ClipPt = { x: number; y: number; isLimb: boolean };
        const clippedPath: ClipPt[] = [];

        const getEdgeIntersectionInline = (
          px1: number, py1: number, pz1: number,
          px2: number, py2: number, pz2: number,
          x1: number, y1: number, z1: number,
          x2: number, y2: number, z2: number
        ) => {
          const t = pz1 / (pz1 - pz2);
          const ix = x1 + t * (x2 - x1);
          const iy = y1 + t * (y2 - y1);
          const iz = z1 + t * (z2 - z1);
          const { sx, sy, sz } = projectInline(ix, iy, iz);
          return { x: sx, y: sy };
        };

        for (let i = 0; i < n; i++) {
          const ni = (i + 1) % n;
          const curZ = projZ[i], nextZ = projZ[ni];
          const curVisible = curZ > 0;
          const nextVisible = nextZ > 0;

          if (curVisible) {
            clippedPath.push({ x: projX[i], y: projY[i], isLimb: false });
            if (!nextVisible) {
              const ep = getEdgeIntersectionInline(
                projX[ni], projY[ni], projZ[ni],
                projX[i], projY[i], projZ[i],
                c3d[ni * 3], c3d[ni * 3 + 1], c3d[ni * 3 + 2],
                c3d[i * 3], c3d[i * 3 + 1], c3d[i * 3 + 2]
              );
              clippedPath.push({ x: ep.x, y: ep.y, isLimb: true });
            }
          } else {
            if (nextVisible) {
              const ep = getEdgeIntersectionInline(
                projX[i], projY[i], projZ[i],
                projX[ni], projY[ni], projZ[ni],
                c3d[i * 3], c3d[i * 3 + 1], c3d[i * 3 + 2],
                c3d[ni * 3], c3d[ni * 3 + 1], c3d[ni * 3 + 2]
              );
              clippedPath.push({ x: ep.x, y: ep.y, isLimb: true });
            }
          }
        }

        if (clippedPath.length > 2) {
          ctx.beginPath();
          ctx.moveTo(clippedPath[0].x, clippedPath[0].y);

          for (let j = 0; j < clippedPath.length; j++) {
            const cur = clippedPath[j];
            const nxt = clippedPath[(j + 1) % clippedPath.length];

            if (cur.isLimb && nxt.isLimb) {
              const startA = Math.atan2(cur.y - cy, cur.x - cx);
              const endA   = Math.atan2(nxt.y - cy, nxt.x - cx);
              let ccwSpan = endA - startA;
              if (ccwSpan < 0) ccwSpan += Math.PI * 2;
              const counterClockwise = ccwSpan > Math.PI;
              ctx.arc(cx, cy, earthR, startA, endA, counterClockwise);
            } else {
              ctx.lineTo(nxt.x, nxt.y);
            }
          }

          ctx.closePath();
          ctx.fill();
        }

        ctx.restore();

        // ── Borders ──
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const ni = (i + 1) % n;
          if (projZ[i] > 0 && projZ[ni] > 0) {
            const dx = projX[ni] - projX[i];
            const dy = projY[ni] - projY[i];
            const screenDist = Math.sqrt(dx * dx + dy * dy);

            const i3 = i * 3, ni3 = ni * 3;
            const d3x = c3d[ni3] - c3d[i3];
            const d3y = c3d[ni3 + 1] - c3d[i3 + 1];
            const d3z = c3d[ni3 + 2] - c3d[i3 + 2];
            const dist3D = Math.sqrt(d3x * d3x + d3y * d3y + d3z * d3z);

            if (screenDist < 15 * zoom && dist3D < 20) {
              if (!started) {
                ctx.moveTo(projX[i], projY[i]);
                started = true;
              }
              ctx.lineTo(projX[ni], projY[ni]);
            } else {
              started = false;
            }
          } else {
            started = false;
          }
        }
        ctx.strokeStyle = 'rgba(100, 200, 150, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // ── Satellites ──
      const simDate = new Date(Date.now() + timeOffsetRef.current);
      // Compute GMST once per frame (shared across all satellites)
      const gmst = satellite.gstime(simDate);
      const ORBIT_SCALE = EARTH_R / 6371;
      let visibleCount = 0;

      const enabledGroups = new Set(
        inclinationGroupsRef.current.filter(g => g.enabled).map(g => g.minInc.toString())
      );

      const updateInterval = isDraggingRef.current ? 50 : 16;
      let satPositions = cachedSatPositionsRef.current;

      if (now - lastSatUpdateRef.current > updateInterval || satPositions.length === 0) {
        lastSatUpdateRef.current = now;
        satPositions = [];

        for (let i = 0; i < satellitesRef.current.length; i++) {
          const sat = satellitesRef.current[i];
          if (!enabledGroups.has(sat.group)) continue;

          const pos = getSatLatLonAlt(sat.satrec, simDate, gmst);
          if (!pos || isNaN(pos.lat) || isNaN(pos.lon) || isNaN(pos.alt)) continue;

          if (pos.alt < 200 || pos.alt > 800) continue;

          const altPx = EARTH_R + pos.alt * ORBIT_SCALE * 0.8;
          const [x, y, z] = geoToXYZ(-pos.lon, pos.lat, altPx);
          satPositions.push({
            x, y, z,
            lat: pos.lat, lon: pos.lon, altPx,
            color: sat.color,
            colorDot: sat.colorDot,
            colorGlow: sat.colorGlow,
            name: sat.name,
            satrec: sat.satrec,
          });
        }

        cachedSatPositionsRef.current = satPositions;
      }

      // Project + compute rotated coords in one pass, storing occlusion result
      const nSats = satPositions.length;
      const satScreenX = new Float32Array(nSats);
      const satScreenY = new Float32Array(nSats);
      const satScreenZ = new Float32Array(nSats);
      const satOccluded = new Uint8Array(nSats); // 0=visible, 1=occluded

      for (let i = 0; i < nSats; i++) {
        const sat = satPositions[i];
        const { sx, sy, sz } = projectInline(sat.x, sat.y, sat.z);

        // Compute rotated coords for occlusion check
        const prx = sat.x * cosVR + sat.z * sinVR;
        const pry_r = sat.y;
        const prz_r = -sat.x * sinVR + sat.z * cosVR;
        const rx = prx;
        const ry = pry_r * cosVT - prz_r * sinVT;
        const rz = pry_r * sinVT + prz_r * cosVT;

        const distToAxis = Math.sqrt(rx * rx + ry * ry);
        let occ = false;
        if (distToAxis < EARTH_R) {
          const earthSurfaceZ = Math.sqrt(EARTH_R * EARTH_R - distToAxis * distToAxis);
          occ = rz < earthSurfaceZ;
        }

        satScreenX[i] = sx;
        satScreenY[i] = sy;
        satScreenZ[i] = sz;
        satOccluded[i] = occ ? 1 : 0;
      }

      // Sort indices by z (painter's algorithm)
      const sortOrder = Array.from({ length: nSats }, (_, i) => i);
      sortOrder.sort((a, b) => satScreenZ[a] - satScreenZ[b]);

      // Hover detection
      const mouseX = mouseCanvasRef.current.x;
      const mouseY = mouseCanvasRef.current.y;
      let closestSat: { name: string; x: number; y: number; dist: number } | null = null;

      for (let si = 0; si < nSats; si++) {
        const i = sortOrder[si];
        if (satOccluded[i]) continue;
        const dx = satScreenX[i] - mouseX;
        const dy = satScreenY[i] - mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 10 && (!closestSat || dist < closestSat.dist)) {
          closestSat = { name: satPositions[i].name, x: satScreenX[i], y: satScreenY[i], dist };
        }
      }
      hoveredSatRef.current = closestSat ? { name: closestSat.name, x: closestSat.x, y: closestSat.y } : null;

      // Render satellites
      for (let si = 0; si < nSats; si++) {
        const i = sortOrder[si];
        if (satOccluded[i]) continue;

        const sp = satPositions[i];
        const sx = satScreenX[i], sy = satScreenY[i];

        // Glow
        ctx.fillStyle = sp.colorGlow;
        ctx.beginPath();
        ctx.arc(sx, sy, 4, 0, Math.PI * 2);
        ctx.fill();

        // Dot
        ctx.fillStyle = sp.colorDot;
        ctx.beginPath();
        ctx.arc(sx, sy, 2, 0, Math.PI * 2);
        ctx.fill();

        visibleCount++;
      }

      // Update visible count every 30 frames
      frameCountRef.current++;
      if (frameCountRef.current % 30 === 0) {
        setStats((prev) => ({ ...prev, visible: visibleCount }));
      }

      // ── Trajectory validity check (cached, TTL 30s) ──
      const isTrajectoryValid = (satrec: any): boolean => {
        const cache = trajValidCacheRef.current;
        const cached = cache.get(satrec);
        if (cached && now - cached.ts < 30_000) return cached.valid;

        const testSteps = 10;
        const altitudes: number[] = [];
        const positions: Array<{ lat: number; lon: number; alt: number }> = [];

        for (let i = 0; i < testSteps; i++) {
          const testTime = new Date(simDate.getTime() + i * 5 * 60 * 1000);
          const tGmst = satellite.gstime(testTime);
          const pos = getSatLatLonAlt(satrec, testTime, tGmst);

          if (!pos || isNaN(pos.lat) || isNaN(pos.lon) || isNaN(pos.alt)) {
            cache.set(satrec, { valid: false, ts: now });
            return false;
          }

          if (pos.alt < 100 || pos.alt > 2000) {
            cache.set(satrec, { valid: false, ts: now });
            return false;
          }

          altitudes.push(pos.alt);
          positions.push(pos);
        }

        const maxAlt = Math.max(...altitudes);
        const minAlt = Math.min(...altitudes);
        if (maxAlt - minAlt > 100) {
          cache.set(satrec, { valid: false, ts: now });
          return false;
        }

        const velocities: number[] = [];
        for (let i = 1; i < positions.length; i++) {
          const pos1 = positions[i - 1];
          const pos2 = positions[i];
          const dLat = (pos2.lat - pos1.lat) * Math.PI / 180;
          const dLon = (pos2.lon - pos1.lon) * Math.PI / 180;
          const a = Math.sin(dLat / 2) ** 2 +
                    Math.cos(pos1.lat * Math.PI / 180) * Math.cos(pos2.lat * Math.PI / 180) *
                    Math.sin(dLon / 2) ** 2;
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          velocities.push((6371 + (pos1.alt + pos2.alt) / 2) * c);
        }

        const avgVel = velocities.reduce((a, b) => a + b, 0) / velocities.length;
        for (const vel of velocities) {
          if (Math.abs(vel - avgVel) / avgVel > 0.5) {
            cache.set(satrec, { valid: false, ts: now });
            return false;
          }
        }

        cache.set(satrec, { valid: true, ts: now });
        return true;
      };

      // ── Draw trajectory ──
      const drawTrajectory = (satrec: any, color: { r: number; g: number; b: number }, opacity: number = 0.6, lineWidth: number = 2) => {
        if (!isTrajectoryValid(satrec)) return;

        const minutes = trajectoryMinutesRef.current;
        const steps = Math.min(300, Math.max(50, Math.floor(minutes * 1.1)));

        const allPoints: Array<{ x: number; y: number; visible: boolean }> = [];
        for (let step = 0; step <= steps; step++) {
          const timeOffset = (step / steps) * minutes * 60 * 1000;
          const futureDate = new Date(simDate.getTime() + timeOffset);
          const fGmst = satellite.gstime(futureDate);
          const pos = getSatLatLonAlt(satrec, futureDate, fGmst);

          if (pos && !isNaN(pos.lat) && !isNaN(pos.lon) && !isNaN(pos.alt)) {
            const altPx = EARTH_R + pos.alt * ORBIT_SCALE * 0.8;
            const [x, y, z] = geoToXYZ(-pos.lon, pos.lat, altPx);

            const prx = x * cosVR + z * sinVR;
            const pry_r = y;
            const prz_r = -x * sinVR + z * cosVR;
            const rx = prx;
            const ry = pry_r * cosVT - prz_r * sinVT;
            const rz = pry_r * sinVT + prz_r * cosVT;

            const distToAxis = Math.sqrt(rx * rx + ry * ry);
            let visible = true;
            if (distToAxis < EARTH_R) {
              const earthSurfaceZ = Math.sqrt(EARTH_R * EARTH_R - distToAxis * distToAxis);
              if (rz < earthSurfaceZ) visible = false;
            }

            const { sx, sy } = projectInline(x, y, z);
            allPoints.push({ x: sx, y: sy, visible });
          }
        }

        ctx.strokeStyle = `rgba(${color.r},${color.g},${color.b},${opacity})`;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        let started = false;
        for (const p of allPoints) {
          if (p.visible) {
            if (!started) {
              ctx.moveTo(p.x, p.y);
              started = true;
            } else {
              ctx.lineTo(p.x, p.y);
            }
          } else {
            started = false;
          }
        }
        ctx.stroke();
      };

      // Draw trajectories
      if (showAllTrajectoriesRef.current) {
        for (const sat of satPositions) {
          drawTrajectory(sat.satrec, sat.color, 0.3, 1);
        }
      } else if (selectedSatRef.current) {
        const selected = selectedSatRef.current;
        drawTrajectory(selected.satrec, selected.color, 0.6, 2);
      }

      // ── Tooltip ──
      if (hoveredSatRef.current) {
        const hovered = hoveredSatRef.current;
        const padding = 8;
        const text = hovered.name;
        ctx.font = '12px sans-serif';
        const textWidth = ctx.measureText(text).width;
        const tooltipWidth = textWidth + padding * 2;
        const tooltipHeight = 24;

        let tooltipX = hovered.x - tooltipWidth / 2;
        let tooltipY = hovered.y - 40;

        tooltipX = Math.max(5, Math.min(W - tooltipWidth - 5, tooltipX));
        tooltipY = Math.max(5, tooltipY);

        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.beginPath();
        ctx.roundRect(tooltipX, tooltipY, tooltipWidth, tooltipHeight, 4);
        ctx.fill();

        ctx.strokeStyle = 'rgba(100, 200, 150, 0.8)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = 'rgba(226, 232, 240, 1)';
        ctx.fillText(text, tooltipX + padding, tooltipY + 16);

        canvas.style.cursor = 'pointer';
      } else {
        canvas.style.cursor = (isDraggingRef.current || isRightDraggingRef.current) ? 'grabbing' : 'grab';
      }

      // ── Time display ──
      ctx.fillStyle = 'rgba(226,232,240,0.5)';
      ctx.font = '11px monospace';
      ctx.fillText(simDate.toISOString().slice(0, 19).replace('T', ' ') + ' UTC', 10, 20);

      requestAnimationFrame(draw);
    };

    lastFrameTimeRef.current = performance.now();
    requestAnimationFrame(draw);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('contextmenu', handleContextMenu);
      canvas.removeEventListener('mousemove', handleCanvasMouseMove);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('click', handleClick);
      canvas.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, [loading]);

  const toggleInclinationGroup = (minInc: number) => {
    setInclinationGroups((prev) =>
      prev.map((g) => (g.minInc === minInc ? { ...g, enabled: !g.enabled } : g))
    );
    cachedSatPositionsRef.current = [];
  };

  return (
    <Column fillWidth gap="l" style={{ maxWidth: '1400px', margin: '0 auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 400px', gap: 'var(--static-space-24)', alignItems: 'stretch' }}>
        {/* Visualization Panel */}
        <Column className={styles.vizPanel} position="relative" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <canvas ref={canvasRef} className={styles.canvas} style={{ width: '100%', height: '100%' }} />
          {loading && (
            <Column className={styles.loadingOverlay} fillWidth fillHeight horizontal="center" vertical="center" gap="m">
              <div className={styles.spinner} />
              <Column gap="s" horizontal="center">
                <Text variant="label-default-m" className={styles.loadingText}>
                  {loadingText}
                </Text>
                <Text variant="label-default-s" onBackground="neutral-weak" className={styles.loadingSub}>
                  {loadingSub}
                </Text>
              </Column>
            </Column>
          )}
        </Column>

        {/* Controls Panel */}
        <Column gap="m">
          {/* Statistics */}
          <Column className={styles.controlCard} padding="m" gap="m">
            <Text variant="label-default-s" onBackground="neutral-weak" style={{ textTransform: 'uppercase' }}>
              Statistics
            </Text>
            <Column gap="s">
              <Row fillWidth horizontal="between">
                <Text variant="body-default-s">Total loaded</Text>
                <Text variant="body-default-s" className={styles.statValue}>
                  {stats.total.toLocaleString()}
                </Text>
              </Row>
              <Row fillWidth horizontal="between">
                <Text variant="body-default-s">With TLE data</Text>
                <Text variant="body-default-s" className={styles.statValue}>
                  {stats.tle.toLocaleString()}
                </Text>
              </Row>
              <Row fillWidth horizontal="between">
                <Text variant="body-default-s">Visible now</Text>
                <Text variant="body-default-s" className={styles.statValue}>
                  {stats.visible.toLocaleString()}
                </Text>
              </Row>
            </Column>
          </Column>

          {/* Inclination Filters */}
          <Column className={styles.controlCard} padding="m" gap="m">
            <Text variant="label-default-s" onBackground="neutral-weak" style={{ textTransform: 'uppercase' }}>
              Filter by Inclination
            </Text>
            <Column gap="s" style={{ maxHeight: '400px', overflowY: 'auto' }}>
              {inclinationGroups.map((group) => (
                <Row
                  key={group.minInc}
                  gap="s"
                  vertical="center"
                  className={`${styles.shellToggle} ${!group.enabled ? styles.inactive : ''}`}
                  onClick={() => toggleInclinationGroup(group.minInc)}
                >
                  <div
                    className={styles.shellDot}
                    style={{ background: `rgb(${group.color.r}, ${group.color.g}, ${group.color.b})` }}
                  />
                  <Column gap="xs">
                    <Text variant="body-default-s">{group.range}</Text>
                    <Text variant="label-default-xs" onBackground="neutral-weak" className={styles.shellDetail}>
                      {group.count} satellites
                    </Text>
                  </Column>
                </Row>
              ))}
            </Column>
          </Column>

          {/* View Controls */}
          <Column className={styles.controlCard} padding="m" gap="m">
            <Text variant="label-default-s" onBackground="neutral-weak" style={{ textTransform: 'uppercase' }}>
              View
            </Text>
            <Text variant="body-default-xs" onBackground="neutral-weak">
              Left-drag to rotate · Right-drag to pan
            </Text>
            <Row gap="s" vertical="center">
              <input
                type="checkbox"
                checked={autoRotate}
                onChange={(e) => setAutoRotate(e.target.checked)}
                id="autoRotate"
                style={{ cursor: 'pointer' }}
              />
              <label htmlFor="autoRotate" style={{ cursor: 'pointer' }}>
                <Text variant="body-default-s">Auto-rotate</Text>
              </label>
            </Row>
            <Column gap="s">
              <Text variant="body-default-xs" onBackground="neutral-weak">
                Satellite speed:
              </Text>
              <Row gap="s">
                {[
                  { label: 'Pause', value: 0 },
                  { label: '1x', value: 1 },
                  { label: '20x', value: 20 },
                  { label: '100x', value: 100 },
                  { label: '1000x', value: 1000 },
                ].map((btn) => (
                  <button
                    key={btn.value}
                    className={`${styles.speedBtn} ${speed === btn.value ? styles.active : ''}`}
                    onClick={() => setSpeed(btn.value)}
                  >
                    {btn.label}
                  </button>
                ))}
              </Row>
            </Column>
          </Column>

          {/* Trajectory Controls */}
          <Column className={styles.controlCard} padding="m" gap="m">
            <Text variant="label-default-s" onBackground="neutral-weak" style={{ textTransform: 'uppercase' }}>
              Trajectories
            </Text>
            <Row gap="s" vertical="center">
              <input
                type="checkbox"
                checked={showAllTrajectories}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setShowAllTrajectories(checked);
                  if (checked && trajectoryMinutes > 45) {
                    setTrajectoryMinutes(45);
                  } else if (!checked && trajectoryMinutes < 45) {
                    setTrajectoryMinutes(270);
                  }
                }}
                id="showAllTrajectories"
              />
              <label htmlFor="showAllTrajectories">
                <Text variant="body-default-s">Show all trajectories</Text>
              </label>
            </Row>
            <Column gap="s">
              <Row gap="s" vertical="center" horizontal="space-between">
                <Text variant="body-default-xs" onBackground="neutral-weak">
                  Duration: {trajectoryMinutes} min
                </Text>
                <Text variant="body-default-xs" onBackground="neutral-weak">
                  (~{(trajectoryMinutes / 90).toFixed(1)} orbits)
                </Text>
              </Row>
              <input
                type="range"
                min={showAllTrajectories ? "1" : "45"}
                max={showAllTrajectories ? "45" : "450"}
                step={showAllTrajectories ? "1" : "45"}
                value={trajectoryMinutes}
                onChange={(e) => setTrajectoryMinutes(Number(e.target.value))}
                style={{ width: '100%' }}
              />
            </Column>
          </Column>
        </Column>
      </div>
    </Column>
  );
}

// Pure utility — defined outside component so it's never re-created
function geoToXYZ(lon: number, lat: number, r: number): [number, number, number] {
  const latR = (lat * Math.PI) / 180;
  const lonR = (-lon * Math.PI) / 180;
  return [
    r * Math.cos(latR) * Math.cos(lonR),
    r * Math.sin(latR),
    r * Math.cos(latR) * Math.sin(lonR),
  ];
}
