import type { CrossLayerResolution, NetworkConfig } from '../schema/types';
import type { FoldedGraph } from './grouping';

export type SelectionTarget =
  | { kind: 'node'; id: string } // original nodeId or collapsed proxy `group:<id>`
  | { kind: 'link'; id: string } // original linkId or aggregated `agg:...`
  | null;

export interface HighlightTrace {
  hasSelection: boolean;
  primaryRenderNodeIds: Set<string>;
  primaryRenderLinkIds: Set<string>;
  underlayRenderNodeIds: Set<string>;
  underlayRenderLinkIds: Set<string>;
  blastRenderNodeIds: Set<string>;
  blastRenderLinkIds: Set<string>;
  /** Raw un-folded IDs for detailed Inspector breakdown */
  rawUnderlayNodeIds: Set<string>;
  rawUnderlayLinkIds: Set<string>;
  rawBlastNodeIds: Set<string>;
  rawBlastLinkIds: Set<string>;
}

export function computeHighlightTrace(
  selection: SelectionTarget,
  config: NetworkConfig,
  resolution: CrossLayerResolution,
  folded: FoldedGraph
): HighlightTrace {
  const empty: HighlightTrace = {
    hasSelection: false,
    primaryRenderNodeIds: new Set(),
    primaryRenderLinkIds: new Set(),
    underlayRenderNodeIds: new Set(),
    underlayRenderLinkIds: new Set(),
    blastRenderNodeIds: new Set(),
    blastRenderLinkIds: new Set(),
    rawUnderlayNodeIds: new Set(),
    rawUnderlayLinkIds: new Set(),
    rawBlastNodeIds: new Set(),
    rawBlastLinkIds: new Set(),
  };

  if (!selection) return empty;

  const rawUnderlayNodeIds = new Set<string>();
  const rawUnderlayLinkIds = new Set<string>();
  const rawBlastNodeIds = new Set<string>();
  const rawBlastLinkIds = new Set<string>();
  const primaryRenderNodeIds = new Set<string>();
  const primaryRenderLinkIds = new Set<string>();

  const linkMap = new Map(config.links.map((l) => [l.id, l]));

  if (selection.kind === 'node') {
    const rNode = folded.nodes.find((n) => n.id === selection.id);
    const seedNodeIds = rNode ? rNode.memberNodeIds : [selection.id];
    if (rNode) primaryRenderNodeIds.add(rNode.id);

    for (const nid of seedNodeIds) {
      const mapped = folded.nodeToRenderId.get(nid);
      if (mapped) primaryRenderNodeIds.add(mapped);

      // Downward hosting ancestors
      for (const anc of resolution.nodeAncestorsMap.get(nid) ?? []) {
        rawUnderlayNodeIds.add(anc);
      }
      // Upward hosted nodes
      for (const dep of resolution.nodeDependentsMap.get(nid) ?? []) {
        rawBlastNodeIds.add(dep);
      }
      // Upward impacted links (transit or hosted endpoints)
      for (const impLinkId of resolution.nodeImpactedLinksMap.get(nid) ?? []) {
        const impLink = linkMap.get(impLinkId);
        if (!impLink) continue;
        // Only classify as upward blast if link isn't purely an internal link among seed nodes at same layer
        rawBlastLinkIds.add(impLinkId);
        rawBlastNodeIds.add(impLink.source);
        rawBlastNodeIds.add(impLink.target);
      }
    }
  } else if (selection.kind === 'link') {
    const rLink = folded.links.find((l) => l.id === selection.id);
    const seedLinkIds = rLink ? rLink.memberLinkIds : [selection.id];
    if (rLink) {
      primaryRenderLinkIds.add(rLink.id);
      primaryRenderNodeIds.add(rLink.source);
      primaryRenderNodeIds.add(rLink.target);
    }

    for (const lid of seedLinkIds) {
      const lSpec = linkMap.get(lid);
      if (lSpec) {
        const rs = folded.nodeToRenderId.get(lSpec.source);
        const rt = folded.nodeToRenderId.get(lSpec.target);
        if (rs) primaryRenderNodeIds.add(rs);
        if (rt) primaryRenderNodeIds.add(rt);

        // Include endpoint hosting ancestors in downward underlay trace
        for (const anc of resolution.nodeAncestorsMap.get(lSpec.source) ?? []) {
          rawUnderlayNodeIds.add(anc);
        }
        for (const anc of resolution.nodeAncestorsMap.get(lSpec.target) ?? []) {
          rawUnderlayNodeIds.add(anc);
        }
      }

      // Downward resolved underlay hops across all lower layers
      const traces = resolution.linkUnderlayMap.get(lid);
      if (traces) {
        for (const trace of traces.values()) {
          for (const unid of trace.nodeIds) rawUnderlayNodeIds.add(unid);
          for (const ulid of trace.linkIds) rawUnderlayLinkIds.add(ulid);
        }
      }

      // Upward dependent overlay links (blast radius)
      for (const depLinkId of resolution.linkDependentsMap.get(lid) ?? []) {
        rawBlastLinkIds.add(depLinkId);
        const depSpec = linkMap.get(depLinkId);
        if (depSpec) {
          rawBlastNodeIds.add(depSpec.source);
          rawBlastNodeIds.add(depSpec.target);
        }
      }
    }
  }

  // Project raw node & link sets onto active RenderNode / RenderLink IDs
  const underlayRenderNodeIds = new Set<string>();
  for (const nid of rawUnderlayNodeIds) {
    const rid = folded.nodeToRenderId.get(nid);
    if (rid && !primaryRenderNodeIds.has(rid)) underlayRenderNodeIds.add(rid);
  }

  const blastRenderNodeIds = new Set<string>();
  for (const nid of rawBlastNodeIds) {
    const rid = folded.nodeToRenderId.get(nid);
    if (rid && !primaryRenderNodeIds.has(rid)) blastRenderNodeIds.add(rid);
  }

  const underlayRenderLinkIds = new Set<string>();
  const blastRenderLinkIds = new Set<string>();
  for (const rl of folded.links) {
    if (primaryRenderLinkIds.has(rl.id)) continue;
    if (rl.memberLinkIds.some((mid) => rawUnderlayLinkIds.has(mid))) {
      underlayRenderLinkIds.add(rl.id);
    }
    if (rl.memberLinkIds.some((mid) => rawBlastLinkIds.has(mid))) {
      blastRenderLinkIds.add(rl.id);
    }
  }

  return {
    hasSelection: true,
    primaryRenderNodeIds,
    primaryRenderLinkIds,
    underlayRenderNodeIds,
    underlayRenderLinkIds,
    blastRenderNodeIds,
    blastRenderLinkIds,
    rawUnderlayNodeIds,
    rawUnderlayLinkIds,
    rawBlastNodeIds,
    rawBlastLinkIds,
  };
}
