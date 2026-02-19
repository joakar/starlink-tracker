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
  const countryPolygonsRef = useRef<any[]>([]);
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

  const EARTH_R = 210;

  // Group inclinations into 10-degree buckets
  const getInclinationBucket = (inc: number) => {
    return Math.floor(inc / 10) * 10;
  };

  // Generate color for inclination group - using same color schema as reference
  const getColorForInclination = (bucket: number) => {
    // Map inclination buckets to specific colors matching the reference design
    // 53° shell: indigo/purple, 70° shell: green/teal, 97° shell: orange

    if (bucket >= 50 && bucket < 60) {
      // 53° shell range - indigo/purple
      return { r: 99, g: 102, b: 241 };
    } else if (bucket >= 60 && bucket < 80) {
      // 70° shell range - green/teal
      return { r: 52, g: 211, b: 153 };
    } else if (bucket >= 90) {
      // 97° polar shell range - orange
      return { r: 251, g: 146, b: 60 };
    } else {
      // Fallback for other inclinations - use a gradient between colors
      if (bucket < 50) {
        // Lower inclinations - blue
        return { r: 59, g: 130, b: 246 };
      } else if (bucket >= 80 && bucket < 90) {
        // Mid-high inclinations - yellow-green
        return { r: 163, g: 230, b: 53 };
      } else {
        // Default - cyan
        return { r: 34, g: 211, b: 238 };
      }
    }
  };

  const loadWorldMap = async () => {
    try {
      const geo = topojson.feature(worldAtlas as any, (worldAtlas as any).objects.countries);
      countryPolygonsRef.current = [];
      for (const feature of geo.features) {
        const geom = feature.geometry;
        const rings =
          geom.type === 'Polygon'
            ? geom.coordinates
            : geom.type === 'MultiPolygon'
            ? geom.coordinates.flat()
            : [];
        for (const ring of rings) {
          countryPolygonsRef.current.push(ring);
        }
      }
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
      const inclinationBuckets = new Map<number, number>(); // bucket -> count

      satellitesRef.current = [];
      for (const sat of allDocs) {
        const st = sat.spaceTrack;
        if (!st || !st.TLE_LINE1 || !st.TLE_LINE2) continue;
        if (st.DECAYED === 1 || st.DECAY_DATE) continue;

        try {
          const satrec = satellite.twoline2satrec(st.TLE_LINE1, st.TLE_LINE2);
          if (satrec.error !== 0) continue;

          // Filter out satellites with high eccentricity (>0.01)
          if (satrec.ecco && satrec.ecco > 0.01) continue;

          // Test propagate to current time to ensure satellite is valid
          const testDate = new Date();
          const testPos = satellite.propagate(satrec, testDate);
          if (!testPos || !testPos.position) continue;

          // Additional validation: check position consistency over time
          // Sample 3 positions at different times to verify stable orbit
          const testTimes = [
            new Date(testDate.getTime()),
            new Date(testDate.getTime() + 10 * 60 * 1000), // +10 min
            new Date(testDate.getTime() + 20 * 60 * 1000), // +20 min
          ];

          let isValid = true;
          const testPositions = [];

          for (const time of testTimes) {
            const pos = satellite.propagate(satrec, time);
            if (!pos || !pos.position || typeof pos.position !== 'object') {
              isValid = false;
              break;
            }

            // Convert to geodetic to check altitude
            try {
              const gmst = satellite.gstime(time);
              const geo = satellite.eciToGeodetic(pos.position, gmst);
              const alt = geo.height;

              // Filter out satellites with invalid altitudes (deorbiting or too high)
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

          // Check altitude consistency - should not vary more than 50km over 20 minutes
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

          satellitesRef.current.push({
            satrec,
            name: st.OBJECT_NAME || 'Unknown',
            inc,
            group: bucket.toString(),
            color: getColorForInclination(bucket),
          });
        } catch (e) {
          // skip bad TLE
        }
      }

      // Create inclination groups array
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

      // Set canvas internal resolution based on displayed size
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;

      // Scale context to match device pixel ratio
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(dpr, dpr);
      }
    };

    // Initial resize
    resizeCanvas();

    // Listen for window resize
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
      // Update mouse position relative to canvas for hover detection
      // Using CSS pixels (same coordinate system as drawing)
      const rect = canvas.getBoundingClientRect();

      mouseCanvasRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
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
            color: sat.color
          };
        }
      } else if (!wasDrag) {
        // Only deselect on a genuine click on empty space, not after dragging
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
      const c = Math.cos(a),
        s = Math.sin(a);
      return [x * c + z * s, y, -x * s + z * c];
    };

    const rotateX = (x: number, y: number, z: number, a: number) => {
      const c = Math.cos(a),
        s = Math.sin(a);
      return [x, y * c - z * s, y * s + z * c];
    };

    const project = (x: number, y: number, z: number, cx: number, cy: number, vr: number, vt: number, zoom: number) => {
      let [px, py, pz] = rotateY(x, y, z, vr);
      [px, py, pz] = rotateX(px, py, pz, vt);
      return { x: cx + px * zoom, y: cy - py * zoom, z: pz };
    };

    const getSatLatLonAlt = (satrec: any, date: Date) => {
      try {
        const posVel = satellite.propagate(satrec, date);
        if (!posVel || !posVel.position || typeof posVel.position !== 'object') return null;
        const gmst = satellite.gstime(date);
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

    const geoToXYZ = (lon: number, lat: number, r: number) => {
      const latR = (lat * Math.PI) / 180;
      const lonR = (-lon * Math.PI) / 180;
      return [r * Math.cos(latR) * Math.cos(lonR), r * Math.sin(latR), r * Math.cos(latR) * Math.sin(lonR)];
    };

    const draw = (now: number) => {
      const dt = now - lastFrameTimeRef.current;
      lastFrameTimeRef.current = now;
      // Speed: 1 = realtime, 100 = 100x, 1000 = 1000x, 0 = paused
      // Formula: dt * (speed - 1) because simDate = Date.now() + timeOffset
      // At speed=1: timeOffset doesn't change, so simDate = Date.now() (realtime)
      // At speed=100: timeOffset increases 99x faster, so simDate advances 100x total
      const currentSpeed = speedRef.current;
      if (currentSpeed === 0) {
        // When paused, freeze time at the moment of pause
        if (pausedTimeRef.current === null) {
          pausedTimeRef.current = Date.now() + timeOffsetRef.current;
        }
        // Keep timeOffset adjusted so simDate stays constant
        timeOffsetRef.current = pausedTimeRef.current - Date.now();
      } else {
        // When unpaused, clear the paused time
        pausedTimeRef.current = null;
        if (currentSpeed > 0) {
          timeOffsetRef.current += dt * (currentSpeed - 1);
        }
      }
      // At speed=0: simDate is frozen at pausedTime

      // Use display size (CSS pixels) for coordinates
      const rect = canvas.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      const cx = W / 2 + panOffsetRef.current.x,
        cy = H / 2 + panOffsetRef.current.y;
      const zoom = zoomRef.current;

      if (autoRotateRef.current && !isDraggingRef.current) {
        autoRotateAngleRef.current += 0.002;
      }
      const viewRot = dragRotRef.current.x + autoRotateAngleRef.current;
      const viewTilt = dragRotRef.current.y;

      ctx.clearRect(0, 0, W, H);

      // Background
      ctx.fillStyle = 'rgb(10, 10, 10)';
      ctx.fillRect(0, 0, W, H);

      // Stars
      for (let i = 0; i < 100; i++) {
        ctx.fillStyle = `rgba(200,210,230,${0.15 + (i % 5) * 0.08})`;
        ctx.fillRect((i * 7919 + 42) % W, (i * 6271 + 42) % H, 1, 1);
      }

      const earthR = EARTH_R * zoom;

      // Atmosphere glow
      const glow = ctx.createRadialGradient(cx, cy, earthR - 5, cx, cy, earthR + 25);
      glow.addColorStop(0, 'rgba(56, 189, 248, 0.07)');
      glow.addColorStop(1, 'transparent');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, earthR + 25, 0, Math.PI * 2);
      ctx.fill();

      // Earth
      const earthGrad = ctx.createRadialGradient(cx - 40 * zoom, cy - 40 * zoom, 10 * zoom, cx, cy, earthR);
      earthGrad.addColorStop(0, '#1e4976');
      earthGrad.addColorStop(0.7, '#122d4f');
      earthGrad.addColorStop(1, '#0a1a30');
      ctx.fillStyle = earthGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, earthR, 0, Math.PI * 2);
      ctx.fill();

      // Countries
      for (const ring of countryPolygonsRef.current) {
        // Interpolate points along great circles for smooth curves
        const interpolatedCoords: Array<{ x: number; y: number; z: number }> = [];

        for (let i = 0; i < ring.length; i++) {
          const [lon1, lat1] = ring[i];
          const [lon2, lat2] = ring[(i + 1) % ring.length];

          const [x1, y1, z1] = geoToXYZ(lon1, lat1, EARTH_R * 0.998);
          const [x2, y2, z2] = geoToXYZ(lon2, lat2, EARTH_R * 0.998);

          // Calculate angular distance
          const len1 = Math.sqrt(x1 ** 2 + y1 ** 2 + z1 ** 2);
          const len2 = Math.sqrt(x2 ** 2 + y2 ** 2 + z2 ** 2);
          const dotProduct = (x1 * x2 + y1 * y2 + z1 * z2) / (len1 * len2);
          const angularDist = Math.acos(Math.max(-1, Math.min(1, dotProduct)));

          // Add the first point
          interpolatedCoords.push({ x: x1, y: y1, z: z1 });

          // If points are far apart, add intermediate points along great circle
          if (angularDist > 0.05) { // ~2.9 degrees - more aggressive interpolation
            const steps = Math.ceil(angularDist / 0.05);
            for (let s = 1; s < steps; s++) {
              const t = s / steps;
              // Spherical linear interpolation (slerp)
              const sinAngle = Math.sin(angularDist);
              if (sinAngle > 0.001) { // Avoid division by zero
                const a = Math.sin((1 - t) * angularDist) / sinAngle;
                const b = Math.sin(t * angularDist) / sinAngle;
                const x = a * x1 + b * x2;
                const y = a * y1 + b * y2;
                const z = a * z1 + b * z2;
                interpolatedCoords.push({ x, y, z });
              }
            }
          }
        }

        const projected = interpolatedCoords.map(({ x, y, z }) =>
          project(x, y, z, cx, cy, viewRot, viewTilt, zoom)
        );

        // Helper function to interpolate edge intersection with visibility boundary (z=0 plane)
        const getEdgeIntersection = (
          p1: { x: number; y: number; z: number },
          p2: { x: number; y: number; z: number },
          coord3D1: { x: number; y: number; z: number },
          coord3D2: { x: number; y: number; z: number }
        ) => {
          // Linear interpolation to find where z crosses 0
          const t = p1.z / (p1.z - p2.z);

          // Interpolate in 3D space
          const interpX = coord3D1.x + t * (coord3D2.x - coord3D1.x);
          const interpY = coord3D1.y + t * (coord3D2.y - coord3D1.y);
          const interpZ = coord3D1.z + t * (coord3D2.z - coord3D1.z);

          // Project the interpolated point
          const projected = project(interpX, interpY, interpZ, cx, cy, viewRot, viewTilt, zoom);
          return { x: projected.x, y: projected.y, z: projected.z };
        };

        // Fill countries.
        // We clip the canvas to the Earth circle, then build each polygon's visible
        // path.  At invisible gaps we arc along the Earth limb (instead of a straight
        // chord) so the fill follows the globe's curvature.
        // Arc direction: between exit point A and entry point B, we pick the arc
        // whose midpoint is INSIDE the Earth disk AND has the smaller angular span —
        // unless the polygon dips entirely behind the globe, in which case we want
        // the larger arc.  We resolve this by checking whether the straight-chord
        // midpoint of the invisible arc is closer to the Earth centre than earthR
        // (meaning the gap goes around the back, so use short arc on limb).
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, earthR, 0, Math.PI * 2);
        ctx.clip();

        ctx.fillStyle = 'rgba(34, 80, 60, 0.4)';

        // Collect path as segments separated by limb-arc gaps.
        // A "gap" is an exit limb point followed by an entry limb point.
        type ClipPt = { x: number; y: number; isLimb: boolean };
        const clippedPath: ClipPt[] = [];

        for (let i = 0; i < projected.length; i++) {
          const p = projected[i];
          const next = projected[(i + 1) % projected.length];
          const coord3D = interpolatedCoords[i];
          const nextCoord3D = interpolatedCoords[(i + 1) % interpolatedCoords.length];

          const currentVisible = p.z > 0;
          const nextVisible = next.z > 0;

          if (currentVisible) {
            clippedPath.push({ x: p.x, y: p.y, isLimb: false });
            if (!nextVisible) {
              const ix = getEdgeIntersection(next, p, nextCoord3D, coord3D);
              clippedPath.push({ x: ix.x, y: ix.y, isLimb: true });
            }
          } else {
            if (nextVisible) {
              const ix = getEdgeIntersection(p, next, coord3D, nextCoord3D);
              clippedPath.push({ x: ix.x, y: ix.y, isLimb: true });
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
              // This gap spans invisible back-of-globe territory.
              // Arc along the Earth limb. Pick direction based on the invisible
              // 3D path: the arc should go the SHORT way around the circle
              // (the invisible portion of the polygon is on the back, so the
              // visible fill should close via the shorter limb arc).
              const startA = Math.atan2(cur.y - cy, cur.x - cx);
              const endA   = Math.atan2(nxt.y - cy, nxt.x - cx);

              // Angular difference CCW (endA - startA) normalised to [0, 2π)
              let ccwSpan = endA - startA;
              if (ccwSpan < 0) ccwSpan += Math.PI * 2;

              // Choose the shorter arc — the invisible segment is behind the
              // globe so the fill should close along the nearer limb path.
              // "Shorter" means ccwSpan < π → go CCW, else go CW.
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

        // Draw borders
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < projected.length; i++) {
          const p = projected[i];
          const next = projected[(i + 1) % projected.length];
          const coord3D = interpolatedCoords[i];
          const nextCoord3D = interpolatedCoords[(i + 1) % interpolatedCoords.length];

          // Only draw line if both points are on the front side
          if (p.z > 0 && next.z > 0) {
            // Check screen-space distance to avoid wrapping artifacts
            const dx = next.x - p.x;
            const dy = next.y - p.y;
            const screenDist = Math.sqrt(dx * dx + dy * dy);

            // Check if both points are actually visible (accounting for Earth radius)
            const dist3D = Math.sqrt(
              (nextCoord3D.x - coord3D.x) ** 2 +
              (nextCoord3D.y - coord3D.y) ** 2 +
              (nextCoord3D.z - coord3D.z) ** 2
            );

            // Very strict: small screen distance AND small 3D distance
            if (screenDist < 15 * zoom && dist3D < 20) {
              if (!started) {
                ctx.moveTo(p.x, p.y);
                started = true;
              }
              ctx.lineTo(next.x, next.y);
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

      // Satellites - only recalculate positions every 100ms to reduce lag
      const simDate = new Date(Date.now() + timeOffsetRef.current);
      const ORBIT_SCALE = EARTH_R / 6371;
      let visibleCount = 0;

      // Build enabled groups set for faster lookup
      const enabledGroups = new Set(
        inclinationGroupsRef.current.filter(g => g.enabled).map(g => g.minInc.toString())
      );

      // Update satellite positions only every 100ms (or when dragging, every 200ms)
      const updateInterval = isDraggingRef.current ? 200 : 100;
      let satPositions = cachedSatPositionsRef.current;

      if (now - lastSatUpdateRef.current > updateInterval || satPositions.length === 0) {
        lastSatUpdateRef.current = now;
        satPositions = [];

        // Process satellites
        for (let i = 0; i < satellitesRef.current.length; i++) {
          const sat = satellitesRef.current[i];
          if (!enabledGroups.has(sat.group)) continue;

          const pos = getSatLatLonAlt(sat.satrec, simDate);
          if (!pos || isNaN(pos.lat) || isNaN(pos.lon) || isNaN(pos.alt)) continue;

          // Filter satellites by altitude
          if (pos.alt < 200 || pos.alt > 800) continue;

          // Scale altitude for visualization
          const altPx = EARTH_R + pos.alt * ORBIT_SCALE * 0.8;
          const [x, y, z] = geoToXYZ(-pos.lon, pos.lat, altPx);
          satPositions.push({ x, y, z, lat: pos.lat, lon: pos.lon, altPx, color: sat.color, name: sat.name, satrec: sat.satrec });
        }

        cachedSatPositionsRef.current = satPositions;
      }

      // Project cached positions with current rotation
      const projectedSats = satPositions.map(sat => {
        // Apply rotation to get 3D position in view space
        let [rx, ry, rz] = rotateY(sat.x, sat.y, sat.z, viewRot);
        [rx, ry, rz] = rotateX(rx, ry, rz, viewTilt);

        const p = project(sat.x, sat.y, sat.z, cx, cy, viewRot, viewTilt, zoom);
        return { ...p, color: sat.color, altPx: sat.altPx, rx, ry, rz, name: sat.name, satrec: sat.satrec };
      });

      // Sort by z-index for painter's algorithm
      projectedSats.sort((a, b) => a.z - b.z);

      // Detect hovered satellite
      const mouseX = mouseCanvasRef.current.x;
      const mouseY = mouseCanvasRef.current.y;
      let closestSat: { name: string; x: number; y: number; dist: number } | null = null;

      for (const sp of projectedSats) {
        const distToAxis = Math.sqrt(sp.rx ** 2 + sp.ry ** 2);
        let occluded = false;
        if (distToAxis < EARTH_R) {
          const earthSurfaceZ = Math.sqrt(EARTH_R ** 2 - distToAxis ** 2);
          occluded = sp.rz < earthSurfaceZ;
        }

        if (!occluded) {
          const dx = sp.x - mouseX;
          const dy = sp.y - mouseY;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 10 && (!closestSat || dist < closestSat.dist)) {
            closestSat = { name: sp.name, x: sp.x, y: sp.y, dist };
          }
        }
      }

      hoveredSatRef.current = closestSat ? { name: closestSat.name, x: closestSat.x, y: closestSat.y } : null;

      // Render satellites
      for (let i = 0; i < projectedSats.length; i++) {
        const sp = projectedSats[i];

        // Check if satellite is occluded by Earth using rotated coordinates
        // Distance from satellite to z-axis (perpendicular to viewing direction)
        const distToAxis = Math.sqrt(sp.rx ** 2 + sp.ry ** 2);

        // If satellite is within Earth's "shadow cone" from viewer's perspective
        let occluded = false;
        if (distToAxis < EARTH_R) {
          // Calculate where Earth surface would be at this perpendicular distance
          const earthSurfaceZ = Math.sqrt(EARTH_R ** 2 - distToAxis ** 2);
          // If satellite's z is less than Earth surface, it's behind Earth
          occluded = sp.rz < earthSurfaceZ;
        }

        const behind = occluded;

        if (!behind) {
          // Draw glow
          ctx.fillStyle = `rgba(${sp.color.r},${sp.color.g},${sp.color.b},0.15)`;
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, 4, 0, Math.PI * 2);
          ctx.fill();

          // Draw satellite
          ctx.fillStyle = `rgba(${sp.color.r},${sp.color.g},${sp.color.b},0.8)`;
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, 2, 0, Math.PI * 2);
          ctx.fill();

          visibleCount++;
        }
        // Satellites behind Earth are not rendered at all
      }

      // Only update stats every 30 frames (~0.5 seconds) to avoid React re-renders
      frameCountRef.current++;
      if (frameCountRef.current % 30 === 0) {
        setStats((prev) => ({ ...prev, visible: visibleCount }));
      }

      // Helper function to validate trajectory is stable/normal
      const isTrajectoryValid = (satrec: any): boolean => {
        const testSteps = 10; // More samples for better detection
        const altitudes: number[] = [];
        const positions: Array<{ lat: number; lon: number; alt: number }> = [];

        // Sample points to check for consistency
        for (let i = 0; i < testSteps; i++) {
          const testTime = new Date(simDate.getTime() + (i * 5 * 60 * 1000)); // Every 5 minutes
          const pos = getSatLatLonAlt(satrec, testTime);

          if (!pos || isNaN(pos.lat) || isNaN(pos.lon) || isNaN(pos.alt)) {
            return false; // Invalid position data
          }

          // Check if altitude is within reasonable LEO range
          if (pos.alt < 100 || pos.alt > 2000) {
            return false; // Too low (deorbiting) or too high (not LEO)
          }

          altitudes.push(pos.alt);
          positions.push(pos);
        }

        // Check for erratic altitude changes (tightened from 200km to 100km)
        const maxAlt = Math.max(...altitudes);
        const minAlt = Math.min(...altitudes);
        if (maxAlt - minAlt > 100) {
          return false; // Highly elliptical or unstable orbit
        }

        // Check velocity consistency - measure distance traveled between points
        const velocities: number[] = [];
        for (let i = 1; i < positions.length; i++) {
          const pos1 = positions[i - 1];
          const pos2 = positions[i];

          // Rough distance calculation (simplified great circle)
          const dLat = (pos2.lat - pos1.lat) * Math.PI / 180;
          const dLon = (pos2.lon - pos1.lon) * Math.PI / 180;
          const a = Math.sin(dLat / 2) ** 2 +
                    Math.cos(pos1.lat * Math.PI / 180) * Math.cos(pos2.lat * Math.PI / 180) *
                    Math.sin(dLon / 2) ** 2;
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          const avgAlt = (pos1.alt + pos2.alt) / 2;
          const distance = (6371 + avgAlt) * c; // km traveled

          velocities.push(distance); // Distance per 5 minutes
        }

        // Check for erratic velocity changes (normal satellites have consistent speed)
        const avgVelocity = velocities.reduce((a, b) => a + b, 0) / velocities.length;
        for (const vel of velocities) {
          // If any velocity deviates more than 50% from average, reject
          if (Math.abs(vel - avgVelocity) / avgVelocity > 0.5) {
            return false;
          }
        }

        return true;
      };

      // Helper function to draw trajectory for a satellite
      const drawTrajectory = (satrec: any, color: { r: number; g: number; b: number }, opacity: number = 0.6, lineWidth: number = 2) => {
        // Validate trajectory first
        if (!isTrajectoryValid(satrec)) {
          return; // Skip drawing invalid trajectories
        }

        // Draw orbital path
        const minutes = trajectoryMinutesRef.current;
        const steps = Math.min(300, Math.max(50, Math.floor(minutes * 1.1))); // Adaptive step count

        // Calculate all points first with occlusion check
        const allPoints: Array<{ x: number; y: number; z: number; visible: boolean }> = [];
        for (let step = 0; step <= steps; step++) {
          const timeOffset = (step / steps) * minutes * 60 * 1000;
          const futureDate = new Date(simDate.getTime() + timeOffset);
          const pos = getSatLatLonAlt(satrec, futureDate);

          if (pos && !isNaN(pos.lat) && !isNaN(pos.lon) && !isNaN(pos.alt)) {
            const altPx = EARTH_R + pos.alt * ORBIT_SCALE * 0.8;
            const [x, y, z] = geoToXYZ(-pos.lon, pos.lat, altPx);

            // Apply rotation to check occlusion
            let [rx, ry, rz] = rotateY(x, y, z, viewRot);
            [rx, ry, rz] = rotateX(rx, ry, rz, viewTilt);

            // Check if occluded by Earth (not just behind camera)
            const distToAxis = Math.sqrt(rx ** 2 + ry ** 2);
            let visible = true;

            if (distToAxis < EARTH_R) {
              const earthSurfaceZ = Math.sqrt(EARTH_R ** 2 - distToAxis ** 2);
              // Point is occluded if it's behind Earth surface at this perpendicular distance
              if (rz < earthSurfaceZ) {
                visible = false;
              }
            }

            const p = project(x, y, z, cx, cy, viewRot, viewTilt, zoom);
            allPoints.push({ ...p, visible });
          }
        }

        // Draw trajectory, breaking only when occluded by Earth
        ctx.strokeStyle = `rgba(${color.r},${color.g},${color.b},${opacity})`;
        ctx.lineWidth = lineWidth;
        //ctx.setLineDash([5, 5]);
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
        //ctx.setLineDash([]);
      };

      // Draw trajectories
      if (showAllTrajectoriesRef.current) {
        // Draw trajectories for all visible satellites
        for (const sat of satPositions) {
          drawTrajectory(sat.satrec, sat.color, 0.3, 1);
        }
      } else if (selectedSatRef.current) {
        // Draw trajectory for selected satellite only
        const selected = selectedSatRef.current;
        drawTrajectory(selected.satrec, selected.color, 0.6, 2);
      }

      // Draw tooltip for hovered satellite
      if (hoveredSatRef.current) {
        const hovered = hoveredSatRef.current;
        const padding = 8;
        const text = hovered.name;
        ctx.font = '12px sans-serif';
        const textWidth = ctx.measureText(text).width;
        const tooltipWidth = textWidth + padding * 2;
        const tooltipHeight = 24;

        // Position tooltip above satellite
        let tooltipX = hovered.x - tooltipWidth / 2;
        let tooltipY = hovered.y - 40;

        // Keep tooltip in bounds
        tooltipX = Math.max(5, Math.min(W - tooltipWidth - 5, tooltipX));
        tooltipY = Math.max(5, tooltipY);

        // Draw tooltip background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.beginPath();
        ctx.roundRect(tooltipX, tooltipY, tooltipWidth, tooltipHeight, 4);
        ctx.fill();

        // Draw tooltip border
        ctx.strokeStyle = 'rgba(100, 200, 150, 0.8)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Draw tooltip text
        ctx.fillStyle = 'rgba(226, 232, 240, 1)';
        ctx.fillText(text, tooltipX + padding, tooltipY + 16);

        // Change cursor style
        canvas.style.cursor = 'pointer';
      } else {
        canvas.style.cursor = (isDraggingRef.current || isRightDraggingRef.current) ? 'grabbing' : 'grab';
      }

      // Time display (top of canvas)
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
    // Clear cached satellite positions to force immediate filter update
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
                  // Clamp value when switching modes
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
