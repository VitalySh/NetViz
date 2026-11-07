import React from 'react';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FolderMinus,
  FolderPlus,
  Ghost,
  PanelLeftClose,
  Sparkles,
} from 'lucide-react';
import type {
  CrossLayerResolution,
  GroupSpec,
  LayerVisibilityMode,
  NetworkConfig,
} from '../schema/types';

interface LayerStackPanelProps {
  config: NetworkConfig;
  resolution: CrossLayerResolution;
  layerModes: Map<string, LayerVisibilityMode>;
  soloLayerId: string | null;
  ghostPhysicalOnSolo: boolean;
  onSetLayerMode: (layerId: string, mode: LayerVisibilityMode) => void;
  onToggleSoloLayer: (layerId: string) => void;
  onToggleGhostPhysicalOnSolo: () => void;
  onShowAllLayers: () => void;
  collapsedGroupIds: Set<string>;
  onToggleGroupCollapse: (groupId: string) => void;
  onCollapseByType: (groupType: string | 'all' | 'none') => void;
  onCollapse: () => void;
}

export const LayerStackPanel: React.FC<LayerStackPanelProps> = ({
  config,
  resolution,
  layerModes,
  soloLayerId,
  ghostPhysicalOnSolo,
  onSetLayerMode,
  onToggleSoloLayer,
  onToggleGhostPhysicalOnSolo,
  onShowAllLayers,
  collapsedGroupIds,
  onToggleGroupCollapse,
  onCollapseByType,
  onCollapse,
}) => {
  // Display highest overlay layer at the top down to Physical Layer 0 at the bottom
  const layersTopDown = [...config.layers].sort((a, b) => b.order - a.order);
  const layerMap = new Map(config.layers.map((l) => [l.id, l]));

  // Build group hierarchy tree
  const rootGroups = config.groups.filter((g) => !g.parent);
  const childrenByParent = new Map<string, GroupSpec[]>();
  for (const g of config.groups) {
    if (g.parent) {
      if (!childrenByParent.has(g.parent)) childrenByParent.set(g.parent, []);
      childrenByParent.get(g.parent)!.push(g);
    }
  }

  const countGroupNodes = (gid: string): number => {
    let total = config.nodes.filter((n) => n.group === gid).length;
    for (const child of childrenByParent.get(gid) ?? []) {
      total += countGroupNodes(child.id);
    }
    return total;
  };

  const renderGroupRow = (g: GroupSpec, depth: number): React.ReactNode => {
    const isCollapsed = collapsedGroupIds.has(g.id);
    const children = childrenByParent.get(g.id) ?? [];
    const memberCount = countGroupNodes(g.id);
    const gColor = g.color ?? (g.layer ? layerMap.get(g.layer)?.color : '#64748b') ?? '#64748b';

    return (
      <React.Fragment key={g.id}>
        <div
          className="group-row"
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => onToggleGroupCollapse(g.id)}
          title={isCollapsed ? 'Click to expand container' : 'Click to fold container into a single summary node'}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {isCollapsed ? (
              <ChevronRight size={13} color="var(--accent-cyan)" />
            ) : (
              <ChevronDown size={13} color="var(--text-muted)" />
            )}
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: gColor,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                fontWeight: isCollapsed ? 600 : 400,
                color: isCollapsed ? '#7dd3fc' : 'var(--text-primary)',
              }}
            >
              {g.name}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{g.type}</span>
            <span
              style={{
                fontSize: 10,
                padding: '1px 5px',
                borderRadius: 4,
                background: isCollapsed ? 'rgba(56,189,248,0.18)' : 'rgba(148,163,184,0.12)',
                color: isCollapsed ? '#7dd3fc' : 'var(--text-secondary)',
              }}
            >
              {isCollapsed ? `folded · ${memberCount}` : memberCount}
            </span>
          </div>
        </div>
        {!isCollapsed && children.map((child) => renderGroupRow(child, depth + 1))}
      </React.Fragment>
    );
  };

  const hasRacks = config.groups.some((g) => g.type.toLowerCase() === 'rack');

  return (
    <aside className="left-panel">
      {/* Layer Stack Controller */}
      <div className="panel-section">
        <div className="section-header">
          <span>Network Layer Stack ({config.layers.length})</span>
          <div className="mini-btn-row">
            <button className="mini-btn" onClick={onShowAllLayers} title="Reset all layers to Visible">
              Show All
            </button>
            <button
              className="mini-btn"
              onClick={onCollapse}
              title="Collapse Layer Stack panel"
              style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 5px' }}
            >
              <PanelLeftClose size={12} />
            </button>
          </div>
        </div>

        {layersTopDown.map((layer) => {
          const mode = layerModes.get(layer.id) ?? 'visible';
          const isSolo = soloLayerId === layer.id;
          const layerNodes = config.nodes.filter((n) => n.layer === layer.id);
          const layerLinks = config.links.filter((l) => l.layer === layer.id);

          const degradedOrDownNodes = layerNodes.filter(
            (n) => (resolution.nodeHealth.get(n.id)?.status ?? 'up') !== 'up'
          ).length;
          const degradedOrDownLinks = layerLinks.filter(
            (l) => (resolution.linkHealth.get(l.id)?.status ?? 'up') !== 'up'
          ).length;
          const issueCount = degradedOrDownNodes + degradedOrDownLinks;

          return (
            <div
              key={layer.id}
              className={`layer-card ${mode === 'hidden' ? 'hidden-layer' : ''} ${
                mode === 'ghost' ? 'ghost-layer' : ''
              } ${isSolo ? 'solo-active' : ''}`}
            >
              <div className="layer-card-top">
                <div className="layer-title-wrap">
                  <div className="layer-swatch" style={{ background: layer.color }} />
                  <div style={{ minWidth: 0 }}>
                    <div className="layer-name" title={layer.name}>
                      {layer.name}
                    </div>
                  </div>
                </div>

                <div className="mini-btn-row">
                  <button
                    className={`mini-btn ${isSolo ? 'active' : ''}`}
                    onClick={() => onToggleSoloLayer(layer.id)}
                    title="Solo this layer (isolate from other overlays)"
                  >
                    Solo
                  </button>
                  <button
                    className={`mini-btn ${mode === 'visible' ? 'active' : ''}`}
                    onClick={() => onSetLayerMode(layer.id, 'visible')}
                    title="Full visibility"
                  >
                    <Eye size={11} />
                  </button>
                  <button
                    className={`mini-btn ${mode === 'ghost' ? 'active' : ''}`}
                    onClick={() => onSetLayerMode(layer.id, 'ghost')}
                    title="Ghost mode (dimmed context reference)"
                  >
                    <Ghost size={11} />
                  </button>
                  <button
                    className={`mini-btn ${mode === 'hidden' ? 'active' : ''}`}
                    onClick={() => onSetLayerMode(layer.id, 'hidden')}
                    title="Hide layer"
                  >
                    <EyeOff size={11} />
                  </button>
                </div>
              </div>

              <div className="layer-sub">
                <span>{layerNodes.length} nodes</span>
                <span>·</span>
                <span>{layerLinks.length} links</span>
                {issueCount > 0 && (
                  <span style={{ color: 'var(--status-degraded)', fontWeight: 600 }}>
                    · {issueCount} impacted
                  </span>
                )}
              </div>
            </div>
          );
        })}

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 11.5,
            color: 'var(--text-secondary)',
            marginTop: 8,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={ghostPhysicalOnSolo}
            onChange={onToggleGhostPhysicalOnSolo}
          />
          <Sparkles size={12} color="var(--accent-cyan)" />
          <span>Keep L0 Physical ghosted when Soloing</span>
        </label>
      </div>

      {/* Collapsible Groups Controller */}
      <div className="panel-section" style={{ flex: 1 }}>
        <div className="section-header">
          <span>Collapsible Containers ({config.groups.length})</span>
          <div className="mini-btn-row">
            {hasRacks && (
              <button
                className="mini-btn"
                onClick={() => onCollapseByType('rack')}
                title="Fold all physical racks into compact summary nodes"
              >
                Fold Racks
              </button>
            )}
            <button
              className="mini-btn"
              onClick={() => onCollapseByType('all')}
              title="Collapse all top-level containers"
            >
              <FolderMinus size={11} />
            </button>
            <button
              className="mini-btn"
              onClick={() => onCollapseByType('none')}
              title="Expand all containers"
            >
              <FolderPlus size={11} />
            </button>
          </div>
        </div>

        {config.groups.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            No groups defined in this YAML file.
          </div>
        ) : (
          <div>{rootGroups.map((g) => renderGroupRow(g, 0))}</div>
        )}
      </div>
    </aside>
  );
};
