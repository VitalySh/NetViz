import type {
  CrossLayerResolution,
  EffectiveHealth,
  HealthStatus,
  LinkSpec,
  NetworkConfig,
  NodeSpec,
  ResolvedLayerTrace,
} from '../schema/types';

export interface FailureSimulationState {
  failedNodeIds: Set<string>;
  failedLinkIds: Set<string>;
}

interface ElementaryPath {
  nodeIds: string[];
  linkIds: string[];
}

function worstStatus(a: HealthStatus, b: HealthStatus): HealthStatus {
  if (a === 'down' || b === 'down') return 'down';
  if (a === 'degraded' || b === 'degraded') return 'degraded';
  return 'up';
}

/**
 * Finds all shortest elementary paths between any node in `sources` and any node in `targets`
 * using links from `layerLinks`. Optionally filters to only healthy nodes/links.
 */
function findShortestPathsInLayer(
  sources: string[],
  targets: string[],
  layerLinks: LinkSpec[],
  onlyHealthy?: {
    isNodeUp: (id: string) => boolean;
    isLinkUp: (id: string) => boolean;
  },
  maxPaths = 8
): ElementaryPath[] {
  const targetSet = new Set(targets);
  const adj = new Map<string, Array<{ neighbor: string; linkId: string }>>();

  for (const link of layerLinks) {
    if (onlyHealthy && !onlyHealthy.isLinkUp(link.id)) continue;
    if (onlyHealthy && (!onlyHealthy.isNodeUp(link.source) || !onlyHealthy.isNodeUp(link.target))) {
      continue;
    }
    if (!adj.has(link.source)) adj.set(link.source, []);
    adj.get(link.source)!.push({ neighbor: link.target, linkId: link.id });

    if (link.bidirectional) {
      if (!adj.has(link.target)) adj.set(link.target, []);
      adj.get(link.target)!.push({ neighbor: link.source, linkId: link.id });
    }
  }

  // Co-located endpoints (same host)
  const shared = sources.filter((s) => targetSet.has(s) && (!onlyHealthy || onlyHealthy.isNodeUp(s)));
  if (shared.length > 0) {
    return shared.slice(0, maxPaths).map((s) => ({ nodeIds: [s], linkIds: [] }));
  }

  // BFS by level to discover all equal-cost shortest paths
  const results: ElementaryPath[] = [];
  let queue: ElementaryPath[] = [];
  const bestDistToNode = new Map<string, number>();

  for (const s of sources) {
    if (onlyHealthy && !onlyHealthy.isNodeUp(s)) continue;
    queue.push({ nodeIds: [s], linkIds: [] });
    bestDistToNode.set(s, 0);
  }

  let shortestTargetLen: number | null = null;

  while (queue.length > 0) {
    const nextQueue: ElementaryPath[] = [];

    for (const path of queue) {
      const dist = path.linkIds.length;
      if (shortestTargetLen !== null && dist >= shortestTargetLen) {
        continue;
      }

      const last = path.nodeIds[path.nodeIds.length - 1];
      const neighbors = adj.get(last) ?? [];

      for (const edge of neighbors) {
        if (path.nodeIds.includes(edge.neighbor)) continue; // avoid cycles
        const nextDist = dist + 1;
        const knownBest = bestDistToNode.get(edge.neighbor);
        if (knownBest !== undefined && nextDist > knownBest) {
          continue;
        }
        bestDistToNode.set(edge.neighbor, nextDist);

        const nextPath: ElementaryPath = {
          nodeIds: [...path.nodeIds, edge.neighbor],
          linkIds: [...path.linkIds, edge.linkId],
        };

        if (targetSet.has(edge.neighbor)) {
          shortestTargetLen = nextDist;
          results.push(nextPath);
          if (results.length >= maxPaths) {
            return results;
          }
        } else {
          nextQueue.push(nextPath);
        }
      }
    }

    if (shortestTargetLen !== null) {
      break;
    }
    queue = nextQueue;
  }

  return results;
}

/**
 * Extracts elementary paths among an explicit subset of carrier links in a single layer,
 * falling back to treating the explicit carrier set as a single composite path if endpoints aren't projected.
 */
