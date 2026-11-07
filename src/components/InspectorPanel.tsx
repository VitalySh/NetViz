import React from 'react';
import {
  Activity,
  ArrowDownCircle,
  ArrowUpCircle,
  CheckCircle2,
  Compass,
  PanelRightClose,
  X,
  Zap,
  ZapOff,
} from 'lucide-react';
import type { CrossLayerResolution, NetworkConfig } from '../schema/types';
import type { FoldedGraph } from '../engine/grouping';
import type { HighlightTrace, SelectionTarget } from '../engine/selectionTrace';
import type { FailureSimulationState } from '../engine/resolver';

interface InspectorPanelProps {
  config: NetworkConfig;
  resolution: CrossLayerResolution;
  folded: FoldedGraph;
  selection: SelectionTarget;
  onSelect: (sel: SelectionTarget) => void;
  trace: HighlightTrace;
  sim: FailureSimulationState;
  onToggleFailNode: (nodeId: string) => void;
  onToggleFailLink: (linkId: string) => void;
  onCollapse: () => void;
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  config,
  resolution,
  folded,
  selection,
  onSelect,
  trace,
  sim,
  onToggleFailNode,
  onToggleFailLink,
  onCollapse,
}) => {
  const layerMap = new Map(config.layers.map((l) => [l.id, l]));
  const nodeMap = new Map(config.nodes.map((n) => [n.id, n]));
  const linkMap = new Map(config.links.map((l) => [l.id, l]));
  const layersTopDown = [...config.layers].sort((a, b) => b.order - a.order);
  const layersBottomUp = [...config.layers].sort((a, b) => a.order - b.order);

  const selectRawNode = (rawNodeId: string) => {
    const rid = folded.nodeToRenderId.get(rawNodeId) ?? rawNodeId;
    onSelect({ kind: 'node', id: rid });
  };

  const selectRawLink = (rawLinkId: string) => {
    const rl = folded.links.find((l) => l.memberLinkIds.includes(rawLinkId));
    onSelect({ kind: 'link', id: rl ? rl.id : rawLinkId });
  };

  const statusBadge = (status: 'up' | 'degraded' | 'down') => (
    <span className={`status-pill status-${status}`}>{status}</span>
  );

  // Empty state: Network Summary + Auto-Generated Quick Trace Prompts
  if (!selection) {
    const topLayer = layersTopDown[0];
    const bottomLayer = layersBottomUp[0];
    const sampleOverlayLink = config.links.find((l) => l.layer === topLayer?.id);
    const sampleCoreNode =
      config.nodes.find((n) => n.layer === bottomLayer?.id && n.role === 'spine') ??
      config.nodes.find((n) => n.layer === bottomLayer?.id);

    const totalDown =
      Array.from(resolution.nodeHealth.values()).filter((h) => h.status === 'down').length +
      Array.from(resolution.linkHealth.values()).filter((h) => h.status === 'down').length;
    const totalDegraded =
      Array.from(resolution.nodeHealth.values()).filter((h) => h.status === 'degraded').length +
      Array.from(resolution.linkHealth.values()).filter((h) => h.status === 'degraded').length;

    return (
      <aside className="right-panel">
        <div className="panel-section">
          <div className="section-header">
            <span>Topology Overview</span>
            <button
              className="mini-btn"
              onClick={onCollapse}
              title="Collapse Inspector panel"
              style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 5px' }}
            >
              <PanelRightClose size={12} />
            </button>
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 6 }}>
            {config.metadata.name}
          </div>
          {config.metadata.description && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {config.metadata.description}
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: 8,
              marginTop: 12,
            }}
          >
            <div className="trace-card" style={{ marginBottom: 0, textAlign: 'center' }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#38bdf8' }}>
                {config.layers.length}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>Layers</div>
            </div>
            <div className="trace-card" style={{ marginBottom: 0, textAlign: 'center' }}>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{config.nodes.length}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>Nodes</div>
            </div>
            <div className="trace-card" style={{ marginBottom: 0, textAlign: 'center' }}>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{config.links.length}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>Links</div>
            </div>
          </div>

          <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <Activity size={14} color="var(--status-up)" />
            {totalDown === 0 && totalDegraded === 0 ? (
              <span style={{ color: '#34d399' }}>All layers healthy (100% nominal)</span>
            ) : (
              <span>
                <strong style={{ color: '#f87171' }}>{totalDown} down</strong> ·{' '}
                <strong style={{ color: '#fbbf24' }}>{totalDegraded} degraded</strong>
              </span>
            )}
          </div>
        </div>

        <div className="panel-section">
          <div className="section-header">
            <span>Quick Cross-Layer Walkthrough</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
            Select any node or link on the canvas—or try a 1-click inspection below:
          </div>

          {sampleOverlayLink && (
            <button
              className="btn"
              style={{ width: '100%', justifyContent: 'flex-start', marginBottom: 8 }}
              onClick={() => selectRawLink(sampleOverlayLink.id)}
            >
              <Compass size={14} color="#2dd4bf" />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                Trace Overlay Link: {sampleOverlayLink.id} (L{topLayer.order} → L0)
              </span>
            </button>
          )}

          {sampleCoreNode && (
            <>
              <button
                className="btn"
                style={{ width: '100%', justifyContent: 'flex-start', marginBottom: 8 }}
                onClick={() => selectRawNode(sampleCoreNode.id)}
              >
                <ArrowUpCircle size={14} color="#fbbf24" />
                <span>Inspect Physical Blast Radius: {sampleCoreNode.label}</span>
              </button>

              <button
                className="btn btn-danger"
                style={{ width: '100%', justifyContent: 'flex-start' }}
                onClick={() => {
                  selectRawNode(sampleCoreNode.id);
                  if (!sim.failedNodeIds.has(sampleCoreNode.id)) {
                    onToggleFailNode(sampleCoreNode.id);
                  }
                }}
              >
                <ZapOff size={14} />
                <span>Simulate {sampleCoreNode.label} Outage (ECMP Test)</span>
              </button>
            </>
          )}
        </div>
      </aside>
    );
  }

  // Selected Node View
  if (selection.kind === 'node') {
    const rNode = folded.nodes.find((n) => n.id === selection.id);
    const rawNode = nodeMap.get(selection.id);
    const layer = layerMap.get(rNode?.layer ?? rawNode?.layer ?? '');
    const health =
      rNode?.health ??
      resolution.nodeHealth.get(selection.id) ?? { status: 'up' as const };
    const isFailed = rawNode ? sim.failedNodeIds.has(rawNode.id) : false;

    // Group upward blast nodes/links by layer
    const blastByLayer = layersTopDown
      .filter((l) => (layer ? l.order > layer.order : true))
      .map((l) => ({
        layer: l,
        nodes: Array.from(trace.rawBlastNodeIds)
          .map((id) => nodeMap.get(id))
          .filter((n): n is NonNullable<typeof n> => Boolean(n && n.layer === l.id)),
        links: Array.from(trace.rawBlastLinkIds)
          .map((id) => linkMap.get(id))
          .filter((lk): lk is NonNullable<typeof lk> => Boolean(lk && lk.layer === l.id)),
      }))
      .filter((entry) => entry.nodes.length > 0 || entry.links.length > 0);

    // Group downward hosting ancestors by layer
    const hostsByLayer = layersTopDown
      .filter((l) => (layer ? l.order < layer.order : true))
      .map((l) => ({
        layer: l,
        nodes: Array.from(trace.rawUnderlayNodeIds)
          .map((id) => nodeMap.get(id))
          .filter((n): n is NonNullable<typeof n> => Boolean(n && n.layer === l.id)),
      }))
      .filter((entry) => entry.nodes.length > 0);

    return (
      <aside className="right-panel">
        <div className="panel-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 2,
                    background: layer?.color ?? '#38bdf8',
                  }}
                />
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600 }}>
                  {layer?.name}
                </span>
              </div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>
                {rNode?.label ?? rawNode?.label ?? selection.id}
              </div>
            </div>
            <div className="mini-btn-row">
              <button className="mini-btn" onClick={() => onSelect(null)} title="Clear selection">
                <X size={13} />
              </button>
              <button
                className="mini-btn"
                onClick={onCollapse}
                title="Collapse Inspector panel"
                style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 5px' }}
              >
                <PanelRightClose size={13} />
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            {statusBadge(health.status)}
            <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
              {rNode?.type ?? rawNode?.type}
            </span>
          </div>

          {health.reason && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: '#fbbf24' }}>{health.reason}</div>
          )}

          {rawNode && (
            <button
              className={`btn ${isFailed ? 'btn-primary' : 'btn-danger'}`}
              style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}
              onClick={() => onToggleFailNode(rawNode.id)}
            >
              {isFailed ? <Zap size={13} /> : <ZapOff size={13} />}
              <span>{isFailed ? 'Restore Node Health' : 'Simulate Node Failure'}</span>
            </button>
          )}
        </div>

        {/* Upward Blast Radius */}
        <div className="panel-section">
          <div className="section-header">
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <ArrowUpCircle size={13} color="#fbbf24" />
              Upward Blast Radius ({trace.rawBlastNodeIds.size} nodes, {trace.rawBlastLinkIds.size}{' '}
              links)
            </span>
          </div>

          {blastByLayer.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Top-most endpoint — no higher overlay layers depend on this node.
            </div>
          ) : (
            blastByLayer.map(({ layer: bLayer, nodes, links }) => (
              <div key={bLayer.id} className="trace-card">
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: bLayer.color,
                    marginBottom: 5,
                  }}
                >
                  {bLayer.name}
                </div>
                {nodes.length > 0 && (
                  <div style={{ marginBottom: 4 }}>
                    {nodes.map((n) => {
                      const st = resolution.nodeHealth.get(n.id)?.status ?? 'up';
                      return (
                        <span key={n.id} className="chip" onClick={() => selectRawNode(n.id)}>
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              background:
                                st === 'down' ? '#ef4444' : st === 'degraded' ? '#f59e0b' : '#10b981',
                            }}
                          />
                          {n.label}
                        </span>
                      );
                    })}
                  </div>
                )}
                {links.length > 0 && (
                  <div>
                    {links.map((lk) => {
                      const st = resolution.linkHealth.get(lk.id)?.status ?? 'up';
                      return (
                        <span key={lk.id} className="chip" onClick={() => selectRawLink(lk.id)}>
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              background:
                                st === 'down' ? '#ef4444' : st === 'degraded' ? '#f59e0b' : '#10b981',
                            }}
                          />
                          🔗 {lk.label ?? lk.id}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Downward Hosting Stack */}
        <div className="panel-section">
          <div className="section-header">
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <ArrowDownCircle size={13} color="#2dd4bf" />
              Underlying Host Stack ({trace.rawUnderlayNodeIds.size} hosts)
            </span>
          </div>

          {hostsByLayer.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Root physical / standalone node (no lower hosting layer).
            </div>
          ) : (
            hostsByLayer.map(({ layer: hLayer, nodes }) => (
              <div key={hLayer.id} className="trace-card">
                <div style={{ fontSize: 11, fontWeight: 700, color: hLayer.color, marginBottom: 4 }}>
                  {hLayer.name}
                </div>
                {nodes.map((n) => (
                  <span key={n.id} className="chip" onClick={() => selectRawNode(n.id)}>
                    {n.label}
                  </span>
                ))}
              </div>
            ))
          )}
        </div>

        {/* Metadata */}
        {rawNode?.metadata && Object.keys(rawNode.metadata).length > 0 && (
          <div className="panel-section">
            <div className="section-header">
              <span>Device / Service Metadata</span>
            </div>
            <table className="kv-table">
              <tbody>
                {Object.entries(rawNode.metadata).map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>{String(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </aside>
    );
  }

  // Selected Link View
  const rLink = folded.links.find((l) => l.id === selection.id);
  const primaryLinkId = rLink ? rLink.memberLinkIds[0] : selection.id;
  const rawLink = linkMap.get(primaryLinkId);
  const layer = layerMap.get(rLink?.layer ?? rawLink?.layer ?? '');
  const health =
    rLink?.health ??
    resolution.linkHealth.get(primaryLinkId) ?? { status: 'up' as const };
  const isLinkFailed = rawLink ? sim.failedLinkIds.has(rawLink.id) : false;

  const underlayTracesMap = resolution.linkUnderlayMap.get(primaryLinkId);
  const orderedUnderlayTraces = layersTopDown
    .filter((l) => underlayTracesMap?.has(l.id))
    .map((l) => ({
      layer: l,
      trace: underlayTracesMap!.get(l.id)!,
    }));

  const upwardLinksByLayer = layersTopDown
    .filter((l) => (layer ? l.order > layer.order : true))
    .map((l) => ({
      layer: l,
      links: Array.from(trace.rawBlastLinkIds)
        .map((id) => linkMap.get(id))
        .filter((lk): lk is NonNullable<typeof lk> => Boolean(lk && lk.layer === l.id)),
    }))
    .filter((entry) => entry.links.length > 0);

  return (
    <aside className="right-panel">
      <div className="panel-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 2,
                  background: layer?.color ?? '#38bdf8',
                }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600 }}>
                {layer?.name}
              </span>
            </div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>
              {rLink?.label ?? rawLink?.label ?? primaryLinkId}
            </div>
            {rawLink && (
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 3 }}>
                {rawLink.source} ↔ {rawLink.target}
              </div>
            )}
          </div>
          <div className="mini-btn-row">
            <button className="mini-btn" onClick={() => onSelect(null)} title="Clear selection">
              <X size={13} />
            </button>
            <button
              className="mini-btn"
              onClick={onCollapse}
              title="Collapse Inspector panel"
              style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 5px' }}
            >
              <PanelRightClose size={13} />
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          {statusBadge(health.status)}
          {rawLink?.encapsulation && (
            <span style={{ fontSize: 11, color: '#c4b5fd' }}>{rawLink.encapsulation}</span>
          )}
          {rawLink?.bandwidth && (
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              {rawLink.bandwidth}
            </span>
          )}
        </div>

        {health.reason && (
          <div style={{ marginTop: 6, fontSize: 11.5, color: '#fbbf24' }}>{health.reason}</div>
        )}

        {rawLink && !rLink?.isAggregated && (
          <button
            className={`btn ${isLinkFailed ? 'btn-primary' : 'btn-danger'}`}
            style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}
            onClick={() => onToggleFailLink(rawLink.id)}
          >
            {isLinkFailed ? <Zap size={13} /> : <ZapOff size={13} />}
            <span>{isLinkFailed ? 'Restore Link Health' : 'Simulate Link Cut / Outage'}</span>
          </button>
        )}
      </div>

      {/* Downward Resolved Underlay Paths (Layer by Layer down to L0 Physical!) */}
      <div className="panel-section">
        <div className="section-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <ArrowDownCircle size={13} color="#2dd4bf" />
            Resolved Underlay Paths (→ L0 Physical)
          </span>
        </div>

        {orderedUnderlayTraces.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Physical base link — directly realized on hardware media.
          </div>
        ) : (
          orderedUnderlayTraces.map(({ layer: uLayer, trace: uTrace }) => (
            <div key={uLayer.id} className="trace-card">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 6,
                }}
              >
                <span style={{ fontSize: 11.5, fontWeight: 700, color: uLayer.color }}>
                  {uLayer.name}
                </span>
                <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>
                  {uTrace.inferred ? 'Auto-Resolved ECMP' : 'Explicit carriedBy'}
                </span>
              </div>

              {uTrace.ecmpPaths.map((p, idx) => (
                <div
                  key={idx}
                  style={{
                    fontSize: 11,
                    padding: '5px 7px',
                    borderRadius: 6,
                    background: 'rgba(6, 10, 18, 0.65)',
                    border: `1px solid ${
                      p.healthy ? 'rgba(45, 212, 191, 0.25)' : 'rgba(239, 68, 68, 0.4)'
                    }`,
                    marginBottom: 5,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: 3,
                      fontWeight: 600,
                      color: p.healthy ? '#5eead4' : '#f87171',
                    }}
                  >
                    <span>Path #{idx + 1}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      {p.healthy ? <CheckCircle2 size={11} /> : <ZapOff size={11} />}
                      {p.healthy ? 'ACTIVE' : 'BROKEN'}
                    </span>
                  </div>
                  <div style={{ color: '#cbd5e1', lineHeight: 1.45 }}>
                    {p.nodeIds.map((nid, nIdx) => (
                      <React.Fragment key={nid}>
                        <span
                          style={{ cursor: 'pointer', textDecoration: 'underline' }}
                          onClick={() => selectRawNode(nid)}
                        >
                          {nodeMap.get(nid)?.label ?? nid}
                        </span>
                        {nIdx < p.nodeIds.length - 1 && ' → '}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {/* Upward Dependent Overlays */}
      <div className="panel-section">
        <div className="section-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <ArrowUpCircle size={13} color="#fbbf24" />
            Dependent Overlay Flows Above ({trace.rawBlastLinkIds.size})
          </span>
        </div>

        {upwardLinksByLayer.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            No higher-layer overlay tunnels carry traffic over this link.
          </div>
        ) : (
          upwardLinksByLayer.map(({ layer: bLayer, links }) => (
            <div key={bLayer.id} className="trace-card">
              <div style={{ fontSize: 11, fontWeight: 700, color: bLayer.color, marginBottom: 4 }}>
                {bLayer.name}
              </div>
              {links.map((lk) => {
                const st = resolution.linkHealth.get(lk.id)?.status ?? 'up';
                return (
                  <span key={lk.id} className="chip" onClick={() => selectRawLink(lk.id)}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background:
                          st === 'down' ? '#ef4444' : st === 'degraded' ? '#f59e0b' : '#10b981',
                      }}
                    />
                    {lk.label ?? lk.id}
                  </span>
                );
              })}
            </div>
          ))
        )}
      </div>
    </aside>
  );
};
