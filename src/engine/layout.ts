import type { GroupSpec, NetworkConfig, NodeSpec } from '../schema/types';
import type { FoldedGraph, RenderLink, RenderNode } from './grouping';

export type Layout2DMode = 'swimlanes' | 'anchored';

export interface NodePosition {
  x: number;
  y: number;
  /** Canonical horizontal/depth coordinates used on 3D planes */
  anchorX: number;
  anchorZ: number;
  subRow: number;
  width: number;
  height: number;
}

export interface GroupBox {
  key: string;
  group: GroupSpec;
  layerId?: string;
  subRow?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  anchorMinX: number;
  anchorMaxX: number;
  anchorMinZ: number;
  anchorMaxZ: number;
  depth: number;
}

export interface LinkRoute {
  linkId: string;
  sameRow: boolean;
  /** 0 = direct horizontal neighbor line; +1,-1,+2,-2... = non-overlapping arc track */
  arcTrack: number;
  /** Port stagger offset in pixels when multiple arcs exit the same node side */
  sourcePortOffset: number;
  targetPortOffset: number;
}

export interface ComputedLayout {
  positions: Map<string, NodePosition>;
  groupBoxes: GroupBox[];
  layerGroupPads: Map<string, GroupBox[]>;
  linkRoutes: Map<string, LinkRoute>;
}

const NODE_W = 144;
const NODE_H = 48;
const COLLAPSED_W = 158;
const COLLAPSED_H = 54;
const MIN_NODE_GAP_X = 46; // >= 46px clear space between adjacent node cards
const GROUP_PAD_X_OUTER = 30;
const GROUP_PAD_X_INNER = 20;
const GROUP_PAD_TOP_OUTER = 38;
const GROUP_PAD_TOP_INNER = 30;
const GROUP_PAD_BOT_OUTER = 24;
const GROUP_PAD_BOT_INNER = 18;
const GROUP_GAP_X = 38; // >= 38px clear space between sibling group boxes
const SUBROW_STEP_Y = 168; // vertical step between sub-rows inside a layer
const SUBROW_STEP_Z = 156; // depth step between sub-rows on a 3D plane

/**
 * Orders items into a 1D horizontal sequence so strongly connected items are placed adjacent
 * to one another, minimizing skip-links and line overlaps.
 */
function buildConnectedChainOrder(
  ids: string[],
  weights: Map<string, Map<string, number>>,
  fallbackRank: Map<string, number>
): string[] {
  if (ids.length <= 2) {
    return [...ids].sort((a, b) => (fallbackRank.get(a) ?? 0) - (fallbackRank.get(b) ?? 0));
  }

  const getW = (a: string, b: string) => weights.get(a)?.get(b) ?? 0;

  // Compute restricted degree within `ids`
  const totalWeight = new Map<string, number>();
  const degree = new Map<string, number>();
  for (const id of ids) {
    let wSum = 0;
    let deg = 0;
    for (const other of ids) {
      if (id === other) continue;
      const w = getW(id, other);
      if (w > 0) {
        wSum += w;
        deg++;
      }
    }
    totalWeight.set(id, wSum);
    degree.set(id, deg);
  }

  const remaining = new Set(ids);
  const result: string[] = [];

  while (remaining.size > 0) {
    // Pick a peripheral connected node (degree 1 or lowest positive degree) to start a chain segment
    const remArr = Array.from(remaining);
    remArr.sort((a, b) => {
      const da = degree.get(a) ?? 0;
      const db = degree.get(b) ?? 0;
      if (da > 0 && db === 0) return -1;
      if (db > 0 && da === 0) return 1;
      if (da !== db) return da - db;
      const wa = totalWeight.get(a) ?? 0;
      const wb = totalWeight.get(b) ?? 0;
      if (wa !== wb) return wa - wb;
      return (fallbackRank.get(a) ?? 0) - (fallbackRank.get(b) ?? 0);
    });

    const chain: string[] = [remArr[0]];
    remaining.delete(remArr[0]);

    // Grow chain at both ends greedily toward strongest connected neighbor
    let grew = true;
    while (grew && remaining.size > 0) {
      grew = false;
      const leftEnd = chain[0];
      const rightEnd = chain[chain.length - 1];

      let bestCand: string | null = null;
      let bestSide: 'left' | 'right' = 'right';
      let bestScore = 0;

      for (const cand of remaining) {
        const wRight = getW(rightEnd, cand);
        if (wRight > bestScore) {
          bestScore = wRight;
          bestCand = cand;
          bestSide = 'right';
        }
        const wLeft = getW(leftEnd, cand);
        if (wLeft > bestScore) {
          bestScore = wLeft;
          bestCand = cand;
          bestSide = 'left';
        }
      }

      if (bestCand && bestScore > 0) {
        if (bestSide === 'right') chain.push(bestCand);
        else chain.unshift(bestCand);
        remaining.delete(bestCand);
        grew = true;
      }
    }

    // Orient chain consistently using fallback declaration order
    if (
      chain.length > 1 &&
      (fallbackRank.get(chain[0]) ?? 0) > (fallbackRank.get(chain[chain.length - 1]) ?? 0)
    ) {
      chain.reverse();
    }
    result.push(...chain);
  }

  return result;
}

/**
 * Minimum-displacement 1D separation solver (VPSC block pooling):
 * Given desired coordinates `d[0..n-1]` and required minimum separations `gap[0..n-2]`
 * such that `x[i+1] - x[i] >= gap[i]`, finds `x` minimizing `sum((x[i] - d[i])^2)`.
 */