function buildExplicitLayerPaths(
  carrierLinks: LinkSpec[],
  projectedSources: string[],
  projectedTargets: string[]
): ElementaryPath[] {
  if (carrierLinks.length === 0) return [];
  if (projectedSources.length > 0 && projectedTargets.length > 0) {
    const found = findShortestPathsInLayer(projectedSources, projectedTargets, carrierLinks);
    if (found.length > 0) {
      // Check if there are additional carrier links not in shortest (e.g. unequal cost explicit paths)
      const usedLinks = new Set(found.flatMap((p) => p.linkIds));
      const remaining = carrierLinks.filter((l) => !usedLinks.has(l.id));
      if (remaining.length > 0) {
        const extra = findShortestPathsInLayer(projectedSources, projectedTargets, remaining);
        return [...found, ...extra];
      }
      return found;
    }
  }
  // Fallback: treat all explicit carrier links in this layer as required segments of one composite path
  const nodeSet = new Set<string>();
  const linkIds: string[] = [];
  for (const c of carrierLinks) {
    nodeSet.add(c.source);
    nodeSet.add(c.target);
    linkIds.push(c.id);
  }
  return [{ nodeIds: Array.from(nodeSet), linkIds }];
}

export function resolveCrossLayerTopology(
  config: NetworkConfig,
  sim: FailureSimulationState = { failedNodeIds: new Set(), failedLinkIds: new Set() }
): CrossLayerResolution {
  const sortedLayers = [...config.layers].sort((a, b) => a.order - b.order);
  const layerOrderMap = new Map(sortedLayers.map((l) => [l.id, l.order]));
  const nodeMap = new Map<string, NodeSpec>(config.nodes.map((n) => [n.id, n]));
  const linkMap = new Map<string, LinkSpec>(config.links.map((l) => [l.id, l]));

  const nodesByLayer = new Map<string, NodeSpec[]>();
  const linksByLayer = new Map<string, LinkSpec[]>();
  for (const l of sortedLayers) {
    nodesByLayer.set(l.id, []);
    linksByLayer.set(l.id, []);
  }
  for (const n of config.nodes) {
    nodesByLayer.get(n.layer)?.push(n);
  }
  for (const l of config.links) {
    linksByLayer.get(l.layer)?.push(l);
  }

  // 1. Node hosting ancestors (downward) & dependents (upward)
  const nodeAncestorsMap = new Map<string, Set<string>>();
  const nodeDependentsMap = new Map<string, Set<string>>();
  for (const n of config.nodes) {
    nodeAncestorsMap.set(n.id, new Set());
    nodeDependentsMap.set(n.id, new Set());
  }

  // Process nodes in ascending layer order so host ancestors are already populated
  for (const layer of sortedLayers) {
    for (const node of nodesByLayer.get(layer.id) ?? []) {
      const ancestors = nodeAncestorsMap.get(node.id)!;
      for (const hostId of node.hostedOn) {
        ancestors.add(hostId);
        const hostAncestors = nodeAncestorsMap.get(hostId);
        if (hostAncestors) {
          for (const ha of hostAncestors) {
            ancestors.add(ha);
          }
        }
      }
      for (const ancId of ancestors) {
        nodeDependentsMap.get(ancId)?.add(node.id);
      }
    }
  }

  const projectNodeToLayer = (nodeId: string, targetLayerId: string): string[] => {
    const n = nodeMap.get(nodeId);
    if (!n) return [];
    if (n.layer === targetLayerId) return [nodeId];
    const ancestors = nodeAncestorsMap.get(nodeId) ?? new Set();
    const matches: string[] = [];
    for (const ancId of ancestors) {
      if (nodeMap.get(ancId)?.layer === targetLayerId) {
        matches.push(ancId);
      }
    }
    return matches;
  };

  // 2. Compute Effective Health & Recursive Link Underlay Traces bottom-up
  const nodeHealth = new Map<string, EffectiveHealth>();
  const linkHealth = new Map<string, EffectiveHealth>();
  const linkUnderlayMap = new Map<string, Map<string, ResolvedLayerTrace>>();

  const isNodeHealthy = (id: string): boolean => {
    const h = nodeHealth.get(id);
    return h ? h.status !== 'down' : true;
  };
  const isLinkHealthy = (id: string): boolean => {
    const h = linkHealth.get(id);
    return h ? h.status !== 'down' : true;
  };

  const evaluatePathHealth = (path: ElementaryPath): HealthStatus => {
    let status: HealthStatus = 'up';
    for (const nid of path.nodeIds) {
      const nh = nodeHealth.get(nid)?.status ?? 'up';
      status = worstStatus(status, nh);
    }
    for (const lid of path.linkIds) {
      const lh = linkHealth.get(lid)?.status ?? 'up';
      status = worstStatus(status, lh);
    }
    return status;
  };

  for (let layerIdx = 0; layerIdx < sortedLayers.length; layerIdx++) {
    const layer = sortedLayers[layerIdx];

    // 2a. Evaluate nodes in this layer
    for (const node of nodesByLayer.get(layer.id) ?? []) {
      if (sim.failedNodeIds.has(node.id)) {
        nodeHealth.set(node.id, { status: 'down', reason: 'Simulated node failure' });
        continue;
      }
      if (node.status === 'down') {
        nodeHealth.set(node.id, { status: 'down', reason: 'Configured status: down' });
        continue;
      }

      if (node.hostedOn.length > 0) {
        const upHosts = node.hostedOn.filter((hid) => isNodeHealthy(hid));
        const anyDegradedHost = node.hostedOn.some(
          (hid) => nodeHealth.get(hid)?.status === 'degraded'
        );

        if (upHosts.length === 0) {
          nodeHealth.set(node.id, {
            status: 'down',
            reason: `All host nodes down (${node.hostedOn.join(', ')})`,
            activePaths: 0,
            totalPaths: node.hostedOn.length,
          });
          continue;
        }
        if (upHosts.length < node.hostedOn.length || anyDegradedHost) {
          nodeHealth.set(node.id, {
            status: 'degraded',
            reason:
              upHosts.length < node.hostedOn.length
                ? `Host redundancy reduced (${upHosts.length}/${node.hostedOn.length} hosts up)`
                : 'Underlying host degraded',
            activePaths: upHosts.length,
            totalPaths: node.hostedOn.length,
          });
          continue;
        }
      }

      nodeHealth.set(node.id, {
        status: node.status,
        reason: node.status === 'degraded' ? 'Configured status: degraded' : undefined,
      });
    }

    // 2b. Evaluate links & resolve underlay paths in this layer
    for (const link of linksByLayer.get(layer.id) ?? []) {
      const underlayForLink = new Map<string, ResolvedLayerTrace>();
      linkUnderlayMap.set(link.id, underlayForLink);

      // Helper to insert or merge a ResolvedLayerTrace into underlayForLink
      const upsertLayerTrace = (subLayerId: string, incoming: ResolvedLayerTrace) => {
        const existing = underlayForLink.get(subLayerId);
        if (!existing) {
          underlayForLink.set(subLayerId, {
            layerId: subLayerId,
            nodeIds: [...incoming.nodeIds],
            linkIds: [...incoming.linkIds],
            ecmpPaths: incoming.ecmpPaths.map((p) => ({ ...p })),
            inferred: incoming.inferred,
          });
        } else {
          const mergedNodes = new Set([...existing.nodeIds, ...incoming.nodeIds]);
          const mergedLinks = new Set([...existing.linkIds, ...incoming.linkIds]);
          const seenPathKeys = new Set(
            existing.ecmpPaths.map((p) => `${p.nodeIds.join('>')}::${p.linkIds.join('>')}`)
          );
          const mergedPaths = [...existing.ecmpPaths];
          for (const p of incoming.ecmpPaths) {
            const key = `${p.nodeIds.join('>')}::${p.linkIds.join('>')}`;
            if (!seenPathKeys.has(key)) {
              seenPathKeys.add(key);
              mergedPaths.push({ ...p });
            }
          }
          underlayForLink.set(subLayerId, {
            layerId: subLayerId,
            nodeIds: Array.from(mergedNodes),
            linkIds: Array.from(mergedLinks),
            ecmpPaths: mergedPaths,
            inferred: existing.inferred && incoming.inferred,
          });
        }
      };

      // Helper to merge lower-layer traces from a set of carrier link IDs
      const mergeTransitiveTraces = (carrierLinkIds: string[], inferredFlag: boolean) => {
        for (const cid of carrierLinkIds) {
          const subMap = linkUnderlayMap.get(cid);
          if (!subMap) continue;
          for (const [subLayerId, subTrace] of subMap.entries()) {
            upsertLayerTrace(subLayerId, {
              ...subTrace,
              inferred: inferredFlag || subTrace.inferred,
            });
          }
        }
      };

      const requiredCarrierTraces: ResolvedLayerTrace[] = [];
      let reroutedBackup = false;

      if (link.carriedBy && link.carriedBy.length > 0) {
        // Explicit carriedBy resolution grouped by carrier layer (highest lower layer first)
        const byCarrierLayer = new Map<string, LinkSpec[]>();
        for (const cid of link.carriedBy) {
          const clink = linkMap.get(cid);
          if (!clink) continue;
          if (!byCarrierLayer.has(clink.layer)) byCarrierLayer.set(clink.layer, []);
          byCarrierLayer.get(clink.layer)!.push(clink);
        }

        const carrierLayerIds = Array.from(byCarrierLayer.keys()).sort(
          (a, b) => (layerOrderMap.get(b) ?? 0) - (layerOrderMap.get(a) ?? 0)
        );

        for (const cLayerId of carrierLayerIds) {
          const carriers = byCarrierLayer.get(cLayerId)!;
          const projSrc = projectNodeToLayer(link.source, cLayerId);
          const projTgt = projectNodeToLayer(link.target, cLayerId);
          const paths = buildExplicitLayerPaths(carriers, projSrc, projTgt);

          const ecmpPaths = paths.map((p) => ({
            nodeIds: p.nodeIds,
            linkIds: p.linkIds,
            healthy: evaluatePathHealth(p) !== 'down',
          }));
          const allNodes = new Set(carriers.flatMap((c) => [c.source, c.target]));
          const allLinks = new Set(carriers.map((c) => c.id));

          const trace: ResolvedLayerTrace = {
            layerId: cLayerId,
            nodeIds: Array.from(allNodes),
            linkIds: Array.from(allLinks),
            ecmpPaths,
            inferred: false,
          };
          upsertLayerTrace(cLayerId, trace);
          requiredCarrierTraces.push(trace);

          mergeTransitiveTraces(Array.from(allLinks), false);
        }
      } else if (link.autoResolveUnderlay && layerIdx > 0) {
        // Automatic underlay path resolution: search downward from immediate lower layer
        for (let lowerIdx = layerIdx - 1; lowerIdx >= 0; lowerIdx--) {
          const lowerLayer = sortedLayers[lowerIdx];
          const projSrc = projectNodeToLayer(link.source, lowerLayer.id);
          const projTgt = projectNodeToLayer(link.target, lowerLayer.id);
          if (projSrc.length === 0 || projTgt.length === 0) continue;

          const candidateLinks = linksByLayer.get(lowerLayer.id) ?? [];
          const shortestPaths = findShortestPathsInLayer(projSrc, projTgt, candidateLinks);

          if (shortestPaths.length > 0) {
            const ecmpPaths = shortestPaths.map((p) => ({
              nodeIds: p.nodeIds,
              linkIds: p.linkIds,
              healthy: evaluatePathHealth(p) !== 'down',
            }));

            // Check if all shortest paths failed, and whether a longer healthy backup path exists
            const anyShortestHealthy = ecmpPaths.some((p) => p.healthy);
            if (!anyShortestHealthy) {
              const backupPaths = findShortestPathsInLayer(projSrc, projTgt, candidateLinks, {
                isNodeUp: isNodeHealthy,
                isLinkUp: isLinkHealthy,
              });
              if (backupPaths.length > 0) {
                reroutedBackup = true;
                for (const bp of backupPaths) {
                  ecmpPaths.push({
                    nodeIds: bp.nodeIds,
                    linkIds: bp.linkIds,
                    healthy: true,
                  });
                }
              }
            }

            const allNodes = new Set(ecmpPaths.flatMap((p) => p.nodeIds));
            const allLinks = new Set(ecmpPaths.flatMap((p) => p.linkIds));

            const trace: ResolvedLayerTrace = {
              layerId: lowerLayer.id,
              nodeIds: Array.from(allNodes),
              linkIds: Array.from(allLinks),
              ecmpPaths,
              inferred: true,
            };
            underlayForLink.set(lowerLayer.id, trace);
            requiredCarrierTraces.push(trace);

            if (allLinks.size > 0) {
              mergeTransitiveTraces(Array.from(allLinks), true);
            } else {
              // Co-located intra-host virtual link: still record lower host ancestors for visibility!
              for (let hostLowerIdx = lowerIdx - 1; hostLowerIdx >= 0; hostLowerIdx--) {
                const hostLayer = sortedLayers[hostLowerIdx];
                const hostNodes = Array.from(allNodes).flatMap((nid) =>
                  projectNodeToLayer(nid, hostLayer.id)
                );
                if (hostNodes.length > 0) {
                  const uniqueHostNodes = Array.from(new Set(hostNodes));
                  underlayForLink.set(hostLayer.id, {
                    layerId: hostLayer.id,
                    nodeIds: uniqueHostNodes,
                    linkIds: [],
                    ecmpPaths: uniqueHostNodes.map((hn) => ({
                      nodeIds: [hn],
                      linkIds: [],
                      healthy: isNodeHealthy(hn),
                    })),
                    inferred: true,
                  });
                }
              }
            }
            break;
          }
        }
      }

      // Compute Effective Health for `link`
      if (sim.failedLinkIds.has(link.id)) {
        linkHealth.set(link.id, { status: 'down', reason: 'Simulated link failure' });
        continue;
      }
      if (link.status === 'down') {
        linkHealth.set(link.id, { status: 'down', reason: 'Configured status: down' });
        continue;
      }
      if (!isNodeHealthy(link.source) || !isNodeHealthy(link.target)) {
        const downEnd = !isNodeHealthy(link.source) ? link.source : link.target;
        linkHealth.set(link.id, {
          status: 'down',
          reason: `Endpoint "${downEnd}" is down`,
        });
        continue;
      }

      let computedStatus: HealthStatus = link.status;
      let reason: string | undefined =
        link.status === 'degraded' ? 'Configured status: degraded' : undefined;
      let activePaths: number | undefined;
      let totalPaths: number | undefined;

      // Endpoint degraded check
      if (
        nodeHealth.get(link.source)?.status === 'degraded' ||
        nodeHealth.get(link.target)?.status === 'degraded'
      ) {
        computedStatus = worstStatus(computedStatus, 'degraded');
        reason = reason ?? 'Endpoint host redundancy degraded';
      }

      for (const reqTrace of requiredCarrierTraces) {
        if (reqTrace.ecmpPaths.length === 0) continue;
        const segTotal = reqTrace.ecmpPaths.length;
        const healthyPaths = reqTrace.ecmpPaths.filter((p) => p.healthy);
        const segActive = healthyPaths.length;

        if (totalPaths === undefined || segTotal > 1) {
          totalPaths = segTotal;
          activePaths = segActive;
        }

        if (segActive === 0) {
          computedStatus = 'down';
          reason = `No healthy underlay paths in layer "${reqTrace.layerId}" (0/${segTotal} up)`;
          activePaths = 0;
          totalPaths = segTotal;
          break;
        } else if (reroutedBackup) {
          computedStatus = worstStatus(computedStatus, 'degraded');
          reason = `Primary path down — rerouted via backup path in "${reqTrace.layerId}"`;
        } else if (segActive < segTotal) {
          computedStatus = worstStatus(computedStatus, 'degraded');
          reason = `ECMP redundancy reduced (${segActive}/${segTotal} underlay paths active)`;
        } else {
          const anyPathDegraded = healthyPaths.some((p) => evaluatePathHealth(p) === 'degraded');
          if (anyPathDegraded) {
            computedStatus = worstStatus(computedStatus, 'degraded');
            reason = reason ?? 'Underlay transit path is degraded';
          }
        }
      }

      linkHealth.set(link.id, {
        status: computedStatus,
        reason,
        activePaths,
        totalPaths,
      });
    }
  }

  // 3. Build upward Blast Radius / Reverse Dependency Maps
  const linkDependentsMap = new Map<string, Set<string>>();
  const nodeImpactedLinksMap = new Map<string, Set<string>>();
  for (const l of config.links) linkDependentsMap.set(l.id, new Set());
  for (const n of config.nodes) nodeImpactedLinksMap.set(n.id, new Set());

  for (const link of config.links) {
    // Direct endpoints + their lower-layer hosts impact this link
    nodeImpactedLinksMap.get(link.source)?.add(link.id);
    nodeImpactedLinksMap.get(link.target)?.add(link.id);
    for (const anc of nodeAncestorsMap.get(link.source) ?? []) {
      nodeImpactedLinksMap.get(anc)?.add(link.id);
    }
    for (const anc of nodeAncestorsMap.get(link.target) ?? []) {
      nodeImpactedLinksMap.get(anc)?.add(link.id);
    }

    const traces = linkUnderlayMap.get(link.id);
    if (!traces) continue;
    for (const trace of traces.values()) {
      for (const lowLinkId of trace.linkIds) {
        linkDependentsMap.get(lowLinkId)?.add(link.id);
      }
      for (const lowNodeId of trace.nodeIds) {
        nodeImpactedLinksMap.get(lowNodeId)?.add(link.id);
      }
    }
  }

  return {
    linkUnderlayMap,
    nodeAncestorsMap,
    nodeDependentsMap,
    linkDependentsMap,
    nodeImpactedLinksMap,
    nodeHealth,
    linkHealth,
  };
}
