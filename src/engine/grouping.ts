import type {
  EffectiveHealth,
  GroupSpec,
  HealthStatus,
  LayerVisibilityMode,
  LinkSpec,
  NetworkConfig,
  NodeSpec,
} from '../schema/types';

export interface RenderNode {
  id: string;
  label: string;
  layer: string;
  type: string;
  role?: string;
  group?: string;
  hostedOn: string[];
  isCollapsedGroup: boolean;
  collapsedGroupSpec?: GroupSpec;
  memberNodeIds: string[];
  originalNode?: NodeSpec;
  health: EffectiveHealth;
  visibility: 'visible' | 'ghost';
}

export interface RenderLink {
  id: string;
  label?: string;
  layer: string;
  source: string;
  target: string;
  type: string;
  encapsulation?: string;
  bandwidth?: string;
  isAggregated: boolean;
  memberLinkIds: string[];
  originalLink?: LinkSpec;
  health: EffectiveHealth;
  visibility: 'visible' | 'ghost';
  /** Index among parallel links between the same (source, target) pair for curve offset */
  parallelIndex: number;
  parallelCount: number;
}

export interface FoldedGraph {
  nodes: RenderNode[];
  links: RenderLink[];
  expandedGroups: GroupSpec[];
  /** Maps any original nodeId -> active RenderNode id (itself or its outermost collapsed group proxy) */
  nodeToRenderId: Map<string, string>;
}

function summarizeHealth(healths: EffectiveHealth[]): EffectiveHealth {
  if (healths.length === 0) return { status: 'up' };
  let downCount = 0;
  let degradedCount = 0;
  for (const h of healths) {
    if (h.status === 'down') downCount++;
    else if (h.status === 'degraded') degradedCount++;
  }
  if (downCount === healths.length) {
    return { status: 'down', reason: `All ${downCount} members down` };
  }
  if (downCount > 0 || degradedCount > 0) {
    const status: HealthStatus = 'degraded';
    return {
      status,
      reason: `${downCount} down, ${degradedCount} degraded of ${healths.length} members`,
    };
  }
  return { status: 'up' };
}

