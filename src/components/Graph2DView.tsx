import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Anchor, GitCommitVertical, Layers, Maximize2 } from 'lucide-react';
import type { NetworkConfig } from '../schema/types';
import type { FoldedGraph, RenderLink, RenderNode } from '../engine/grouping';
import type { ComputedLayout, Layout2DMode } from '../engine/layout';
import type { HighlightTrace, SelectionTarget } from '../engine/selectionTrace';
import type { FailureSimulationState } from '../engine/resolver';

interface Graph2DViewProps {
  config: NetworkConfig;
  folded: FoldedGraph;
  layout: ComputedLayout;
  layout2DMode: Layout2DMode;
  onChangeLayout2DMode: (mode: Layout2DMode) => void;
  selection: SelectionTarget;
  onSelect: (sel: SelectionTarget) => void;
  trace: HighlightTrace;
  searchQuery: string;
  sim: FailureSimulationState;
  onToggleGroupCollapse: (groupId: string) => void;
  onNodeDrag: (nodeId: string, pos: { x: number; y: number }) => void;
}

export const Graph2DView: React.FC<Graph2DViewProps> = ({
  config,
  folded,
  layout,
  layout2DMode,
  onChangeLayout2DMode,
  onSelect,
  trace,
  searchQuery,
  sim,
  onToggleGroupCollapse,
  onNodeDrag,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [transform, setTransform] = useState({ x: 480, y: 340, k: 0.78 });
  const [showHostingLines, setShowHostingLines] = useState(true);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const panDragRef = useRef<{
    type: 'pan' | 'node';
    nodeId?: string;
    startClientX: number;
    startClientY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);

  const layerMap = useMemo(
    () => new Map(config.layers.map((l) => [l.id, l])),
    [config.layers]
  );

  const fitToView = useCallback(() => {
    const svg = svgRef.current;
    if (!svg || folded.nodes.length === 0) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const rn of folded.nodes) {
      const p = layout.positions.get(rn.id);
      if (!p) continue;
      minX = Math.min(minX, p.x - 100);
      maxX = Math.max(maxX, p.x + 100);
      minY = Math.min(minY, p.y - 60);
      maxY = Math.max(maxY, p.y + 60);
    }
    for (const gb of layout.groupBoxes) {
      minX = Math.min(minX, gb.x - 20);
      maxX = Math.max(maxX, gb.x + gb.width + 20);
      minY = Math.min(minY, gb.y - 20);
      maxY = Math.max(maxY, gb.y + gb.height + 20);
    }

    if (!Number.isFinite(minX)) return;
    const contentW = Math.max(200, maxX - minX);
    const contentH = Math.max(200, maxY - minY);
    const pad = 70;
    const scale = Math.min(
      1.35,
      Math.max(0.22, Math.min((rect.width - pad * 2) / contentW, (rect.height - pad * 2) / contentH))
    );

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    setTransform({
      x: rect.width / 2 - cx * scale,
      y: rect.height / 2 - cy * scale,
      k: scale,
    });
  }, [folded.nodes, layout]);

  // Auto-fit when topology metadata name or 2D layout mode changes
  useEffect(() => {
    const timer = setTimeout(() => fitToView(), 30);
    return () => clearTimeout(timer);
  }, [config.metadata.name, layout2DMode, fitToView]);

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    setTransform((prev) => {
      const nextK = Math.min(2.8, Math.max(0.16, prev.k * zoomFactor));
      const ratio = nextK / prev.k;
      return {
        k: nextK,
        x: mx - (mx - prev.x) * ratio,
        y: my - (my - prev.y) * ratio,
      };
    });
  };

  const handlePointerDownCanvas = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    panDragRef.current = {
      type: 'pan',
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX: transform.x,
      origY: transform.y,
      moved: false,
    };
  };

  const handlePointerDownNode = (e: React.PointerEvent, node: RenderNode) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const p = layout.positions.get(node.id) ?? { x: 0, y: 0 };
    panDragRef.current = {
      type: 'node',
      nodeId: node.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX: p.x,
      origY: p.y,
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = panDragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;

    if (drag.type === 'pan') {
      setTransform((prev) => ({
        ...prev,
        x: drag.origX + dx,
        y: drag.origY + dy,
      }));
    } else if (drag.type === 'node' && drag.nodeId && drag.moved) {
      onNodeDrag(drag.nodeId, {
        x: drag.origX + dx / transform.k,
        y: drag.origY + dy / transform.k,
      });
    }
  };

  const handlePointerUpCanvas = () => {
    const drag = panDragRef.current;
    panDragRef.current = null;
    if (drag && drag.type === 'pan' && !drag.moved) {
      onSelect(null);
    }
  };

  // Compute Swimlane Background Bands when in swimlanes mode
  const swimlaneBands = useMemo(() => {
    if (layout2DMode !== 'swimlanes') return [];
    const byLayer = new Map<string, { minY: number; maxY: number }>();
    let globalMinX = Infinity;
    let globalMaxX = -Infinity;

    for (const rn of folded.nodes) {
      const p = layout.positions.get(rn.id);
      if (!p) continue;
      globalMinX = Math.min(globalMinX, p.x - 150);
      globalMaxX = Math.max(globalMaxX, p.x + 150);
      const cur = byLayer.get(rn.layer);
      if (!cur) {
        byLayer.set(rn.layer, { minY: p.y - 58, maxY: p.y + 58 });
      } else {
        cur.minY = Math.min(cur.minY, p.y - 58);
        cur.maxY = Math.max(cur.maxY, p.y + 58);
      }
    }

    if (!Number.isFinite(globalMinX) || byLayer.size <= 1) return [];

    return Array.from(byLayer.entries()).map(([lid, span]) => ({
      layer: layerMap.get(lid)!,
      x: globalMinX - 40,
      y: span.minY,
      width: globalMaxX - globalMinX + 80,
      height: span.maxY - span.minY,
    }));
  }, [layout2DMode, folded.nodes, layout.positions, layerMap]);

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const getNodeVisualState = (rn: RenderNode) => {
    const isSelected = trace.primaryRenderNodeIds.has(rn.id);
    const isUnderlay = trace.underlayRenderNodeIds.has(rn.id);
    const isBlast = trace.blastRenderNodeIds.has(rn.id);
    const matchesSearch =
      !normalizedQuery ||
      rn.label.toLowerCase().includes(normalizedQuery) ||
      rn.id.toLowerCase().includes(normalizedQuery) ||
      rn.type.toLowerCase().includes(normalizedQuery);

    const dimmed =
      (trace.hasSelection && !isSelected && !isUnderlay && !isBlast) ||
      (Boolean(normalizedQuery) && !matchesSearch);

    return { isSelected, isUnderlay, isBlast, dimmed };
  };

  const getLinkVisualState = (rl: RenderLink) => {
    const isSelected = trace.primaryRenderLinkIds.has(rl.id);
    const isUnderlay = trace.underlayRenderLinkIds.has(rl.id);
    const isBlast = trace.blastRenderLinkIds.has(rl.id);
    const dimmed = trace.hasSelection && !isSelected && !isUnderlay && !isBlast;
    return { isSelected, isUnderlay, isBlast, dimmed };
  };

  const computeLinkPath = (rl: RenderLink) => {
    const sp = layout.positions.get(rl.source);
    const tp = layout.positions.get(rl.target);
    if (!sp || !tp) return null;

    const dx = tp.x - sp.x;
    const dy = tp.y - sp.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    const curveOffset =
      rl.parallelCount > 1 ? (rl.parallelIndex - (rl.parallelCount - 1) / 2) * 34 : 0;

    const cx = (sp.x + tp.x) / 2 + nx * curveOffset;
    const cy = (sp.y + tp.y) / 2 + ny * curveOffset;

    const d =
      curveOffset === 0
        ? `M ${sp.x} ${sp.y} L ${tp.x} ${tp.y}`
        : `M ${sp.x} ${sp.y} Q ${cx} ${cy} ${tp.x} ${tp.y}`;

    return {
      d,
      midX: curveOffset === 0 ? (sp.x + tp.x) / 2 : (sp.x + 2 * cx + tp.x) / 4,
      midY: curveOffset === 0 ? (sp.y + tp.y) / 2 : (sp.y + 2 * cy + tp.y) / 4,
    };
  };

  const statusColor = (status: 'up' | 'degraded' | 'down') => {
    if (status === 'down') return '#ef4444';
    if (status === 'degraded') return '#f59e0b';
    return '#10b981';
  };

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Top-Left 2D Canvas Controls */}
      <div className="canvas-hud">
        <div className="segmented-control">
          <button
            className={`seg-btn ${layout2DMode === 'swimlanes' ? 'active' : ''}`}
            onClick={() => onChangeLayout2DMode('swimlanes')}
            title="Arrange active layers in vertical architectural elevation bands"
          >
            <Layers size={13} />
            <span>Layer Swimlanes</span>
          </button>
          <button
            className={`seg-btn ${layout2DMode === 'anchored' ? 'active' : ''}`}
            onClick={() => onChangeLayout2DMode('anchored')}
            title="Anchor overlay nodes directly above their physical host racks"
          >
            <Anchor size={13} />
            <span>Host-Anchored</span>
          </button>
        </div>

        <button
          className={`btn ${showHostingLines ? 'btn-primary' : ''}`}
          onClick={() => setShowHostingLines((v) => !v)}
          title="Toggle cross-layer vertical hosting dependency connectors"
        >
          <GitCommitVertical size={13} />
          <span>Host Pillars</span>
        </button>

        <button className="btn" onClick={fitToView} title="Zoom to fit entire network">
          <Maximize2 size={13} />
          <span>Fit</span>
        </button>
      </div>

      {/* Bottom Legend */}
      <div className="canvas-hud-bottom">
        <div className="hud-pill">
          <span className="legend-item">
            <span className="legend-line" style={{ background: '#38bdf8' }} />
            Selected
          </span>
          <span className="legend-item">
            <span className="legend-line" style={{ background: '#2dd4bf' }} />
            Resolved Underlay (Below)
          </span>
          <span className="legend-item">
            <span className="legend-line" style={{ background: '#f59e0b' }} />
            Blast Radius (Above)
          </span>
          <span className="legend-item">
            <span className="legend-line" style={{ background: '#ef4444' }} />
            Down / Failed
          </span>
        </div>

        <div className="hud-pill" style={{ fontSize: 11 }}>
          <span>Scroll: Zoom · Drag: Pan / Move Node · Click Group [-]: Fold Container</span>
        </div>
      </div>

      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        onWheel={handleWheel}
        onPointerDown={handlePointerDownCanvas}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUpCanvas}
        style={{ cursor: 'grab', display: 'block', userSelect: 'none' }}
      >
        <defs>
          <pattern id="netviz-grid" width="36" height="36" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="rgba(148, 163, 184, 0.12)" />
          </pattern>
        </defs>

        <rect width="100%" height="100%" fill="url(#netviz-grid)" />

        <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.k})`}>
          {/* 1. Swimlane Layer Bands */}
          {swimlaneBands.map((band) => (
            <g key={`band-${band.layer.id}`}>
              <rect
                x={band.x}
                y={band.y}
                width={band.width}
                height={band.height}
                rx={14}
                fill={band.layer.color}
                fillOpacity={0.035}
                stroke={band.layer.color}
                strokeOpacity={0.18}
                strokeDasharray="6 6"
              />
              <text
                x={band.x + 16}
                y={band.y + 22}
                fill={band.layer.color}
                fontSize={12}
                fontWeight={700}
                opacity={0.85}
              >
                {band.layer.name}
              </text>
            </g>
          ))}

          {/* 2. Expanded Compound Group Bounding Boxes */}
          {layout.groupBoxes.map((gb) => {
            const gColor = gb.group.color ?? '#64748b';
            return (
              <g key={`gbox-${gb.key}`}>
                <rect
                  x={gb.x}
                  y={gb.y}
                  width={gb.width}
                  height={gb.height}
                  rx={10}
                  fill={gColor}
                  fillOpacity={gb.depth === 0 ? 0.04 : 0.06}
                  stroke={gColor}
                  strokeOpacity={0.38}
                  strokeWidth={gb.depth === 0 ? 1.5 : 1.2}
                  strokeDasharray={gb.depth === 0 ? undefined : '5 4'}
                />
                {/* Clickable Header Pill to Collapse Group */}
                <g
                  style={{ cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleGroupCollapse(gb.group.id);
                  }}
                >
                  <rect
                    x={gb.x + 10}
                    y={gb.y + 7}
                    width={Math.min(gb.width - 20, gb.group.name.length * 7 + 34)}
                    height={20}
                    rx={5}
                    fill="rgba(9, 15, 29, 0.85)"
                    stroke={gColor}
                    strokeOpacity={0.45}
                  />
                  <text
                    x={gb.x + 18}
                    y={gb.y + 21}
                    fill="#e2e8f0"
                    fontSize={10.5}
                    fontWeight={600}
                  >
                    [-] {gb.group.name}
                  </text>
                </g>
              </g>
            );
          })}

          {/* 3. Cross-Layer Hosting Dependency Pillars */}
          {(showHostingLines || trace.hasSelection) &&
            folded.nodes.map((rn) =>
              rn.hostedOn.map((hostId) => {
                const upPos = layout.positions.get(rn.id);
                const lowPos = layout.positions.get(hostId);
                if (!upPos || !lowPos) return null;

                const upInTrace =
                  trace.primaryRenderNodeIds.has(rn.id) ||
                  trace.underlayRenderNodeIds.has(rn.id) ||
                  trace.blastRenderNodeIds.has(rn.id);
                const lowInTrace =
                  trace.primaryRenderNodeIds.has(hostId) ||
                  trace.underlayRenderNodeIds.has(hostId) ||
                  trace.blastRenderNodeIds.has(hostId);

                const activePillar = trace.hasSelection && upInTrace && lowInTrace;
                if (!showHostingLines && !activePillar) return null;

                const stroke = activePillar
                  ? trace.blastRenderNodeIds.has(rn.id)
                    ? '#f59e0b'
                    : '#2dd4bf'
                  : 'rgba(148, 163, 184, 0.22)';

                return (
                  <line
                    key={`host-${rn.id}-${hostId}`}
                    x1={upPos.x}
                    y1={upPos.y}
                    x2={lowPos.x}
                    y2={lowPos.y}
                    stroke={stroke}
                    strokeWidth={activePillar ? 2.2 : 1.1}
                    strokeDasharray={activePillar ? '6 4' : '3 5'}
                    opacity={trace.hasSelection && !activePillar ? 0.08 : 0.9}
                    className={activePillar ? 'trace-animated' : undefined}
                  />
                );
              })
            )}

          {/* 4. Intra-Layer Network Links */}
          {folded.links.map((rl) => {
            const geom = computeLinkPath(rl);
            if (!geom) return null;
            const { isSelected, isUnderlay, isBlast, dimmed } = getLinkVisualState(rl);
            const layerColor = layerMap.get(rl.layer)?.color ?? '#94a3b8';

            let stroke = layerColor;
            let width = rl.isAggregated ? 2.8 : 2;
            if (rl.health.status === 'down') stroke = '#ef4444';
            else if (rl.health.status === 'degraded') stroke = '#f59e0b';

            if (isSelected) {
              stroke = '#38bdf8';
              width = 3.8;
            } else if (isUnderlay) {
              stroke = rl.health.status === 'down' ? '#ef4444' : '#2dd4bf';
              width = 3.2;
            } else if (isBlast) {
              stroke = rl.health.status === 'down' ? '#ef4444' : '#f59e0b';
              width = 3.0;
            }

            const baseOpacity = rl.visibility === 'ghost' ? 0.24 : 0.78;
            const opacity = dimmed
              ? 0.09
              : isSelected || isUnderlay || isBlast
              ? 1
              : baseOpacity;

            const showPill =
              isSelected ||
              isUnderlay ||
              isBlast ||
              hoveredId === rl.id ||
              rl.isAggregated ||
              rl.health.status !== 'up';

            const pillText =
              rl.label ?? rl.encapsulation ?? rl.bandwidth ?? rl.type;

            return (
              <g
                key={rl.id}
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHoveredId(rl.id)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect({ kind: 'link', id: rl.id });
                }}
              >
                {/* Wide transparent hit target */}
                <path d={geom.d} fill="none" stroke="transparent" strokeWidth={15} />

                {/* Main Link Path */}
                <path
                  d={geom.d}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={width}
                  opacity={opacity}
                  strokeDasharray={
                    rl.health.status === 'down' ? '4 4' : undefined
                  }
                />

                {/* Animated Trace Overlay */}
                {(isSelected || isUnderlay || isBlast) && rl.health.status !== 'down' && (
                  <path
                    d={geom.d}
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth={1.6}
                    opacity={0.75}
                    className="trace-animated"
                  />
                )}

                {/* Link Label / Status Pill */}
                {showPill && !dimmed && pillText && (
                  <g transform={`translate(${geom.midX}, ${geom.midY})`}>
                    <rect
                      x={-(pillText.length * 3.1 + 10)}
                      y={-9}
                      width={pillText.length * 6.2 + 20}
                      height={18}
                      rx={5}
                      fill="rgba(7, 12, 23, 0.92)"
                      stroke={stroke}
                      strokeWidth={1}
                    />
                    <text
                      x={0}
                      y={3.5}
                      textAnchor="middle"
                      fill="#e2e8f0"
                      fontSize={9.5}
                      fontWeight={600}
                    >
                      {rl.health.status === 'down' ? `✕ ${pillText}` : pillText}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* 5. Network Nodes & Collapsed Group Proxies */}
          {folded.nodes.map((rn) => {
            const pos = layout.positions.get(rn.id);
            if (!pos) return null;
            const { isSelected, isUnderlay, isBlast, dimmed } = getNodeVisualState(rn);
            const layerSpec = layerMap.get(rn.layer);
            const layerColor = layerSpec?.color ?? '#38bdf8';
            const isSimFailed = rn.memberNodeIds.some((id) => sim.failedNodeIds.has(id));

            let borderColor = layerColor;
            let borderWidth = 1.6;
            if (isSelected) {
              borderColor = '#ffffff';
              borderWidth = 2.8;
            } else if (isUnderlay) {
              borderColor = '#2dd4bf';
              borderWidth = 2.5;
            } else if (isBlast) {
              borderColor = '#f59e0b';
              borderWidth = 2.5;
            } else if (rn.health.status === 'down') {
              borderColor = '#ef4444';
              borderWidth = 2.2;
            }

            const baseOpacity = rn.visibility === 'ghost' ? 0.34 : 1;
            const opacity = dimmed
              ? 0.14
              : isSelected || isUnderlay || isBlast
              ? 1
              : baseOpacity;

            const boxW = rn.isCollapsedGroup ? 156 : 142;
            const boxH = rn.isCollapsedGroup ? 54 : 48;

            return (
              <g
                key={rn.id}
                transform={`translate(${pos.x}, ${pos.y})`}
                opacity={opacity}
                style={{ cursor: 'pointer' }}
                onPointerDown={(e) => handlePointerDownNode(e, rn)}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect({ kind: 'node', id: rn.id });
                }}
                onDoubleClick={(e) => {
                  if (rn.isCollapsedGroup && rn.collapsedGroupSpec) {
                    e.stopPropagation();
                    onToggleGroupCollapse(rn.collapsedGroupSpec.id);
                  }
                }}
              >
                {/* Glow Halo when Traced or Selected */}
                {(isSelected || isUnderlay || isBlast) && (
                  <rect
                    x={-boxW / 2 - 4}
                    y={-boxH / 2 - 4}
                    width={boxW + 8}
                    height={boxH + 8}
                    rx={12}
                    fill="none"
                    stroke={isSelected ? '#38bdf8' : isUnderlay ? '#2dd4bf' : '#f59e0b'}
                    strokeWidth={2}
                    opacity={0.45}
                  />
                )}

                {/* Stacked Shadow Effect for Collapsed Groups */}
                {rn.isCollapsedGroup && (
                  <rect
                    x={-boxW / 2 + 5}
                    y={-boxH / 2 + 5}
                    width={boxW}
                    height={boxH}
                    rx={9}
                    fill="#0b1324"
                    stroke={borderColor}
                    strokeOpacity={0.5}
                  />
                )}

                {/* Node Card Body */}
                <rect
                  x={-boxW / 2}
                  y={-boxH / 2}
                  width={boxW}
                  height={boxH}
                  rx={9}
                  fill="#0f172a"
                  stroke={borderColor}
                  strokeWidth={borderWidth}
                />

                {/* Left Layer Color Accent Bar */}
                <rect
                  x={-boxW / 2 + 3}
                  y={-boxH / 2 + 5}
                  width={4}
                  height={boxH - 10}
                  rx={2}
                  fill={layerColor}
                />

                {/* Health Dot */}
                <circle
                  cx={boxW / 2 - 11}
                  cy={-boxH / 2 + 11}
                  r={4.2}
                  fill={statusColor(rn.health.status)}
                />

                {/* Primary Label */}
                <text
                  x={-boxW / 2 + 14}
                  y={-3}
                  fill="#f8fafc"
                  fontSize={11.5}
                  fontWeight={700}
                >
                  {rn.label.length > 18 ? `${rn.label.slice(0, 17)}…` : rn.label}
                </text>

                {/* Sub-caption: Type / Layer order / Expand action */}
                <text
                  x={-boxW / 2 + 14}
                  y={13}
                  fill="#94a3b8"
                  fontSize={9.5}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  {rn.isCollapsedGroup
                    ? '[+] Double-click expand'
                    : `L${layerSpec?.order ?? 0} · ${rn.type}`}
                </text>

                {/* Simulated Failure Tag */}
                {isSimFailed && (
                  <g transform={`translate(${boxW / 2 - 28}, ${boxH / 2 - 8})`}>
                    <rect x={-22} y={-8} width={44} height={14} rx={4} fill="#dc2626" />
                    <text
                      x={0}
                      y={2}
                      textAnchor="middle"
                      fill="#fff"
                      fontSize={8.5}
                      fontWeight={700}
                    >
                      FAILED
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
};
