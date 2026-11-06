import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { NetworkConfig } from '../schema/types';
import type { FoldedGraph, RenderNode } from '../engine/grouping';
import type { ComputedLayout } from '../engine/layout';
import type { HighlightTrace, SelectionTarget } from '../engine/selectionTrace';

interface Graph3DViewProps {
  config: NetworkConfig;
  folded: FoldedGraph;
  layout: ComputedLayout;
  selection: SelectionTarget;
  onSelect: (sel: SelectionTarget) => void;
  trace: HighlightTrace;
  searchQuery: string;
}

const SCALE_XZ = 0.36;

export const Graph3DView: React.FC<Graph3DViewProps> = ({
  config,
  folded,
  layout,
  onSelect,
  trace,
  searchQuery,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [layerGap, setLayerGap] = useState<number>(88);
  const [showLabels, setShowLabels] = useState<boolean>(true);

  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    labelRenderer: CSS2DRenderer;
    controls: OrbitControls;
    contentGroup: THREE.Group;
    pickables: Map<THREE.Object3D, SelectionTarget>;
  } | null>(null);

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const sortedLayers = useMemo(
    () => [...config.layers].sort((a, b) => a.order - b.order),
    [config.layers]
  );

  // Initialize Three.js WebGL + CSS2D scene once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#060a12');

    const camera = new THREE.PerspectiveCamera(44, width / height, 1, 6000);
    camera.position.set(360, 340, 480);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(width, height);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0';
    labelRenderer.domElement.style.left = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(labelRenderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxDistance = 2400;
    controls.minDistance = 80;
    controls.target.set(0, 120, 0);

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(ambient);

    const dirLight1 = new THREE.DirectionalLight(0xe0f2fe, 1.15);
    dirLight1.position.set(250, 500, 300);
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0xc4b5fd, 0.55);
    dirLight2.position.set(-300, 200, -250);
    scene.add(dirLight2);

    const contentGroup = new THREE.Group();
    scene.add(contentGroup);

    const pickables = new Map<THREE.Object3D, SelectionTarget>();

    // Raycasting pointer click handler
    const raycaster = new THREE.Raycaster();
    const pointerDownPos = { x: 0, y: 0 };

    const handlePointerDown = (ev: PointerEvent) => {
      pointerDownPos.x = ev.clientX;
      pointerDownPos.y = ev.clientY;
    };

    const handlePointerUp = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      const moved = Math.hypot(ev.clientX - pointerDownPos.x, ev.clientY - pointerDownPos.y);
      if (moved > 5) return; // camera orbit drag, not a selection click

      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(ndc, camera);
      const candidates = Array.from(pickables.keys());
      const hits = raycaster.intersectObjects(candidates, false);
      if (hits.length > 0) {
        const target = pickables.get(hits[0].object) ?? null;
        onSelectRef.current(target);
      } else {
        onSelectRef.current(null);
      }
    };

    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);

    let animFrameId = 0;
    const animate = () => {
      animFrameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    animate();

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.max(100, entry.contentRect.width);
      const h = Math.max(100, entry.contentRect.height);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    sceneRef.current = {
      scene,
      camera,
      renderer,
      labelRenderer,
      controls,
      contentGroup,
      pickables,
    };

    return () => {
      cancelAnimationFrame(animFrameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      controls.dispose();
      renderer.dispose();
      container.innerHTML = '';
      sceneRef.current = null;
    };
  }, []);

  // Rebuild 3D stacked planes, nodes, links, and cross-layer pillars whenever state updates
  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;

    const { contentGroup, pickables, controls } = ctx;

    // Clear previous meshes, geometries, materials, and CSS2D label DOM nodes cleanly
    pickables.clear();
    const toRemove = [...contentGroup.children];
    for (const child of toRemove) {
      child.traverse((obj) => {
        if (obj instanceof CSS2DObject && obj.element.parentNode) {
          obj.element.parentNode.removeChild(obj.element);
        }
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
      contentGroup.remove(child);
    }

    // Determine active layers present in folded graph
    const presentLayerIds = new Set(folded.nodes.map((n) => n.layer));
    const activeLayers = sortedLayers.filter((l) => presentLayerIds.has(l.id));
    if (activeLayers.length === 0) return;

    const layerYMap = new Map<string, number>();
    activeLayers.forEach((l, idx) => {
      layerYMap.set(l.id, idx * layerGap);
    });

    // Center camera target around middle plane height smoothly
    const midY = ((activeLayers.length - 1) * layerGap) / 2;
    controls.target.y = midY * 0.85;

    // Compute plane X/Z bounds
    let minX = -180;
    let maxX = 180;
    let minZ = -130;
    let maxZ = 130;
    for (const rn of folded.nodes) {
      const p = layout.positions.get(rn.id);
      if (!p) continue;
      const x = p.anchorX * SCALE_XZ;
      const z = p.anchorZ * SCALE_XZ;
      minX = Math.min(minX, x - 65);
      maxX = Math.max(maxX, x + 65);
      minZ = Math.min(minZ, z - 55);
      maxZ = Math.max(maxZ, z + 55);
    }

    const planeW = maxX - minX;
    const planeD = maxZ - minZ;
    const centerPlaneX = (minX + maxX) / 2;
    const centerPlaneZ = (minZ + maxZ) / 2;

    // 1. Render Horizontal Stacked Glass Planes
    for (const layer of activeLayers) {
      const y = layerYMap.get(layer.id) ?? 0;
      const isLayerGhost = folded.nodes
        .filter((n) => n.layer === layer.id)
        .every((n) => n.visibility === 'ghost');

      const planeGeo = new THREE.PlaneGeometry(planeW, planeD);
      const planeMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(layer.color),
        transparent: true,
        opacity: isLayerGhost ? 0.025 : 0.055,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const planeMesh = new THREE.Mesh(planeGeo, planeMat);
      planeMesh.rotation.x = -Math.PI / 2;
      planeMesh.position.set(centerPlaneX, y - 4, centerPlaneZ);
      contentGroup.add(planeMesh);

      // Crisp Layer Plane Perimeter Border
      const borderEdges = new THREE.EdgesGeometry(planeGeo);
      const borderMat = new THREE.LineBasicMaterial({
        color: new THREE.Color(layer.color),
        transparent: true,
        opacity: isLayerGhost ? 0.18 : 0.45,
      });
      const borderLines = new THREE.LineSegments(borderEdges, borderMat);
      borderLines.rotation.x = -Math.PI / 2;
      borderLines.position.set(centerPlaneX, y - 3.8, centerPlaneZ);
      contentGroup.add(borderLines);

      // Plane Title CSS2D Tag
      const planeTagEl = document.createElement('div');
      planeTagEl.className = 'plane-3d-tag';
      planeTagEl.style.color = layer.color;
      planeTagEl.textContent = layer.name;
      const planeTagObj = new CSS2DObject(planeTagEl);
      planeTagObj.position.set(minX + 10, y + 2, maxZ - 6);
      contentGroup.add(planeTagObj);

      // Render Region / Zone / Enclave Sub-Pads on this Layer Plane
      const regionPads = layout.layerGroupPads.get(layer.id) ?? [];
      for (const pad of regionPads) {
        const rxMin = pad.anchorMinX * SCALE_XZ;
        const rxMax = pad.anchorMaxX * SCALE_XZ;
        const rzMin = pad.anchorMinZ * SCALE_XZ;
        const rzMax = pad.anchorMaxZ * SCALE_XZ;
        const rw = Math.max(24, rxMax - rxMin);
        const rd = Math.max(24, rzMax - rzMin);
        const rcx = (rxMin + rxMax) / 2;
        const rcz = (rzMin + rzMax) / 2;
        const padColor = pad.group.color ?? layer.color;
        const padY = y - 3.3 + pad.depth * 0.45;

        const rGeo = new THREE.PlaneGeometry(rw, rd);
        const rMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(padColor),
          transparent: true,
          opacity: isLayerGhost ? 0.03 : pad.depth === 0 ? 0.085 : 0.11,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const rMesh = new THREE.Mesh(rGeo, rMat);
        rMesh.rotation.x = -Math.PI / 2;
        rMesh.position.set(rcx, padY, rcz);
        contentGroup.add(rMesh);

        const rBorderGeo = new THREE.EdgesGeometry(rGeo);
        const rBorderMat = new THREE.LineBasicMaterial({
          color: new THREE.Color(padColor),
          transparent: true,
          opacity: isLayerGhost ? 0.22 : 0.65,
        });
        const rBorder = new THREE.LineSegments(rBorderGeo, rBorderMat);
        rBorder.rotation.x = -Math.PI / 2;
        rBorder.position.set(rcx, padY + 0.1, rcz);
        contentGroup.add(rBorder);

        if (showLabels && pad.depth === 0) {
          const rTagEl = document.createElement('div');
          rTagEl.className = 'region-3d-tag';
          rTagEl.style.color = padColor;
          rTagEl.style.borderColor = padColor;
          rTagEl.textContent = pad.group.name;
          const rTagObj = new CSS2DObject(rTagEl);
          rTagObj.position.set(rcx, padY + 1.5, rzMin + 4);
          contentGroup.add(rTagObj);
        }
      }
    }

    const normalizedQuery = searchQuery.trim().toLowerCase();
    const node3DPos = new Map<string, THREE.Vector3>();
    const layerColorMap = new Map(config.layers.map((l) => [l.id, l.color]));

    const createNodeGeometry = (rn: RenderNode): THREE.BufferGeometry => {
      if (rn.isCollapsedGroup) {
        return new THREE.BoxGeometry(28, 12, 22);
      }
      const key = `${rn.role ?? ''} ${rn.type}`.toLowerCase();
      if (key.includes('switch') || key.includes('spine') || key.includes('leaf')) {
        return new THREE.BoxGeometry(22, 7.5, 16);
      }
      if (key.includes('server') || key.includes('compute')) {
        return new THREE.BoxGeometry(18, 9, 22);
      }
      if (key.includes('router') || key.includes('vtep') || key.includes('gateway')) {
        return new THREE.CylinderGeometry(10.5, 10.5, 8.5, 20);
      }
      if (key.includes('database') || key.includes('db')) {
        return new THREE.CylinderGeometry(9.5, 9.5, 13, 18);
      }
      if (key.includes('k8s') || key.includes('vm') || key.includes('worker')) {
        return new THREE.OctahedronGeometry(10.5, 0);
      }
      return new THREE.IcosahedronGeometry(9.5, 1);
    };

    // 2. Render 3D Nodes & CSS2D Labels
    for (const rn of folded.nodes) {
      const p = layout.positions.get(rn.id);
      const y = layerYMap.get(rn.layer);
      if (!p || y === undefined) continue;

      const vec = new THREE.Vector3(p.anchorX * SCALE_XZ, y + 2, p.anchorZ * SCALE_XZ);
      node3DPos.set(rn.id, vec);

      const isSelected = trace.primaryRenderNodeIds.has(rn.id);
      const isUnderlay = trace.underlayRenderNodeIds.has(rn.id);
      const isBlast = trace.blastRenderNodeIds.has(rn.id);
      const matchesSearch =
        !normalizedQuery ||
        rn.label.toLowerCase().includes(normalizedQuery) ||
        rn.id.toLowerCase().includes(normalizedQuery);

      const dimmed =
        (trace.hasSelection && !isSelected && !isUnderlay && !isBlast) ||
        (Boolean(normalizedQuery) && !matchesSearch);

      const baseColorHex =
        rn.health.status === 'down'
          ? '#ef4444'
          : rn.health.status === 'degraded'
          ? '#f59e0b'
          : layerColorMap.get(rn.layer) ?? '#38bdf8';

      let displayHex = baseColorHex;
      let emissiveHex = '#000000';
      if (isSelected) {
        displayHex = '#ffffff';
        emissiveHex = '#38bdf8';
      } else if (isUnderlay) {
        displayHex = rn.health.status === 'down' ? '#ef4444' : '#2dd4bf';
        emissiveHex = '#0d9488';
      } else if (isBlast) {
        displayHex = rn.health.status === 'down' ? '#ef4444' : '#fbbf24';
        emissiveHex = '#b45309';
      }

      const geo = createNodeGeometry(rn);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(displayHex),
        emissive: new THREE.Color(emissiveHex),
        emissiveIntensity: isSelected ? 0.75 : isUnderlay || isBlast ? 0.5 : 0.12,
        roughness: 0.32,
        metalness: 0.25,
        transparent: true,
        opacity: dimmed ? 0.15 : rn.visibility === 'ghost' && !isUnderlay && !isBlast ? 0.35 : 0.96,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(vec);
      if (isSelected) mesh.scale.setScalar(1.22);
      contentGroup.add(mesh);
      pickables.set(mesh, { kind: 'node', id: rn.id });

      // Crisp DOM Label
      if (showLabels) {
        const labelEl = document.createElement('div');
        labelEl.className = [
          'node-3d-label',
          dimmed ? 'dimmed' : '',
          isSelected ? 'selected' : '',
          isUnderlay ? 'underlay-hit' : '',
          isBlast ? 'blast-hit' : '',
        ]
          .filter(Boolean)
          .join(' ');
        labelEl.textContent = rn.health.status === 'down' ? `✕ ${rn.label}` : rn.label;
        labelEl.style.pointerEvents = 'auto';
        labelEl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onSelectRef.current({ kind: 'node', id: rn.id });
        });

        const labelObj = new CSS2DObject(labelEl);
        labelObj.position.set(0, 10, 0);
        mesh.add(labelObj);
      }
    }

    // 3. Render Intra-Layer Links as 3D Tubes on their Plane
    for (const rl of folded.links) {
      const sp = node3DPos.get(rl.source);
      const tp = node3DPos.get(rl.target);
      if (!sp || !tp) continue;

      const isSelected = trace.primaryRenderLinkIds.has(rl.id);
      const isUnderlay = trace.underlayRenderLinkIds.has(rl.id);
      const isBlast = trace.blastRenderLinkIds.has(rl.id);
      const dimmed = trace.hasSelection && !isSelected && !isUnderlay && !isBlast;

      const route = layout.linkRoutes.get(rl.id);
      let curve: THREE.Curve<THREE.Vector3>;

      if (route?.sameRow && Math.abs(sp.z - tp.z) < 6 && route.arcTrack !== 0) {
        // Non-overlapping horizontal arc in Z-plane so skip-links never pierce middle 3D nodes!
        const sign = Math.sign(route.arcTrack);
        const level = Math.abs(route.arcTrack);
        const apexZ = sp.z - sign * (18 + (level - 1) * 14);
        const apexY = (sp.y + tp.y) / 2 + 2.5 + level * 1.4;
        const span = Math.abs(tp.x - sp.x);
        const shoulder = Math.min(20, span * 0.2);
        const dir = tp.x >= sp.x ? 1 : -1;

        curve = new THREE.CubicBezierCurve3(
          sp,
          new THREE.Vector3(sp.x + dir * shoulder, apexY, apexZ),
          new THREE.Vector3(tp.x - dir * shoulder, apexY, apexZ),
          tp
        );
      } else {
        // Direct neighbor or cross-row link
        const dx = tp.x - sp.x;
        const dz = tp.z - sp.z;
        const len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len;
        const nz = dx / len;
        const lateral =
          rl.parallelCount > 1 ? (rl.parallelIndex - (rl.parallelCount - 1) / 2) * 14 : 0;

        const mid = new THREE.Vector3(
          (sp.x + tp.x) / 2 + nx * lateral,
          (sp.y + tp.y) / 2 + (rl.parallelCount > 1 ? 2.5 : 0.5),
          (sp.z + tp.z) / 2 + nz * lateral
        );
        curve = new THREE.QuadraticBezierCurve3(sp, mid, tp);
      }

      const radius = isSelected ? 2.1 : isUnderlay || isBlast ? 1.75 : 1.05;
      const tubeGeo = new THREE.TubeGeometry(curve, 24, radius, 8, false);

      let colorHex = layerColorMap.get(rl.layer) ?? '#94a3b8';
      if (rl.health.status === 'down') colorHex = '#ef4444';
      else if (rl.health.status === 'degraded') colorHex = '#f59e0b';

      if (isSelected) colorHex = '#38bdf8';
      else if (isUnderlay && rl.health.status !== 'down') colorHex = '#2dd4bf';
      else if (isBlast && rl.health.status !== 'down') colorHex = '#fbbf24';

      const tubeMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(colorHex),
        transparent: true,
        opacity: dimmed
          ? 0.08
          : isSelected || isUnderlay || isBlast
          ? 0.96
          : rl.visibility === 'ghost'
          ? 0.22
          : 0.68,
      });

      const tubeMesh = new THREE.Mesh(tubeGeo, tubeMat);
      contentGroup.add(tubeMesh);
      pickables.set(tubeMesh, { kind: 'link', id: rl.id });
    }

    // 4. Render Vertical Cross-Layer Hosting Pillars (Upper Plane -> Lower Plane)
    for (const rn of folded.nodes) {
      const upVec = node3DPos.get(rn.id);
      if (!upVec) continue;

      for (const hostId of rn.hostedOn) {
        const lowVec = node3DPos.get(hostId);
        if (!lowVec) continue;

        const upInTrace =
          trace.primaryRenderNodeIds.has(rn.id) ||
          trace.underlayRenderNodeIds.has(rn.id) ||
          trace.blastRenderNodeIds.has(rn.id);
        const lowInTrace =
          trace.primaryRenderNodeIds.has(hostId) ||
          trace.underlayRenderNodeIds.has(hostId) ||
          trace.blastRenderNodeIds.has(hostId);

        const activePillar = trace.hasSelection && upInTrace && lowInTrace;

        if (activePillar) {
          // Glowing vertical cylinder/tube beam for active cross-layer trace!
          const pillarCurve = new THREE.LineCurve3(lowVec, upVec);
          const pillarGeo = new THREE.TubeGeometry(pillarCurve, 4, 1.45, 8, false);
          const pillarColor = trace.blastRenderNodeIds.has(rn.id) ? '#fbbf24' : '#2dd4bf';
          const pillarMat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(pillarColor),
            transparent: true,
            opacity: 0.92,
          });
          const pillarMesh = new THREE.Mesh(pillarGeo, pillarMat);
          contentGroup.add(pillarMesh);
        } else {
          // Ambient vertical structural guide line
          const pts = [lowVec, upVec];
          const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
          const lineMat = new THREE.LineBasicMaterial({
            color: new THREE.Color('#64748b'),
            transparent: true,
            opacity: trace.hasSelection ? 0.06 : 0.26,
          });
          const line = new THREE.Line(lineGeo, lineMat);
          contentGroup.add(line);
        }
      }
    }
  }, [config, folded, layout, trace, layerGap, showLabels, searchQuery, sortedLayers]);

  const applyCameraPreset = useCallback(
    (preset: 'iso' | 'side' | 'top') => {
      const ctx = sceneRef.current;
      if (!ctx) return;
      const presentCount = new Set(folded.nodes.map((n) => n.layer)).size;
      const midY = ((Math.max(1, presentCount) - 1) * layerGap) / 2;

      ctx.controls.target.set(0, midY * 0.85, 0);
      if (preset === 'iso') {
        ctx.camera.position.set(360, midY + 240, 470);
      } else if (preset === 'side') {
        ctx.camera.position.set(0, midY + 40, 640);
      } else if (preset === 'top') {
        ctx.camera.position.set(0, midY + 620, 10);
      }
      ctx.controls.update();
    },
    [folded.nodes, layerGap]
  );

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* 3D HUD Controls */}
      <div className="canvas-hud">
        <div className="segmented-control">
          <button className="seg-btn" onClick={() => applyCameraPreset('iso')}>
            Isometric
          </button>
          <button className="seg-btn" onClick={() => applyCameraPreset('side')}>
            Side Elevation
          </button>
          <button className="seg-btn" onClick={() => applyCameraPreset('top')}>
            Top-Down
          </button>
        </div>

        <div className="hud-pill">
          <span>Plane Spacing</span>
          <input
            type="range"
            min={0}
            max={160}
            value={layerGap}
            onChange={(e) => setLayerGap(Number(e.target.value))}
            style={{ width: 85, accentColor: '#38bdf8' }}
          />
        </div>

        <button
          className={`btn ${showLabels ? 'btn-primary' : ''}`}
          onClick={() => setShowLabels((v) => !v)}
        >
          Labels
        </button>
      </div>

      <div className="canvas-hud-bottom">
        <div className="hud-pill">
          <span className="legend-item">
            <span className="legend-line" style={{ background: '#38bdf8' }} />
            Selected
          </span>
          <span className="legend-item">
            <span className="legend-line" style={{ background: '#2dd4bf' }} />
            Underlay Pillars &amp; Hops
          </span>
          <span className="legend-item">
            <span className="legend-line" style={{ background: '#fbbf24' }} />
            Blast Radius Above
          </span>
        </div>

        <div className="hud-pill" style={{ fontSize: 11 }}>
          <span>Left-Drag: Orbit · Right-Drag: Pan · Scroll: Zoom · Click Node/Tube: Trace</span>
        </div>
      </div>

      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
};