export function buildFoldedGraph(
  config: NetworkConfig,
  collapsedGroupIds: Set<string>,
  layerModes: Map<string, LayerVisibilityMode>,
  nodeHealth: Map<string, EffectiveHealth>,
  linkHealth: Map<string, EffectiveHealth>
): FoldedGraph {
  const groupMap = new Map<string, GroupSpec>(config.groups.map((g) => [g.id, g]));
  const layerOrder = new Map<string, number>(config.layers.map((l) => [l.id, l.order]));

  // Find the outermost collapsed ancestor group for a given groupId (if any)
  const getOutermostCollapsedGroup = (groupId?: string): string | null => {
    if (!groupId) return null;
    let curr: string | undefined = groupId;
    let outermost: string | null = null;
    const visited = new Set<string>();
    while (curr && !visited.has(curr)) {
      visited.add(curr);
      if (collapsedGroupIds.has(curr)) {
        outermost = curr;
      }
      curr = groupMap.get(curr)?.parent;
    }
    return outermost;
  };

  // Determine which groups are hidden inside a collapsed parent group
  const isGroupInsideCollapsedParent = (groupId: string): boolean => {
    let curr = groupMap.get(groupId)?.parent;
    const visited = new Set<string>();
    while (curr && !visited.has(curr)) {
      visited.add(curr);
      if (collapsedGroupIds.has(curr)) return true;
      curr = groupMap.get(curr)?.parent;
    }
    return false;
  };

  const collapsedMembers = new Map<string, NodeSpec[]>();
  const nodeToRenderId = new Map<string, string>();
  const renderNodes: RenderNode[] = [];

  for (const node of config.nodes) {
    const mode = layerModes.get(node.layer) ?? 'visible';
    if (mode === 'hidden') continue;

    const collapsedGid = getOutermostCollapsedGroup(node.group);
    if (collapsedGid) {
      const proxyId = `group:${collapsedGid}`;
      nodeToRenderId.set(node.id, proxyId);
      if (!collapsedMembers.has(collapsedGid)) {
        collapsedMembers.set(collapsedGid, []);
      }
      collapsedMembers.get(collapsedGid)!.push(node);
    } else {
      nodeToRenderId.set(node.id, node.id);
      renderNodes.push({
        id: node.id,
        label: node.label,
        layer: node.layer,
        type: node.type,
        role: node.role,
        group: node.group,
        hostedOn: node.hostedOn,
        isCollapsedGroup: false,
        memberNodeIds: [node.id],
        originalNode: node,
        health: nodeHealth.get(node.id) ?? { status: node.status },
        visibility: mode,
      });
    }
  }

  // Create proxy RenderNodes for collapsed groups that have visible/ghost members
  for (const [gid, members] of collapsedMembers.entries()) {
    const gSpec = groupMap.get(gid);
    if (!gSpec || members.length === 0) continue;

    // Pick group's explicit layer or lowest-order layer among members
    const chosenLayer =
      gSpec.layer && (layerModes.get(gSpec.layer) ?? 'visible') !== 'hidden'
        ? gSpec.layer
        : [...members].sort(
            (a, b) => (layerOrder.get(a.layer) ?? 0) - (layerOrder.get(b.layer) ?? 0)
          )[0].layer;

    const mode = layerModes.get(chosenLayer) ?? 'visible';
    if (mode === 'hidden') continue;

    const proxyId = `group:${gid}`;
    const externalHosts = new Set<string>();
    for (const m of members) {
      for (const hid of m.hostedOn) {
        const mappedHost = nodeToRenderId.get(hid);
        if (mappedHost && mappedHost !== proxyId) {
          externalHosts.add(mappedHost);
        }
      }
    }

    renderNodes.push({
      id: proxyId,
      label: `${gSpec.name} (${members.length})`,
      layer: chosenLayer,
      type: gSpec.type || 'group',
      role: 'group',
      group: gSpec.parent,
      hostedOn: Array.from(externalHosts),
      isCollapsedGroup: true,
      collapsedGroupSpec: gSpec,
      memberNodeIds: members.map((m) => m.id),
      health: summarizeHealth(
        members.map((m) => nodeHealth.get(m.id) ?? { status: m.status })
      ),
      visibility: members.some((m) => (layerModes.get(m.layer) ?? 'visible') === 'visible')
        ? 'visible'
        : 'ghost',
    });
  }

  // Remap hostedOn references on regular RenderNodes so they point to collapsed proxy nodes if needed
  const activeRenderNodeIds = new Set(renderNodes.map((rn) => rn.id));
  for (const rn of renderNodes) {
    if (!rn.isCollapsedGroup) {
      const mappedHosts = new Set<string>();
      for (const hid of rn.hostedOn) {
        const targetId = nodeToRenderId.get(hid);
        if (targetId && targetId !== rn.id && activeRenderNodeIds.has(targetId)) {
          mappedHosts.add(targetId);
        }
      }
      rn.hostedOn = Array.from(mappedHosts);
    }
  }

  // Fold links
  const aggregatedBundles = new Map<string, LinkSpec[]>();
  const directLinks: RenderLink[] = [];

  for (const link of config.links) {
    const lMode = layerModes.get(link.layer) ?? 'visible';
    if (lMode === 'hidden') continue;

    const rSrc = nodeToRenderId.get(link.source);
    const rTgt = nodeToRenderId.get(link.target);
    if (!rSrc || !rTgt || rSrc === rTgt) continue;
    if (!activeRenderNodeIds.has(rSrc) || !activeRenderNodeIds.has(rTgt)) continue;

    const involvesCollapsed = rSrc !== link.source || rTgt !== link.target;
    if (!involvesCollapsed) {
      directLinks.push({
        id: link.id,
        label: link.label,
        layer: link.layer,
        source: rSrc,
        target: rTgt,
        type: link.type,
        encapsulation: link.encapsulation,
        bandwidth: link.bandwidth,
        isAggregated: false,
        memberLinkIds: [link.id],
        originalLink: link,
        health: linkHealth.get(link.id) ?? { status: link.status },
        visibility: lMode,
        parallelIndex: 0,
        parallelCount: 1,
      });
    } else {
      const pairKey = [rSrc, rTgt].sort().join('__') + `::${link.layer}`;
      if (!aggregatedBundles.has(pairKey)) {
        aggregatedBundles.set(pairKey, []);
      }
      aggregatedBundles.get(pairKey)!.push(link);
    }
  }

  const aggregatedLinks: RenderLink[] = [];
  for (const [bundleKey, bundle] of aggregatedBundles.entries()) {
    const first = bundle[0];
    const rSrc = nodeToRenderId.get(first.source)!;
    const rTgt = nodeToRenderId.get(first.target)!;
    const rawMode = layerModes.get(first.layer) ?? 'visible';
    if (rawMode === 'hidden') continue;
    const lMode: 'visible' | 'ghost' = rawMode;
    if (bundle.length === 1) {
      aggregatedLinks.push({
        id: first.id,
        label: first.label,
        layer: first.layer,
        source: rSrc,
        target: rTgt,
        type: first.type,
        encapsulation: first.encapsulation,
        bandwidth: first.bandwidth,
        isAggregated: false,
        memberLinkIds: [first.id],
        originalLink: first,
        health: linkHealth.get(first.id) ?? { status: first.status },
        visibility: lMode,
        parallelIndex: 0,
        parallelCount: 1,
      });
    } else {
      aggregatedLinks.push({
        id: `agg:${bundleKey}`,
        label: `${bundle.length} links`,
        layer: first.layer,
        source: rSrc,
        target: rTgt,
        type: first.type,
        encapsulation: first.encapsulation,
        bandwidth: `${bundle.length}×`,
        isAggregated: true,
        memberLinkIds: bundle.map((b) => b.id),
        health: summarizeHealth(
          bundle.map((b) => linkHealth.get(b.id) ?? { status: b.status })
        ),
        visibility: lMode,
        parallelIndex: 0,
        parallelCount: 1,
      });
    }
  }

  const allRenderLinks = [...directLinks, ...aggregatedLinks];

  // Annotate parallel link indices between identical (source, target) pairs
  const pairGroups = new Map<string, RenderLink[]>();
  for (const rl of allRenderLinks) {
    const key = [rl.source, rl.target].sort().join('<->');
    if (!pairGroups.has(key)) pairGroups.set(key, []);
    pairGroups.get(key)!.push(rl);
  }
  for (const list of pairGroups.values()) {
    list.forEach((rl, idx) => {
      rl.parallelIndex = idx;
      rl.parallelCount = list.length;
    });
  }

  // Expanded groups that currently contain at least one rendered node (directly or via child groups)
  const expandedGroups = config.groups.filter(
    (g) => !collapsedGroupIds.has(g.id) && !isGroupInsideCollapsedParent(g.id)
  );

  return {
    nodes: renderNodes,
    links: allRenderLinks,
    expandedGroups,
    nodeToRenderId,
  };
}
