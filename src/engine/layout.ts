import type { GroupSpec, NetworkConfig } from '../schema/types';
import type { FoldedGraph, RenderNode } from './grouping';

export type Layout2DMode = 'swimlanes' | 'anchored';

export interface NodePosition {
  x: number;
  y: number;
  /** Canonical anchored horizontal/depth coordinates used directly on 3D planes */
  anchorX: number;
  anchorZ: number;
}

export interface GroupBox {
  key: string;
  group: GroupSpec;
  layerId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  anchorMinX: number;
  anchorMaxX: number;
  anchorMinZ: number;
  anchorMaxZ: number;
  depth: number; // nesting depth (0 = outer site/region, 1 = inner rack/host, etc.)
}

export interface ComputedLayout {
  positions: Map<string, NodePosition>;
  groupBoxes: GroupBox[];
  /** Per-layer region/group pads for 3D planes (and per-band 2D rendering) */
  layerGroupPads: Map<string, GroupBox[]>;
}

function getRoleTier(role?: string, type?: string): number {
  const key = `${role ?? ''} ${type ?? ''}`.toLowerCase();
  if (key.includes('wan') || key.includes('internet') || key.includes('cloud') || key.includes('core')) {
    return 0;
  }
  if (key.includes('spine') || key.includes('rr') || key.includes('reflector') || key.includes('control')) {
    return 1;
  }
  if (
    key.includes('leaf') ||
    key.includes('tor') ||
    key.includes('border') ||
    key.includes('gateway') ||
    key.includes('router') ||
    key.includes('firewall') ||
    key.includes('vtep')
  ) {
    return 2;
  }
  if (key.includes('server') || key.includes('compute') || key.includes('host') || key.includes('baremetal')) {
    return 3;
  }
  if (key.includes('vm') || key.includes('worker') || key.includes('node')) {
    return 3;
  }
  return 2;
}