function solve1DSeparation(desired: number[], minGaps: number[]): number[] {
  const n = desired.length;
  if (n === 0) return [];
  if (n === 1) return [desired[0]];

  // Convert to standard monotonic regression `y[i] <= y[i+1]` via prefix offsets
  const prefix = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    prefix[i] = prefix[i - 1] + minGaps[i - 1];
  }

  interface Block {
    start: number;
    end: number;
    sumVal: number;
    count: number;
  }

  const blocks: Block[] = [];
  for (let i = 0; i < n; i++) {
    const targetY = desired[i] - prefix[i];
    blocks.push({ start: i, end: i, sumVal: targetY, count: 1 });

    while (blocks.length >= 2) {
      const b2 = blocks[blocks.length - 1];
      const b1 = blocks[blocks.length - 2];
      if (b1.sumVal / b1.count > b2.sumVal / b2.count) {
        b1.end = b2.end;
        b1.sumVal += b2.sumVal;
        b1.count += b2.count;
        blocks.pop();
      } else {
        break;
      }
    }
  }

  const out = new Array<number>(n);
  for (const b of blocks) {
    const mean = b.sumVal / b.count;
    for (let i = b.start; i <= b.end; i++) {
      out[i] = mean + prefix[i];
    }
  }
  return out;
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
  const nodeMap = new Map<string, NodeSpec>(config.nodes.map((n) => [n.id, n]));

  const groupDeclRank = new Map<string, number>();
  config.groups.forEach((g, idx) => groupDeclRank.set(g.id, idx));
  groupDeclRank.set('__ungrouped__', 9999);

  const nodeDeclRank = new Map<string, number>();
  config.nodes.forEach((n, idx) => nodeDeclRank.set(n.id, idx));

  const getGroupChain = (gid?: string): string[] => {
    if (!gid) return [];
    const chain: string[] = [];
    let curr: string | undefined = gid;
    const seen = new Set<string>();
    while (curr && !seen.has(curr) && groupMap.has(curr)) {
      seen.add(curr);
      chain.unshift(curr); // [rootGroup, ..., leafGroup]
      curr = groupMap.get(curr)?.parent;
    }
    return chain;
  };

  const getGroupDepth = (gid: string): number => Math.max(0, getGroupChain(gid).length - 1);
  const getRootGroup = (gid?: string): string => getGroupChain(gid)[0] ?? '__ungrouped__';

  // Build transitive downward ancestors for each config node
  const ancestorsMap = new Map<string, string[]>();
  const nodesByLayer = new Map<string, NodeSpec[]>();
  for (const l of sortedLayers) nodesByLayer.set(l.id, []);
  for (const n of config.nodes) nodesByLayer.get(n.layer)?.push(n);

  for (const l of sortedLayers) {
    for (const n of nodesByLayer.get(l.id) ?? []) {
      const anc: string[] = [];
      for (const h of n.hostedOn) {
        if (!anc.includes(h)) anc.push(h);
        for (const ha of ancestorsMap.get(h) ?? []) {
          if (!anc.includes(ha)) anc.push(ha);
        }
      }
      ancestorsMap.set(n.id, anc);
    }
  }

  // Build node-to-node adjacency weights (direct links + projected upper-layer links down to hosts)
  const nodeConnWeights = new Map<string, Map<string, number>>();
  const addPairWeight = (
    map: Map<string, Map<string, number>>,
    a: string,
    b: string,
    w: number
  ) => {
    if (a === b) return;
    if (!map.has(a)) map.set(a, new Map());
    if (!map.has(b)) map.set(b, new Map());
    map.get(a)!.set(b, (map.get(a)!.get(b) ?? 0) + w);
    map.get(b)!.set(a, (map.get(b)!.get(a) ?? 0) + w);
  };

  for (const lk of config.links) {
    addPairWeight(nodeConnWeights, lk.source, lk.target, 4);
    const sAll = [lk.source, ...(ancestorsMap.get(lk.source) ?? [])];
    const tAll = [lk.target, ...(ancestorsMap.get(lk.target) ?? [])];
    for (const sa of sAll) {
      for (const ta of tAll) {
        if (nodeMap.get(sa)?.layer === nodeMap.get(ta)?.layer) {
          addPairWeight(nodeConnWeights, sa, ta, 1.5);
        }
      }
    }
  }

  // Compute primary hosting parent (`primaryHost`) & tower weights so 1-to-many trees reserve exact columns
  const primaryChildren = new Map<string, NodeSpec[]>();
  const towerWeight = new Map<string, number>();

  for (let lIdx = sortedLayers.length - 1; lIdx >= 0; lIdx--) {
    const layer = sortedLayers[lIdx];
    for (const n of nodesByLayer.get(layer.id) ?? []) {
      const myKids = primaryChildren.get(n.id) ?? [];
      const w = 1 + myKids.reduce((s, k) => s + (towerWeight.get(k.id) ?? 1), 0);
      towerWeight.set(n.id, w);

      if (n.hostedOn.length > 0) {
        // Pick primary host: first listed host in the closest lower layer
        const sortedHosts = [...n.hostedOn].sort(
          (a, b) =>
            (layerIndexMap.get(nodeMap.get(b)?.layer ?? '') ?? 0) -
            (layerIndexMap.get(nodeMap.get(a)?.layer ?? '') ?? 0)
        );
        const pHost = sortedHosts[0];
        if (pHost) {
          if (!primaryChildren.has(pHost)) primaryChildren.set(pHost, []);
          primaryChildren.get(pHost)!.push(n);
        }
      }
    }
  }

  // Compute required horizontal slot count (`slotSpan`) per node from top layer down to bottom
  const slotSpan = new Map<string, number>();
  for (let lIdx = sortedLayers.length - 1; lIdx >= 0; lIdx--) {
    const layer = sortedLayers[lIdx];
    for (const n of nodesByLayer.get(layer.id) ?? []) {
      const kids = primaryChildren.get(n.id) ?? [];
      if (kids.length === 0) {
        slotSpan.set(n.id, 1);
      } else {
        // Group kids by their layer; parallel siblings in the same layer add widths, serial layers take max
        const byKidLayer = new Map<string, NodeSpec[]>();
        for (const k of kids) {
          if (!byKidLayer.has(k.layer)) byKidLayer.set(k.layer, []);
          byKidLayer.get(k.layer)!.push(k);
        }
        let maxLayerSlots = 1;
        for (const layerKids of byKidLayer.values()) {
          const sumSlots = layerKids.reduce((s, k) => s + (slotSpan.get(k.id) ?? 1), 0);
          maxLayerSlots = Math.max(maxLayerSlots, sumSlots);
        }
        slotSpan.set(n.id, maxLayerSlots);
      }
    }
  }

  // Step 1: Lay out Layer 0 horizontally by Root Group -> Child Group -> Connected Horizontal Chain!
  const bottomLayer = sortedLayers[0];
  const layer0Nodes = nodesByLayer.get(bottomLayer.id) ?? [];

  // Build root-group connectivity weights across all layers
  const rootGroupWeights = new Map<string, Map<string, number>>();
  for (const [u, nbrs] of nodeConnWeights.entries()) {
    const gu = getRootGroup(nodeMap.get(u)?.group);
    if (gu === '__ungrouped__') continue;
    for (const [v, w] of nbrs.entries()) {
      const gv = getRootGroup(nodeMap.get(v)?.group);
      if (gv === '__ungrouped__' || gu === gv) continue;
      addPairWeight(rootGroupWeights, gu, gv, w);
    }
  }

  const siteBuckets = new Map<string, NodeSpec[]>();
  for (const n of layer0Nodes) {
    const rg = getRootGroup(n.group);
    if (!siteBuckets.has(rg)) siteBuckets.set(rg, []);
    siteBuckets.get(rg)!.push(n);
  }

  const orderedSites = buildConnectedChainOrder(
    Array.from(siteBuckets.keys()),
    rootGroupWeights,
    groupDeclRank
  );

  const canonicalX = new Map<string, number>();
  const BASE_STEP = NODE_W + MIN_NODE_GAP_X; // 190px per slot

  let cursorX = 0;

  for (const siteId of orderedSites) {
    const members = siteBuckets.get(siteId)!;
    if (siteId !== '__ungrouped__') cursorX += GROUP_PAD_X_OUTER;

    // Partition into child subgroups vs direct site-level nodes
    const subBuckets = new Map<string, NodeSpec[]>();
    for (const m of members) {
      const chain = getGroupChain(m.group);
      const subKey = chain.length >= 2 ? chain[1] : `__direct__:${m.id}`;
      if (!subBuckets.has(subKey)) subBuckets.set(subKey, []);
      subBuckets.get(subKey)!.push(m);
    }

    // Build adjacency between sub-items inside this site so connected racks & switches sit adjacent!
    const subItemWeights = new Map<string, Map<string, number>>();
    const subItemRank = new Map<string, number>();
    const subKeys = Array.from(subBuckets.keys());

    subKeys.forEach((sk) => {
      const list = subBuckets.get(sk)!;
      const r = sk.startsWith('__direct__:')
        ? (nodeDeclRank.get(list[0].id) ?? 0) + 100
        : (groupDeclRank.get(sk) ?? 0);
      subItemRank.set(sk, r);
    });

    for (let i = 0; i < subKeys.length; i++) {
      for (let j = i + 1; j < subKeys.length; j++) {
        const ka = subKeys[i];
        const kb = subKeys[j];
        let w = 0;
        for (const na of subBuckets.get(ka)!) {
          for (const nb of subBuckets.get(kb)!) {
            w += nodeConnWeights.get(na.id)?.get(nb.id) ?? 0;
          }
        }
        if (w > 0) addPairWeight(subItemWeights, ka, kb, w);
      }
    }

    const orderedSubKeys = buildConnectedChainOrder(subKeys, subItemWeights, subItemRank);

    // Count direct site-level nodes that host 0 upper children so multi-child hosts in the same site
    // can share those empty upper columns instead of over-widening Layer 0 relative to Layer 1!
    let spareUnhostedPartnerSlots = members.filter(
      (m) => (primaryChildren.get(m.id)?.length ?? 0) === 0
    ).length;

    orderedSubKeys.forEach((sk, subIdx) => {
      const isChildGroup = !sk.startsWith('__direct__:');
      if (isChildGroup) cursorX += GROUP_PAD_X_INNER;

      const orderedNodes = buildConnectedChainOrder(
        subBuckets.get(sk)!.map((n) => n.id),
        nodeConnWeights,
        nodeDeclRank
      );

      orderedNodes.forEach((nid) => {
        const nSpec = nodeMap.get(nid)!;
        let spanSlots = slotSpan.get(nid) ?? 1;
        if (!isChildGroup && spanSlots > 1 && spareUnhostedPartnerSlots > 0) {
          const shared = Math.min(spanSlots - 1, spareUnhostedPartnerSlots);
          spanSlots -= shared;
          spareUnhostedPartnerSlots -= shared;
        }
        const widthPx = spanSlots * BASE_STEP;
        const center = cursorX + widthPx / 2;
        canonicalX.set(nid, nSpec.position?.x ?? center);
        cursorX += widthPx;
      });

      if (isChildGroup) cursorX += GROUP_PAD_X_INNER;
      if (subIdx < orderedSubKeys.length - 1) {
        cursorX += isChildGroup ? GROUP_GAP_X * 0.7 : 0;
      }
    });

    if (siteId !== '__ungrouped__') cursorX += GROUP_PAD_X_OUTER;
    cursorX += GROUP_GAP_X;
  }

  // Center Layer 0 around X = 0
  if (canonicalX.size > 0) {
    const vals = Array.from(canonicalX.values());
    const mid = (Math.min(...vals) + Math.max(...vals)) / 2;
    for (const [nid, x] of canonicalX.entries()) {
      if (!nodeMap.get(nid)?.position) {
        canonicalX.set(nid, x - mid);
      }
    }
  }

  // Compute group affinity across layers so unhosted groups align vertically with their most related group
  const computeLayerGroupCenter = (gid: string, upToLayerIdx: number): number | null => {
    const xs: number[] = [];
    for (let i = 0; i <= upToLayerIdx; i++) {
      for (const n of nodesByLayer.get(sortedLayers[i].id) ?? []) {
        if (n.group === gid || getRootGroup(n.group) === gid) {
          const x = canonicalX.get(n.id);
          if (x !== undefined) xs.push(x);
        }
      }
    }
    if (xs.length === 0) return null;
    return xs.reduce((s, v) => s + v, 0) / xs.length;
  };

  // Step 2: Propagate Vertical Node Alignment (`canonicalX`) upward through Layers 1..N!
  for (let lIdx = 1; lIdx < sortedLayers.length; lIdx++) {
    const layer = sortedLayers[lIdx];
    const layerNodes = nodesByLayer.get(layer.id) ?? [];

    // Group hosted nodes by their primary lower-layer host
    const byPrimaryHost = new Map<string, NodeSpec[]>();
    const remainingNodes: NodeSpec[] = [];

    for (const n of layerNodes) {
      if (n.position) {
        canonicalX.set(n.id, n.position.x);
        continue;
      }
      if (n.hostedOn.length > 0) {
        const sortedHosts = [...n.hostedOn].sort(
          (a, b) =>
            (layerIndexMap.get(nodeMap.get(b)?.layer ?? '') ?? 0) -
            (layerIndexMap.get(nodeMap.get(a)?.layer ?? '') ?? 0)
        );
        const pHost = sortedHosts[0];
        if (pHost && canonicalX.has(pHost)) {
          if (!byPrimaryHost.has(pHost)) byPrimaryHost.set(pHost, []);
          byPrimaryHost.get(pHost)!.push(n);
          continue;
        }
      }
      remainingNodes.push(n);
    }

    for (const [hostId, siblings] of byPrimaryHost.entries()) {
      const hostX = canonicalX.get(hostId) ?? 0;
      if (siblings.length === 1) {
        // 1-to-1 vertical alignment: exact same X!
        canonicalX.set(siblings[0].id, hostX);
      } else {
        // Order co-hosted siblings horizontally by connected chain & external neighbor pull!
        const orderedSibIds = buildConnectedChainOrder(
          siblings.map((s) => s.id),
          nodeConnWeights,
          nodeDeclRank
        );

        // Orient left vs right sibling toward whichever external side they connect to more strongly!
        if (orderedSibIds.length >= 2) {
          const scoreSide = (nid: string): number => {
            let pull = 0;
            let count = 0;
            for (const [nbr, w] of nodeConnWeights.get(nid) ?? []) {
              const nx = canonicalX.get(nbr);
              if (nx !== undefined && Math.abs(nx - hostX) > 20) {
                pull += (nx - hostX) * w;
                count += w;
              }
            }
            return count > 0 ? pull / count : 0;
          };
          if (scoreSide(orderedSibIds[0]) > scoreSide(orderedSibIds[orderedSibIds.length - 1])) {
            orderedSibIds.reverse();
          }
        }

        // Check if one sibling has a strictly taller cross-layer tower (most related node to host!)
        const weights = orderedSibIds.map((id) => towerWeight.get(id) ?? 1);
        const maxW = Math.max(...weights);
        const maxCount = weights.filter((w) => w === maxW).length;

        const spans = orderedSibIds.map((id) => (slotSpan.get(id) ?? 1) * BASE_STEP);
        const totalSpan = spans.reduce((s, v) => s + v, 0);

        if (maxCount === 1) {
          // Align the single most-related child directly at `hostX` (0px vertical offset!)
          // and place secondary sibling(s) horizontally next to it.
          const domIdx = weights.indexOf(maxW);
          const prefixBeforeDom = spans.slice(0, domIdx).reduce((s, v) => s + v, 0);
          let cur = hostX - prefixBeforeDom - spans[domIdx] / 2;
          orderedSibIds.forEach((id, idx) => {
            canonicalX.set(id, cur + spans[idx] / 2);
            cur += spans[idx];
          });
        } else {
          // Equal-weight siblings (e.g. dual VMs on same ESXi host): center symmetrically above host
          let cur = hostX - totalSpan / 2;
          orderedSibIds.forEach((id, idx) => {
            canonicalX.set(id, cur + spans[idx] / 2);
            cur += spans[idx];
          });
        }
      }
    }

    // Place any unhosted nodes on this layer aligned with their most related group or connected neighbors
    if (remainingNodes.length > 0) {
      const orderedRem = buildConnectedChainOrder(
        remainingNodes.map((n) => n.id),
        nodeConnWeights,
        nodeDeclRank
      );
      orderedRem.forEach((nid, idx) => {
        const n = nodeMap.get(nid)!;
        const grpCenter = n.group ? computeLayerGroupCenter(n.group, lIdx - 1) : null;
        if (grpCenter !== null) {
          canonicalX.set(nid, grpCenter + (idx - (orderedRem.length - 1) / 2) * BASE_STEP);
        } else {
          // Average X of already-placed neighbors
          const nbrXs: number[] = [];
          for (const [nbr] of nodeConnWeights.get(nid) ?? []) {
            const nx = canonicalX.get(nbr);
            if (nx !== undefined) nbrXs.push(nx);
          }
          const base =
            nbrXs.length > 0
              ? nbrXs.reduce((s, v) => s + v, 0) / nbrXs.length
              : (idx - (orderedRem.length - 1) / 2) * BASE_STEP;
          canonicalX.set(nid, base);
        }
      });
    }
  }

  // Step 3: Map Folded RenderNodes, Assign Non-Overlapping Group SubRows & Run Exact 1D Separation Solver!
  const renderNodeMap = new Map<string, RenderNode>(folded.nodes.map((n) => [n.id, n]));
  const desiredRenderX = new Map<string, number>();

  for (const rn of folded.nodes) {
    if (rn.isCollapsedGroup) {
      const xs = rn.memberNodeIds
        .map((mid) => canonicalX.get(mid))
        .filter((v): v is number => v !== undefined);
      desiredRenderX.set(
        rn.id,
        xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : 0
      );
    } else {
      desiredRenderX.set(rn.id, canonicalX.get(rn.id) ?? 0);
    }
  }

  const activeLayersInFolded = Array.from(new Set(folded.nodes.map((n) => n.layer))).sort(
    (a, b) => (layerIndexMap.get(a) ?? 0) - (layerIndexMap.get(b) ?? 0)
  );

  const solvedXMap = new Map<string, number>();
  const subRowMap = new Map<string, number>();
  const layerSubRowCount = new Map<string, number>();

  for (const lid of activeLayersInFolded) {
    const rNodes = folded.nodes.filter((n) => n.layer === lid);
    if (rNodes.length === 0) continue;

    // Group nodes by their outermost expanded group on this layer
    const byRootGrp = new Map<string, RenderNode[]>();
    const ungroupedNodes: RenderNode[] = [];

    for (const rn of rNodes) {
      const chain = getGroupChain(rn.group).filter((gid) =>
        folded.expandedGroups.some((eg) => eg.id === gid)
      );
      if (chain.length > 0) {
        const outerGid = chain[0];
        if (!byRootGrp.has(outerGid)) byRootGrp.set(outerGid, []);
        byRootGrp.get(outerGid)!.push(rn);
      } else {
        ungroupedNodes.push(rn);
      }
    }

    // Compute desired [minX, maxX] interval for each outermost group on this layer
    interface GroupSpan {
      gid: string;
      nodes: RenderNode[];
      minX: number;
      maxX: number;
      centerX: number;
      subRow: number;
    }

    const groupSpans: GroupSpan[] = Array.from(byRootGrp.entries()).map(([gid, list]) => {
      const xs = list.map((n) => desiredRenderX.get(n.id) ?? 0);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      return {
        gid,
        nodes: list,
        minX,
        maxX,
        centerX: (minX + maxX) / 2,
        subRow: 0,
      };
    });

    groupSpans.sort((a, b) => a.centerX - b.centerX);

    // Detect interleaved X-spans among groups on this layer:
    // If two groups truly overlap across shared columns (overlap > 0.65 * BASE_STEP), assign distinct subRows
    // so both groups stay vertically aligned with their hosts below AND have 0% bounding-box overlap!
    const rowIntervals: Array<Array<{ min: number; max: number }>> = [];
    for (const gs of groupSpans) {
      let assignedRow = -1;
      for (let r = 0; r < rowIntervals.length; r++) {
        const hasInterleave = rowIntervals[r].some((iv) => {
          const overlap = Math.min(iv.max, gs.maxX) - Math.max(iv.min, gs.minX);
          return overlap > BASE_STEP * 0.55;
        });
        if (!hasInterleave) {
          assignedRow = r;
          rowIntervals[r].push({ min: gs.minX, max: gs.maxX });
          break;
        }
      }
      if (assignedRow === -1) {
        assignedRow = rowIntervals.length;
        rowIntervals.push([{ min: gs.minX, max: gs.maxX }]);
      }
      gs.subRow = assignedRow;
      for (const n of gs.nodes) subRowMap.set(n.id, assignedRow);
    }

    // Assign ungrouped nodes to subRow 0 unless their desiredX falls strictly inside a group's span on subRow 0
    for (const un of ungroupedNodes) {
      const ux = desiredRenderX.get(un.id) ?? 0;
      let targetRow = 0;
      while (targetRow < rowIntervals.length) {
        const enclosed = groupSpans.some(
          (gs) =>
            gs.subRow === targetRow &&
            gs.nodes.length >= 2 &&
            ux > gs.minX - 40 &&
            ux < gs.maxX + 40
        );
        if (!enclosed) break;
        targetRow++;
      }
      if (targetRow >= rowIntervals.length && rowIntervals.length > 0 && ungroupedNodes.length > 0) {
        // Check if placing on a new subRow avoids piercing a multi-node group box
        const pierces = groupSpans.some(
          (gs) =>
            gs.subRow === 0 && gs.nodes.length >= 2 && ux > gs.minX - 20 && ux < gs.maxX + 20
        );
        subRowMap.set(un.id, pierces ? targetRow : 0);
      } else {
        subRowMap.set(un.id, targetRow);
      }
    }

    const maxRow = Math.max(0, ...rNodes.map((n) => subRowMap.get(n.id) ?? 0));
    layerSubRowCount.set(lid, maxRow + 1);

    // Solve exact 1D non-overlapping X coordinates per subRow!
    for (let r = 0; r <= maxRow; r++) {
      const rowNodes = rNodes.filter((n) => (subRowMap.get(n.id) ?? 0) === r);
      if (rowNodes.length === 0) continue;

      // Sort nodes respecting contiguous group & child-group blocks, then desiredX!
      const getNodeGroupKey = (rn: RenderNode) =>
        getGroupChain(rn.group).filter((gid) =>
          folded.expandedGroups.some((eg) => eg.id === gid)
        );

      // Compute center X per group on this row for contiguous ordering
      const grpCenterOnRow = new Map<string, number>();
      for (const gid of config.groups.map((g) => g.id)) {
        const members = rowNodes.filter((rn) => getNodeGroupKey(rn).includes(gid));
        if (members.length > 0) {
          grpCenterOnRow.set(
            gid,
            members.reduce((s, m) => s + (desiredRenderX.get(m.id) ?? 0), 0) / members.length
          );
        }
      }

      rowNodes.sort((a, b) => {
        const ca = getNodeGroupKey(a);
        const cb = getNodeGroupKey(b);
        // If in different root groups (or one ungrouped), compare root group center / node desiredX
        const rootA = ca[0];
        const rootB = cb[0];
        if (rootA !== rootB) {
          const xa = rootA ? grpCenterOnRow.get(rootA)! : desiredRenderX.get(a.id)!;
          const xb = rootB ? grpCenterOnRow.get(rootB)! : desiredRenderX.get(b.id)!;
          if (Math.abs(xa - xb) > 0.01) return xa - xb;
        }
        // Same root group: compare child group if different
        const subA = ca[1];
        const subB = cb[1];
        if (subA !== subB) {
          const xa = subA ? grpCenterOnRow.get(subA)! : desiredRenderX.get(a.id)!;
          const xb = subB ? grpCenterOnRow.get(subB)! : desiredRenderX.get(b.id)!;
          if (Math.abs(xa - xb) > 0.01) return xa - xb;
        }
        const dDiff = (desiredRenderX.get(a.id) ?? 0) - (desiredRenderX.get(b.id) ?? 0);
        if (Math.abs(dDiff) > 0.01) return dDiff;
        return a.id.localeCompare(b.id);
      });

      const desiredArr = rowNodes.map((n) => desiredRenderX.get(n.id) ?? 0);
      const minGaps: number[] = [];

      for (let i = 0; i < rowNodes.length - 1; i++) {
        const leftN = rowNodes[i];
        const rightN = rowNodes[i + 1];
        const leftW = leftN.isCollapsedGroup ? COLLAPSED_W : NODE_W;
        const rightW = rightN.isCollapsedGroup ? COLLAPSED_W : NODE_W;

        const chainL = getNodeGroupKey(leftN);
        const chainR = getNodeGroupKey(rightN);

        // Count group borders closing after `leftN` and opening before `rightN`
        let closingPad = 0;
        for (let d = 0; d < chainL.length; d++) {
          if (chainR[d] !== chainL[d]) {
            closingPad += d === 0 ? GROUP_PAD_X_OUTER : GROUP_PAD_X_INNER;
          }
        }
        let openingPad = 0;
        for (let d = 0; d < chainR.length; d++) {
          if (chainL[d] !== chainR[d]) {
            openingPad += d === 0 ? GROUP_PAD_X_OUTER : GROUP_PAD_X_INNER;
          }
        }

        const boundaryGap =
          closingPad > 0 || openingPad > 0 ? closingPad + openingPad + GROUP_GAP_X : MIN_NODE_GAP_X;

        minGaps.push((leftW + rightW) / 2 + boundaryGap);
      }

      const solved = solve1DSeparation(desiredArr, minGaps);
      rowNodes.forEach((rn, idx) => {
        solvedXMap.set(rn.id, solved[idx]);
      });
    }
  }

  // Step 4: Allocate Non-Overlapping Arc Tracks for Intra-Row Connecting Lines!
  const linkRoutes = new Map<string, LinkRoute>();
  const rowMaxPosTrack = new Map<string, number>();
  const rowMaxNegTrack = new Map<string, number>();

  // Group links by `(layer, subRow)` when both endpoints sit on the same layer & subRow
  const sameRowBuckets = new Map<string, RenderLink[]>();
  for (const rl of folded.links) {
    const nSrc = renderNodeMap.get(rl.source);
    const nTgt = renderNodeMap.get(rl.target);
    if (!nSrc || !nTgt) continue;

    const srSrc = subRowMap.get(rl.source) ?? 0;
    const srTgt = subRowMap.get(rl.target) ?? 0;

    if (nSrc.layer === nTgt.layer && srSrc === srTgt) {
      const key = `${nSrc.layer}::${srSrc}`;
      if (!sameRowBuckets.has(key)) sameRowBuckets.set(key, []);
      sameRowBuckets.get(key)!.push(rl);
    } else {
      // Inter-row or inter-layer link
      const offset =
        rl.parallelCount > 1 ? (rl.parallelIndex - (rl.parallelCount - 1) / 2) : 0;
      linkRoutes.set(rl.id, {
        linkId: rl.id,
        sameRow: false,
        arcTrack: offset,
        sourcePortOffset: offset * 12,
        targetPortOffset: offset * 12,
      });
    }
  }

  for (const [rowKey, rLinks] of sameRowBuckets.entries()) {
    const [lid, srStr] = rowKey.split('::');
    const sr = Number(srStr);
    const rowNodes = folded.nodes.filter(
      (n) => n.layer === lid && (subRowMap.get(n.id) ?? 0) === sr
    );

    const needsArc: Array<{ rl: RenderLink; minX: number; maxX: number; span: number }> = [];

    for (const rl of rLinks) {
      const x1 = solvedXMap.get(rl.source) ?? 0;
      const x2 = solvedXMap.get(rl.target) ?? 0;
      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);

      // Count intermediate nodes strictly between minX and maxX on this same row
      const hasIntermediateNode = rowNodes.some((rn) => {
        if (rn.id === rl.source || rn.id === rl.target) return false;
        const rx = solvedXMap.get(rn.id) ?? 0;
        return rx > minX + 12 && rx < maxX - 12;
      });

      if (!hasIntermediateNode && rl.parallelCount === 1) {
        // Adjacent horizontal neighbor: clean direct segment with zero overlap!
        linkRoutes.set(rl.id, {
          linkId: rl.id,
          sameRow: true,
          arcTrack: 0,
          sourcePortOffset: 0,
          targetPortOffset: 0,
        });
      } else {
        needsArc.push({ rl, minX, maxX, span: maxX - minX });
      }
    }

    // Interval-color all arched links on this row (shortest span first -> innermost tracks ±1, ±2, ±3...)
    needsArc.sort((a, b) => a.span - b.span || a.minX - b.minX);
    const trackIntervals = new Map<number, Array<{ min: number; max: number }>>();
    const candidateTracks = [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6];

    let maxPos = 0;
    let maxNeg = 0;

    for (const item of needsArc) {
      let chosenTrack = candidateTracks[candidateTracks.length - 1];
      for (const t of candidateTracks) {
        const occupied = trackIntervals.get(t) ?? [];
        // Two arcs collide on the same track if their X-intervals overlap (with 16px label buffer)
        const collides = occupied.some(
          (iv) => Math.min(iv.max, item.maxX) - Math.max(iv.min, item.minX) > -16
        );
        if (!collides) {
          chosenTrack = t;
          break;
        }
      }
      if (!trackIntervals.has(chosenTrack)) trackIntervals.set(chosenTrack, []);
      trackIntervals.get(chosenTrack)!.push({ min: item.minX, max: item.maxX });

      if (chosenTrack > 0) maxPos = Math.max(maxPos, chosenTrack);
      if (chosenTrack < 0) maxNeg = Math.max(maxNeg, Math.abs(chosenTrack));

      const portShift = (Math.abs(chosenTrack) - 1) * 9 * Math.sign(chosenTrack);
      linkRoutes.set(item.rl.id, {
        linkId: item.rl.id,
        sameRow: true,
        arcTrack: chosenTrack,
        sourcePortOffset: portShift,
        targetPortOffset: -portShift,
      });
    }

    rowMaxPosTrack.set(rowKey, maxPos);
    rowMaxNegTrack.set(rowKey, maxNeg);
  }

  // Step 5: Compute Non-Overlapping Vertical Y Coordinates per Layer & SubRow!
  // Top-most overlay at top (lowest Y), bottom-most physical at bottom (highest Y)
  const layersTopDown = [...activeLayersInFolded].reverse();
  const rowCenterYMap = new Map<string, number>();

  let currentBandTopY = 0;
  const LAYER_GAP_Y = mode2D === 'swimlanes' ? 92 : 76;

  for (const lid of layersTopDown) {
    const numRows = layerSubRowCount.get(lid) ?? 1;
    let cursorY = currentBandTopY;

    for (let r = 0; r < numRows; r++) {
      const rowKey = `${lid}::${r}`;
      const posTracks = rowMaxPosTrack.get(rowKey) ?? 0;
      const negTracks = rowMaxNegTrack.get(rowKey) ?? 0;
      const topArcSpace = posTracks > 0 ? 26 + posTracks * 24 : 0;
      const botArcSpace = negTracks > 0 ? 26 + negTracks * 24 : 0;

      const rowTopPad = Math.max(GROUP_PAD_TOP_OUTER + GROUP_PAD_TOP_INNER * 0.5, topArcSpace + 18);
      const rowBotPad = Math.max(GROUP_PAD_BOT_OUTER + GROUP_PAD_BOT_INNER * 0.5, botArcSpace + 18);

      const centerY = cursorY + rowTopPad + NODE_H / 2;
      rowCenterYMap.set(rowKey, centerY);
      cursorY = centerY + NODE_H / 2 + rowBotPad + (r < numRows - 1 ? 36 : 0);
    }

    currentBandTopY = cursorY + LAYER_GAP_Y;
  }

  // Center entire 2D vertical span around Y = 0
  if (rowCenterYMap.size > 0) {
    const ys = Array.from(rowCenterYMap.values());
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
    for (const [k, y] of rowCenterYMap.entries()) {
      rowCenterYMap.set(k, y - midY);
    }
  }

  const positions = new Map<string, NodePosition>();
  for (const rn of folded.nodes) {
    const sr = subRowMap.get(rn.id) ?? 0;
    const numRows = layerSubRowCount.get(rn.layer) ?? 1;
    const sx = solvedXMap.get(rn.id) ?? 0;
    const sy = rowCenterYMap.get(`${rn.layer}::${sr}`) ?? 0;
    const az = (sr - (numRows - 1) / 2) * SUBROW_STEP_Z;

    const manual = manualOverrides.get(rn.id);
    const w = rn.isCollapsedGroup ? COLLAPSED_W : NODE_W;
    const h = rn.isCollapsedGroup ? COLLAPSED_H : NODE_H;

    positions.set(rn.id, {
      x: manual?.x ?? sx,
      y: manual?.y ?? sy,
      anchorX: sx,
      anchorZ: az,
      subRow: sr,
      width: w,
      height: h,
    });
  }

  // Step 6: Compute Guaranteed Non-Overlapping Group Boxes per (layer, subRow)!
  const expandedSortedDesc = [...folded.expandedGroups].sort(
    (a, b) => getGroupDepth(b.id) - getGroupDepth(a.id)
  );

  const childGroupsByParent = new Map<string, string[]>();
  for (const g of config.groups) {
    if (!g.parent) continue;
    if (!childGroupsByParent.has(g.parent)) childGroupsByParent.set(g.parent, []);
    childGroupsByParent.get(g.parent)!.push(g.id);
  }

  const layerGroupPads = new Map<string, GroupBox[]>();

  for (const lid of activeLayersInFolded) {
    const numRows = layerSubRowCount.get(lid) ?? 1;
    const allPadsForLayer: GroupBox[] = [];

    for (let r = 0; r < numRows; r++) {
      const padsOnRow = new Map<string, GroupBox>();
      const directByGrp = new Map<string, string[]>();

      for (const rn of folded.nodes) {
        if (rn.layer !== lid || (subRowMap.get(rn.id) ?? 0) !== r || !rn.group) continue;
        if (!directByGrp.has(rn.group)) directByGrp.set(rn.group, []);
        directByGrp.get(rn.group)!.push(rn.id);
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

        for (const nid of directByGrp.get(g.id) ?? []) {
          const pos = positions.get(nid);
          if (!pos) continue;
          hasContent = true;
          minX = Math.min(minX, pos.x - pos.width / 2);
          maxX = Math.max(maxX, pos.x + pos.width / 2);
          minY = Math.min(minY, pos.y - pos.height / 2);
          maxY = Math.max(maxY, pos.y + pos.height / 2);
          minAX = Math.min(minAX, pos.anchorX - pos.width / 2);
          maxAX = Math.max(maxAX, pos.anchorX + pos.width / 2);
          minAZ = Math.min(minAZ, pos.anchorZ - 38);
          maxAZ = Math.max(maxAZ, pos.anchorZ + 38);
        }

        for (const childGid of childGroupsByParent.get(g.id) ?? []) {
          const childBox = padsOnRow.get(childGid);
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
        const padX = depth === 0 ? GROUP_PAD_X_OUTER : GROUP_PAD_X_INNER;
        const padTop = depth === 0 ? GROUP_PAD_TOP_OUTER : GROUP_PAD_TOP_INNER;
        const padBot = depth === 0 ? GROUP_PAD_BOT_OUTER : GROUP_PAD_BOT_INNER;

        padsOnRow.set(g.id, {
          key: `${lid}::r${r}::${g.id}`,
          group: g,
          layerId: lid,
          subRow: r,
          x: minX - padX,
          y: minY - padTop,
          width: maxX - minX + padX * 2,
          height: maxY - minY + padTop + padBot,
          anchorMinX: minAX - padX,
          anchorMaxX: maxAX + padX,
          anchorMinZ: minAZ - padBot,
          anchorMaxZ: maxAZ + padTop,
          depth,
        });
      }

      allPadsForLayer.push(...padsOnRow.values());
    }

    allPadsForLayer.sort((a, b) => a.depth - b.depth);
    layerGroupPads.set(lid, allPadsForLayer);
  }

  // Use per-(layer, subRow) boxes in both 2D modes so groups NEVER stretch over unrelated rows or overlap!
  // In `anchored` mode, if a group spans adjacent layers in the exact same column without colliding with any other group,
  // keeping per-(layer, subRow) boxes guarantees 0% group overlap under all configurations.
  const groupBoxes = Array.from(layerGroupPads.values())
    .flat()
    .sort((a, b) => a.depth - b.depth);

  // Suppress unused warning for SUBROW_STEP_Y (kept as reference metric)
  void SUBROW_STEP_Y;

  return { positions, groupBoxes, layerGroupPads, linkRoutes };
}