export function computeLayout(
  config: NetworkConfig,
  folded: FoldedGraph,
  mode2D: Layout2DMode,
  manualOverrides: Map<string, { x: number; y: number }> = new Map()
): ComputedLayout {
  const sortedLayers = [...config.layers].sort((a, b) => a.order - b.order);
  const layerIndexMap = new Map<string, number>(sortedLayers.map((l, idx) => [l.id, idx]));
  const groupMap = new Map<string, GroupSpec>(config.groups.map((g) => [g.id, g]));

  // Map original node positions & group memberships
  const renderNodeMap = new Map<string, RenderNode>(folded.nodes.map((n) => [n.id, n]));

  // Compute group nesting depth
  const getGroupDepth = (gid: string): number => {
    let depth = 0;
    let curr = groupMap.get(gid)?.parent;
    const seen = new Set<string>();
    while (curr && !seen.has(curr)) {
      seen.add(curr);
      depth++;
      curr = groupMap.get(curr)?.parent;
    }
    return depth;
  };

  const getRootGroup = (gid?: string): string => {
    if (!gid) return '__ungrouped__';
    let curr = gid;
    const seen = new Set<string>();
    while (curr && !seen.has(curr)) {
      seen.add(curr);
      const p = groupMap.get(curr)?.parent;
      if (!p) return curr;
      curr = p;
    }
    return curr;
  };

  // Step 1: Compute canonical (anchorX, anchorZ) across ALL config nodes first so positions remain rock-steady
  // even as layers are toggled on/off!
  const canonicalCoords = new Map<string, { x: number; z: number }>();

  const nodesByLayer = new Map<string, typeof config.nodes>();
  for (const l of sortedLayers) nodesByLayer.set(l.id, []);
  for (const n of config.nodes) nodesByLayer.get(n.layer)?.push(n);

  // Lay out unhosted / root nodes (primarily Layer 0 physical, plus any standalone virtual appliances)
  const bottomLayer = sortedLayers[0];
  const rootNodes = config.nodes.filter(
    (n) => n.layer === bottomLayer.id || n.hostedOn.length === 0
  );

  // Partition Layer-0 / unhosted root nodes by (rootGroup, leafGroup, roleTier)
  // Order root groups stably by declaration order in config.groups
  const groupOrderIndex = new Map<string, number>();
  config.groups.forEach((g, idx) => groupOrderIndex.set(g.id, idx));
  groupOrderIndex.set('__ungrouped__', 9999);

  // Bucket physical/unhosted nodes per Layer so Layer 0 defines the primary spatial grid
  const layer0Nodes = rootNodes.filter((n) => n.layer === bottomLayer.id);

  // Group Layer 0 nodes by top-level site/group, then sub-group (rack), then tier
  const siteBuckets = new Map<string, typeof layer0Nodes>();
  for (const n of layer0Nodes) {
    const rootG = getRootGroup(n.group);
    if (!siteBuckets.has(rootG)) siteBuckets.set(rootG, []);
    siteBuckets.get(rootG)!.push(n);
  }

  const orderedSites = Array.from(siteBuckets.keys()).sort(
    (a, b) => (groupOrderIndex.get(a) ?? 999) - (groupOrderIndex.get(b) ?? 999)
  );

  const NODE_X_GAP = 195;
  const TIER_Z_GAP = 165;
  const SUBGROUP_GAP = 70;
  const SITE_GAP = 130;

  let currentSiteX = 0;
  const siteCenterMap = new Map<string, number>();

  for (const siteId of orderedSites) {
    const members = siteBuckets.get(siteId)!;
    // Separate site-level shared nodes (e.g. spines directly in site group) vs rack/child-grouped nodes
    const subBuckets = new Map<string, typeof layer0Nodes>();
    for (const m of members) {
      const subKey = m.group && m.group !== siteId ? m.group : '__site_level__';
      if (!subBuckets.has(subKey)) subBuckets.set(subKey, []);
      subBuckets.get(subKey)!.push(m);
    }

    const childGroupKeys = Array.from(subBuckets.keys())
      .filter((k) => k !== '__site_level__')
      .sort((a, b) => (groupOrderIndex.get(a) ?? 999) - (groupOrderIndex.get(b) ?? 999));

    let subCursorX = currentSiteX;
    const childSpans: Array<{ minX: number; maxX: number }> = [];

    for (const cgKey of childGroupKeys) {
      const cgNodes = subBuckets.get(cgKey)!;
      // Group by tier inside child group (e.g. ToR leaves on tier 2, servers on tier 3)
      const byTier = new Map<number, typeof layer0Nodes>();
      for (const n of cgNodes) {
        const t = getRoleTier(n.role, n.type);
        if (!byTier.has(t)) byTier.set(t, []);
        byTier.get(t)!.push(n);
      }
      const maxCols = Math.max(1, ...Array.from(byTier.values()).map((arr) => arr.length));
      const rackWidth = (maxCols - 1) * NODE_X_GAP;
      const rackCenterX = subCursorX + rackWidth / 2;

      for (const [tier, tierNodes] of byTier.entries()) {
        const rowWidth = (tierNodes.length - 1) * NODE_X_GAP;
        const startX = rackCenterX - rowWidth / 2;
        tierNodes.forEach((n, idx) => {
          canonicalCoords.set(n.id, {
            x: n.position?.x ?? startX + idx * NODE_X_GAP,
            z: n.position?.y ?? tier * TIER_Z_GAP,
          });
        });
      }

      childSpans.push({ minX: subCursorX, maxX: subCursorX + rackWidth });
      subCursorX += rackWidth + NODE_X_GAP + SUBGROUP_GAP;
    }

    // Now center site-level nodes (e.g. Spines, Border Routers) above/across the child racks
    const siteLevelNodes = subBuckets.get('__site_level__') ?? [];
    let siteMinX = currentSiteX;
    let siteMaxX = currentSiteX;

    if (childSpans.length > 0) {
      siteMinX = childSpans[0].minX;
      siteMaxX = childSpans[childSpans.length - 1].maxX;
    }

    if (siteLevelNodes.length > 0) {
      const byTier = new Map<number, typeof layer0Nodes>();
      for (const n of siteLevelNodes) {
        const t = getRoleTier(n.role, n.type);
        if (!byTier.has(t)) byTier.set(t, []);
        byTier.get(t)!.push(n);
      }
      const maxSiteCols = Math.max(1, ...Array.from(byTier.values()).map((arr) => arr.length));
      const neededWidth = (maxSiteCols - 1) * NODE_X_GAP;
      if (childSpans.length === 0) {
        siteMaxX = siteMinX + neededWidth;
      }
      const siteCenterX = (siteMinX + siteMaxX) / 2;

      for (const [tier, tierNodes] of byTier.entries()) {
        const rowWidth = (tierNodes.length - 1) * NODE_X_GAP;
        const startX = siteCenterX - rowWidth / 2;
        tierNodes.forEach((n, idx) => {
          const x = n.position?.x ?? startX + idx * NODE_X_GAP;
          canonicalCoords.set(n.id, {
            x,
            z: n.position?.y ?? tier * TIER_Z_GAP,
          });
          siteMinX = Math.min(siteMinX, x);
          siteMaxX = Math.max(siteMaxX, x);
        });
      }
    }

    siteCenterMap.set(siteId, (siteMinX + siteMaxX) / 2);
    currentSiteX = siteMaxX + NODE_X_GAP + SITE_GAP;
  }

  // Center the entire Layer 0 grid around X = 0, Z = 0 for balanced 3D & 2D framing
  if (canonicalCoords.size > 0) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const c of canonicalCoords.values()) {
      minX = Math.min(minX, c.x);
      maxX = Math.max(maxX, c.x);
      minZ = Math.min(minZ, c.z);
      maxZ = Math.max(maxZ, c.z);
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    for (const [nid, c] of canonicalCoords.entries()) {
      const node = config.nodes.find((n) => n.id === nid);
      if (!node?.position) {
        canonicalCoords.set(nid, { x: c.x - cx, z: c.z - cz });
      }
    }
  }

  // Step 2: Anchor upper-layer nodes (Layers 1..N) above their `hostedOn` lower-layer nodes
  for (let lIdx = 1; lIdx < sortedLayers.length; lIdx++) {
    const layer = sortedLayers[lIdx];
    const layerNodes = nodesByLayer.get(layer.id) ?? [];

    // Group siblings in this layer that share the exact same host signature so they fan neatly
    const hostSigGroups = new Map<string, typeof layerNodes>();
    const unhostedInLayer: typeof layerNodes = [];

    for (const n of layerNodes) {
      if (n.position) {
        canonicalCoords.set(n.id, { x: n.position.x, z: n.position.y });
        continue;
      }
      if (n.hostedOn.length > 0) {
        const sig = [...n.hostedOn].sort().join('+');
        if (!hostSigGroups.has(sig)) hostSigGroups.set(sig, []);
        hostSigGroups.get(sig)!.push(n);
      } else {
        unhostedInLayer.push(n);
      }
    }

    for (const siblings of hostSigGroups.values()) {
      const hosts = siblings[0].hostedOn
        .map((hid) => canonicalCoords.get(hid))
        .filter((v): v is { x: number; z: number } => Boolean(v));

      const cx = hosts.length > 0 ? hosts.reduce((s, h) => s + h.x, 0) / hosts.length : 0;
      const cz = hosts.length > 0 ? hosts.reduce((s, h) => s + h.z, 0) / hosts.length : 0;

      const spread = 115;
      siblings.forEach((sib, idx) => {
        const offset = (idx - (siblings.length - 1) / 2) * spread;
        // Slight z stagger when > 2 siblings share one host
        const zStagger = siblings.length > 2 ? ((idx % 2) - 0.5) * 48 : 0;
        canonicalCoords.set(sib.id, { x: cx + offset, z: cz + zStagger });
      });
    }

    // Unhosted overlay nodes (e.g. External Cloud Gateway, Client Ingress VIP)
    if (unhostedInLayer.length > 0) {
      const rowWidth = (unhostedInLayer.length - 1) * NODE_X_GAP;
      unhostedInLayer.forEach((n, idx) => {
        const tier = getRoleTier(n.role, n.type);
        canonicalCoords.set(n.id, {
          x: -rowWidth / 2 + idx * NODE_X_GAP,
          z: (tier - 2.2) * TIER_Z_GAP,
        });
      });
    }
  }

  // Step 3: Map RenderNodes (including collapsed group proxy nodes) to 2D & 3D coordinates
  const activeLayersInFolded = Array.from(new Set(folded.nodes.map((n) => n.layer))).sort(
    (a, b) => (layerIndexMap.get(a) ?? 0) - (layerIndexMap.get(b) ?? 0)
  );
  const visibleLayerRank = new Map<string, number>(
    activeLayersInFolded.map((lid, idx) => [lid, idx])
  );

  // Measure canonical Z span for swimlane band calculation
  let minCanonZ = 0;
  let maxCanonZ = 0;
  for (const c of canonicalCoords.values()) {
    minCanonZ = Math.min(minCanonZ, c.z);
    maxCanonZ = Math.max(maxCanonZ, c.z);
  }
  const singleBandHeight = Math.max(240, (maxCanonZ - minCanonZ) * 0.52 + 170);

  const positions = new Map<string, NodePosition>();

  for (const rn of folded.nodes) {
    let anchorX = 0;
    let anchorZ = 0;

    if (rn.isCollapsedGroup) {
      const memberCoords = rn.memberNodeIds
        .map((mid) => canonicalCoords.get(mid))
        .filter((v): v is { x: number; z: number } => Boolean(v));
      if (memberCoords.length > 0) {
        anchorX = memberCoords.reduce((s, c) => s + c.x, 0) / memberCoords.length;
        anchorZ = memberCoords.reduce((s, c) => s + c.z, 0) / memberCoords.length;
      }
    } else {
      const c = canonicalCoords.get(rn.id);
      if (c) {
        anchorX = c.x;
        anchorZ = c.z;
      }
    }

    let x2d = anchorX;
    let y2d = anchorZ;

    if (mode2D === 'swimlanes' && activeLayersInFolded.length > 1) {
      // Highest overlay at top (negative Y), Physical Layer 0 at bottom (positive Y)
      const rank = visibleLayerRank.get(rn.layer) ?? 0;
      const invertedRank = activeLayersInFolded.length - 1 - rank;
      // Compress intra-layer Z slightly so each horizontal layer band stays distinct
      y2d = invertedRank * singleBandHeight + anchorZ * 0.36;
    } else if (mode2D === 'anchored' && activeLayersInFolded.length > 1) {
      // Subtle vertical card stack offset above host so multi-layer co-located nodes don't occlude
      const lIdx = layerIndexMap.get(rn.layer) ?? 0;
      if (lIdx > 0 && rn.hostedOn.length > 0) {
        y2d = anchorZ - lIdx * 54;
        x2d = anchorX + (lIdx % 2 === 1 ? 18 : -18);
      }
    }

    const manual = manualOverrides.get(rn.id);
    if (manual) {
      x2d = manual.x;
      y2d = manual.y;
    }

    positions.set(rn.id, {
      x: x2d,
      y: y2d,
      anchorX,
      anchorZ,
    });
  }

  // Step 4: Compute bounding boxes for expanded groups (both per-layer pads for 3D/swimlanes & combined for 2D anchored)
  const expandedSortedDesc = [...folded.expandedGroups].sort(
    (a, b) => getGroupDepth(b.id) - getGroupDepth(a.id)
  );

  // Pre-index direct child groups per parent groupId
  const childGroupsByParent = new Map<string, string[]>();
  for (const g of config.groups) {
    if (!g.parent) continue;
    if (!childGroupsByParent.has(g.parent)) childGroupsByParent.set(g.parent, []);
    childGroupsByParent.get(g.parent)!.push(g.id);
  }

  // 4a. Compute per-layer group pads (`layerGroupPads`) so multiple regions/zones render cleanly on any layer!
  const layerGroupPads = new Map<string, GroupBox[]>();
  for (const lid of activeLayersInFolded) {
    const padsForLayer = new Map<string, GroupBox>();
    const layerDirectByGroup = new Map<string, string[]>();

    for (const rn of renderNodeMap.values()) {
      if (rn.layer !== lid || !rn.group) continue;
      if (!layerDirectByGroup.has(rn.group)) layerDirectByGroup.set(rn.group, []);
      layerDirectByGroup.get(rn.group)!.push(rn.id);
    }

    for (const g of expandedSortedDesc) {
      // If group explicitly pins a different layer, skip unless its children have nodes here
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let minAX = Infinity;
      let maxAX = -Infinity;
      let minAZ = Infinity;
      let maxAZ = -Infinity;
      let hasContent = false;

      for (const nid of layerDirectByGroup.get(g.id) ?? []) {
        const pos = positions.get(nid);
        if (!pos) continue;
        hasContent = true;
        minX = Math.min(minX, pos.x - 76);
        maxX = Math.max(maxX, pos.x + 76);
        minY = Math.min(minY, pos.y - 34);
        maxY = Math.max(maxY, pos.y + 34);
        minAX = Math.min(minAX, pos.anchorX - 76);
        maxAX = Math.max(maxAX, pos.anchorX + 76);
        minAZ = Math.min(minAZ, pos.anchorZ - 48);
        maxAZ = Math.max(maxAZ, pos.anchorZ + 48);
      }

      for (const childGid of childGroupsByParent.get(g.id) ?? []) {
        const childBox = padsForLayer.get(childGid);
        if (childBox) {
          hasContent = true;
          minX = Math.min(minX, childBox.x);
          maxX = Math.max(maxX, childBox.x + childBox.width);
          minY = Math.min(minY, childBox.y);
          maxY = Math.max(maxY, childBox.y + childBox.height);
          minAX = Math.min(minAX, childBox.anchorMinX);
          maxAX = Math.max(maxAX, childBox.anchorMaxX);
          minAZ = Math.min(minAZ, childBox.anchorMinZ);
          maxAZ = Math.max(maxAZ, childBox.anchorMaxZ);
        }
      }

      if (!hasContent) continue;

      const depth = getGroupDepth(g.id);
      const padX = depth === 0 ? 30 : 20;
      const padTop = depth === 0 ? 36 : 28;
      const padBottom = depth === 0 ? 24 : 18;

      padsForLayer.set(g.id, {
        key: `${lid}::${g.id}`,
        group: g,
        layerId: lid,
        x: minX - padX,
        y: minY - padTop,
        width: maxX - minX + padX * 2,
        height: maxY - minY + padTop + padBottom,
        anchorMinX: minAX - padX,
        anchorMaxX: maxAX + padX,
        anchorMinZ: minAZ - padBottom,
        anchorMaxZ: maxAZ + padTop,
        depth,
      });
    }

    layerGroupPads.set(
      lid,
      Array.from(padsForLayer.values()).sort((a, b) => a.depth - b.depth)
    );
  }

  // 4b. For 2D: in `swimlanes` mode use per-layer boxes so multi-layer regions stay neatly inside each swimlane;
  // in `anchored` mode combine across layers so a region wraps its whole vertical hardware+VM stack.
  let groupBoxes: GroupBox[] = [];
  if (mode2D === 'swimlanes') {
    groupBoxes = Array.from(layerGroupPads.values())
      .flat()
      .sort((a, b) => a.depth - b.depth);
  } else {
    const combinedMap = new Map<string, GroupBox>();
    const directNodesByGroup = new Map<string, string[]>();
    for (const rn of renderNodeMap.values()) {
      if (!rn.group) continue;
      if (!directNodesByGroup.has(rn.group)) directNodesByGroup.set(rn.group, []);
      directNodesByGroup.get(rn.group)!.push(rn.id);
    }

    for (const g of expandedSortedDesc) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let minAX = Infinity;
      let maxAX = -Infinity;
      let minAZ = Infinity;
      let maxAZ = -Infinity;
      let hasContent = false;

      for (const nid of directNodesByGroup.get(g.id) ?? []) {
        const pos = positions.get(nid);
        if (!pos) continue;
        hasContent = true;
        minX = Math.min(minX, pos.x - 76);
        maxX = Math.max(maxX, pos.x + 76);
        minY = Math.min(minY, pos.y - 36);
        maxY = Math.max(maxY, pos.y + 36);
        minAX = Math.min(minAX, pos.anchorX - 76);
        maxAX = Math.max(maxAX, pos.anchorX + 76);
        minAZ = Math.min(minAZ, pos.anchorZ - 48);
        maxAZ = Math.max(maxAZ, pos.anchorZ + 48);
      }

      for (const childGid of childGroupsByParent.get(g.id) ?? []) {
        const childBox = combinedMap.get(childGid);
        if (childBox) {
          hasContent = true;
          minX = Math.min(minX, childBox.x);
          maxX = Math.max(maxX, childBox.x + childBox.width);
          minY = Math.min(minY, childBox.y);
          maxY = Math.max(maxY, childBox.y + childBox.height);
          minAX = Math.min(minAX, childBox.anchorMinX);
          maxAX = Math.max(maxAX, childBox.anchorMaxX);
          minAZ = Math.min(minAZ, childBox.anchorMinZ);
          maxAZ = Math.max(maxAZ, childBox.anchorMaxZ);
        }
      }

      if (!hasContent) continue;

      const depth = getGroupDepth(g.id);
      const padX = depth === 0 ? 34 : 22;
      const padTop = depth === 0 ? 40 : 32;
      const padBottom = depth === 0 ? 28 : 20;

      combinedMap.set(g.id, {
        key: g.id,
        group: g,
        x: minX - padX,
        y: minY - padTop,
        width: maxX - minX + padX * 2,
        height: maxY - minY + padTop + padBottom,
        anchorMinX: minAX - padX,
        anchorMaxX: maxAX + padX,
        anchorMinZ: minAZ - padBottom,
        anchorMaxZ: maxAZ + padTop,
        depth,
      });
    }

    groupBoxes = Array.from(combinedMap.values()).sort((a, b) => a.depth - b.depth);
  }

  return { positions, groupBoxes, layerGroupPads };
}
