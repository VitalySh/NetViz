import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Layers, PanelLeftOpen, PanelRightOpen } from 'lucide-react';
import { TopBar, type ViewMode } from './components/TopBar';
import { LayerStackPanel } from './components/LayerStackPanel';
import { Graph2DView } from './components/Graph2DView';
import { Graph3DView } from './components/Graph3DView';
import { InspectorPanel } from './components/InspectorPanel';
import { YamlDrawer } from './components/YamlDrawer';
import { BUILTIN_EXAMPLES } from './examples/catalog';
import { parseNetworkYaml } from './schema/parser';
import type { LayerVisibilityMode, NetworkConfig } from './schema/types';
import { resolveCrossLayerTopology, type FailureSimulationState } from './engine/resolver';
import { buildFoldedGraph } from './engine/grouping';
import { computeLayout, type Layout2DMode } from './engine/layout';
import { computeHighlightTrace, type SelectionTarget } from './engine/selectionTrace';

export const App: React.FC = () => {
  const [yamlText, setYamlText] = useState<string>(BUILTIN_EXAMPLES[0].yaml);
  const [activeSourceLabel, setActiveSourceLabel] = useState<string>(
    BUILTIN_EXAMPLES[0].fileName
  );
  const [isWatchingLocal, setIsWatchingLocal] = useState<boolean>(false);
  const [availableServerFiles, setAvailableServerFiles] = useState<string[]>([]);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>('3d');
  const [layout2DMode, setLayout2DMode] = useState<Layout2DMode>('swimlanes');
  const [yamlDrawerOpen, setYamlDrawerOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [topBarCollapsed, setTopBarCollapsed] = useState<boolean>(false);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState<boolean>(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState<boolean>(false);

  const [layerModes, setLayerModes] = useState<Map<string, LayerVisibilityMode>>(new Map());
  const [soloLayerId, setSoloLayerId] = useState<string | null>(null);
  const [ghostPhysicalOnSolo, setGhostPhysicalOnSolo] = useState<boolean>(true);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<SelectionTarget>(null);

  const [sim, setSim] = useState<FailureSimulationState>({
    failedNodeIds: new Set(),
    failedLinkIds: new Set(),
  });

  const [manualNodePositions, setManualNodePositions] = useState<
    Map<string, { x: number; y: number }>
  >(new Map());

  // Connect to local Vite / CLI file watcher SSE stream if available
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;

    fetch('/api/topology')
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => {
        if (cancelled || !payload) return;
        if (Array.isArray(payload.availableFiles)) {
          setAvailableServerFiles(payload.availableFiles);
        }
        if (payload.hasFile && typeof payload.yaml === 'string') {
          setYamlText(payload.yaml);
          setActiveSourceLabel(payload.relativePath || payload.filePath || 'watched.yaml');
          setIsWatchingLocal(true);
        }

        es = new EventSource('/api/events');
        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            if (Array.isArray(data.availableFiles)) {
              setAvailableServerFiles(data.availableFiles);
            }
            if (data.hasFile && typeof data.yaml === 'string') {
              setYamlText(data.yaml);
              setActiveSourceLabel(data.relativePath || data.filePath || 'watched.yaml');
              setIsWatchingLocal(true);
            }
          } catch {
            // ignore malformed event
          }
        };
      })
      .catch(() => {
        // Pure static client mode (no watcher server running)
      });

    return () => {
      cancelled = true;
      if (es) es.close();
    };
  }, []);

  // Parse YAML and keep last valid config during live editing
  const parseResult = useMemo(() => parseNetworkYaml(yamlText), [yamlText]);
  const lastValidConfigRef = useRef<NetworkConfig | null>(null);
  if (parseResult.config) {
    lastValidConfigRef.current = parseResult.config;
  }
  const activeConfig = parseResult.config ?? lastValidConfigRef.current;

  // Initialize default collapsed groups & layer modes when switching topologies
  const prevTopologyNameRef = useRef<string>('');
  useEffect(() => {
    if (!activeConfig) return;
    if (prevTopologyNameRef.current !== activeConfig.metadata.name) {
      prevTopologyNameRef.current = activeConfig.metadata.name;
      const nextModes = new Map<string, LayerVisibilityMode>();
      for (const l of activeConfig.layers) nextModes.set(l.id, 'visible');
      setLayerModes(nextModes);
      setSoloLayerId(null);

      const defaultCollapsed = new Set<string>();
      for (const g of activeConfig.groups) {
        if (g.collapsedByDefault) defaultCollapsed.add(g.id);
      }
      setCollapsedGroupIds(defaultCollapsed);
      setSelection(null);
      setManualNodePositions(new Map());
      setSim({ failedNodeIds: new Set(), failedLinkIds: new Set() });
    }
  }, [activeConfig]);

  // Apply Solo mode calculation
  const effectiveLayerModes = useMemo(() => {
    const map = new Map<string, LayerVisibilityMode>();
    if (!activeConfig) return map;
    const bottomLayerId = [...activeConfig.layers].sort((a, b) => a.order - b.order)[0]?.id;

    for (const l of activeConfig.layers) {
      if (soloLayerId) {
        if (l.id === soloLayerId) {
          map.set(l.id, 'visible');
        } else if (ghostPhysicalOnSolo && l.id === bottomLayerId) {
          map.set(l.id, 'ghost');
        } else {
          map.set(l.id, 'hidden');
        }
      } else {
        map.set(l.id, layerModes.get(l.id) ?? 'visible');
      }
    }
    return map;
  }, [activeConfig, soloLayerId, ghostPhysicalOnSolo, layerModes]);

  const resolution = useMemo(() => {
    if (!activeConfig) return null;
    return resolveCrossLayerTopology(activeConfig, sim);
  }, [activeConfig, sim]);

  const folded = useMemo(() => {
    if (!activeConfig || !resolution) return null;
    return buildFoldedGraph(
      activeConfig,
      collapsedGroupIds,
      effectiveLayerModes,
      resolution.nodeHealth,
      resolution.linkHealth
    );
  }, [activeConfig, resolution, collapsedGroupIds, effectiveLayerModes]);

  const layout = useMemo(() => {
    if (!activeConfig || !folded) return null;
    return computeLayout(activeConfig, folded, layout2DMode, manualNodePositions);
  }, [activeConfig, folded, layout2DMode, manualNodePositions]);

  const trace = useMemo(() => {
    if (!activeConfig || !resolution || !folded) {
      return computeHighlightTrace(
        null,
        { metadata: { name: '' }, layers: [], groups: [], nodes: [], links: [] },
        {
          linkUnderlayMap: new Map(),
          nodeAncestorsMap: new Map(),
          nodeDependentsMap: new Map(),
          linkDependentsMap: new Map(),
          nodeImpactedLinksMap: new Map(),
          nodeHealth: new Map(),
          linkHealth: new Map(),
        },
        { nodes: [], links: [], expandedGroups: [], nodeToRenderId: new Map() }
      );
    }
    return computeHighlightTrace(selection, activeConfig, resolution, folded);
  }, [selection, activeConfig, resolution, folded]);

  // Handlers
  const handleSelectServerFile = useCallback((relPath: string) => {
    fetch(`/api/topology?file=${encodeURIComponent(relPath)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => {
        if (payload?.hasFile && typeof payload.yaml === 'string') {
          setYamlText(payload.yaml);
          setActiveSourceLabel(payload.relativePath || relPath);
          setIsWatchingLocal(true);
        }
      });
  }, []);

  const handleSelectBuiltin = useCallback((exampleId: string) => {
    const found = BUILTIN_EXAMPLES.find((ex) => ex.id === exampleId);
    if (!found) return;
    setYamlText(found.yaml);
    setActiveSourceLabel(found.fileName);
    setIsWatchingLocal(false);
  }, []);

  const handleImportLocalFile = useCallback((fileName: string, content: string) => {
    setYamlText(content);
    setActiveSourceLabel(fileName);
    setIsWatchingLocal(false);
  }, []);

  const handleSaveToDisk = useCallback(() => {
    setSaveStatus('Saving...');
    fetch('/api/topology', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml: yamlText }),
    })
      .then((r) => {
        setSaveStatus(r.ok ? 'Saved ✓' : 'Error');
        setTimeout(() => setSaveStatus(null), 1800);
      })
      .catch(() => {
        setSaveStatus('Offline');
        setTimeout(() => setSaveStatus(null), 1800);
      });
  }, [yamlText]);

  const handleSetLayerMode = useCallback((layerId: string, mode: LayerVisibilityMode) => {
    setSoloLayerId(null);
    setLayerModes((prev) => {
      const next = new Map(prev);
      next.set(layerId, mode);
      return next;
    });
  }, []);

  const handleToggleSoloLayer = useCallback((layerId: string) => {
    setSoloLayerId((prev) => (prev === layerId ? null : layerId));
  }, []);

  const handleShowAllLayers = useCallback(() => {
    setSoloLayerId(null);
    if (!activeConfig) return;
    const next = new Map<string, LayerVisibilityMode>();
    for (const l of activeConfig.layers) next.set(l.id, 'visible');
    setLayerModes(next);
  }, [activeConfig]);

  const handleToggleGroupCollapse = useCallback((groupId: string) => {
    setCollapsedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const handleCollapseByType = useCallback(
    (groupType: string | 'all' | 'none') => {
      if (!activeConfig) return;
      if (groupType === 'none') {
        setCollapsedGroupIds(new Set());
      } else if (groupType === 'all') {
        // Collapse top-level groups
        setCollapsedGroupIds(
          new Set(activeConfig.groups.filter((g) => !g.parent).map((g) => g.id))
        );
      } else {
        setCollapsedGroupIds(
          new Set(
            activeConfig.groups
              .filter((g) => g.type.toLowerCase() === groupType.toLowerCase())
              .map((g) => g.id)
          )
        );
      }
    },
    [activeConfig]
  );

  const handleToggleFailNode = useCallback((nodeId: string) => {
    setSim((prev) => {
      const nextNodes = new Set(prev.failedNodeIds);
      if (nextNodes.has(nodeId)) nextNodes.delete(nodeId);
      else nextNodes.add(nodeId);
      return { failedNodeIds: nextNodes, failedLinkIds: prev.failedLinkIds };
    });
  }, []);

  const handleToggleFailLink = useCallback((linkId: string) => {
    setSim((prev) => {
      const nextLinks = new Set(prev.failedLinkIds);
      if (nextLinks.has(linkId)) nextLinks.delete(linkId);
      else nextLinks.add(linkId);
      return { failedNodeIds: prev.failedNodeIds, failedLinkIds: nextLinks };
    });
  }, []);

  const handleResetFailures = useCallback(() => {
    setSim({ failedNodeIds: new Set(), failedLinkIds: new Set() });
  }, []);

  const handleNodeDrag = useCallback((nodeId: string, pos: { x: number; y: number }) => {
    setManualNodePositions((prev) => {
      const next = new Map(prev);
      next.set(nodeId, pos);
      return next;
    });
  }, []);

  const failedCount = sim.failedNodeIds.size + sim.failedLinkIds.size;

  if (!activeConfig || !resolution || !folded || !layout) {
    return (
      <div className="app-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div>Unable to parse YAML topology. Check YAML syntax.</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {!topBarCollapsed ? (
        <TopBar
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          activeSourceLabel={activeSourceLabel}
          isWatchingLocal={isWatchingLocal}
          availableServerFiles={availableServerFiles}
          onSelectBuiltin={handleSelectBuiltin}
          onSelectServerFile={handleSelectServerFile}
          onImportLocalFile={handleImportLocalFile}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          failedCount={failedCount}
          onResetFailures={handleResetFailures}
          yamlDrawerOpen={yamlDrawerOpen}
          onToggleYamlDrawer={() => setYamlDrawerOpen((v) => !v)}
          leftPanelCollapsed={leftPanelCollapsed}
          onToggleLeftPanel={() => setLeftPanelCollapsed((v) => !v)}
          rightPanelCollapsed={rightPanelCollapsed}
          onToggleRightPanel={() => setRightPanelCollapsed((v) => !v)}
          onCollapseTopBar={() => setTopBarCollapsed(true)}
        />
      ) : (
        <button
          className="collapsed-topbar-tab"
          onClick={() => setTopBarCollapsed(false)}
          title="Expand top bar"
        >
          <Layers size={13} color="#38bdf8" />
          <span>NetViz</span>
          {failedCount > 0 && (
            <span
              style={{
                background: 'rgba(239, 68, 68, 0.25)',
                color: '#fca5a5',
                border: '1px solid rgba(239, 68, 68, 0.5)',
                borderRadius: 999,
                padding: '0 6px',
                fontSize: 10.5,
              }}
            >
              {failedCount} down
            </span>
          )}
          <ChevronDown size={13} />
        </button>
      )}

      <div className="workspace-body">
        {!leftPanelCollapsed ? (
          <LayerStackPanel
            config={activeConfig}
            resolution={resolution}
            layerModes={effectiveLayerModes}
            soloLayerId={soloLayerId}
            ghostPhysicalOnSolo={ghostPhysicalOnSolo}
            onSetLayerMode={handleSetLayerMode}
            onToggleSoloLayer={handleToggleSoloLayer}
            onToggleGhostPhysicalOnSolo={() => setGhostPhysicalOnSolo((v) => !v)}
            onShowAllLayers={handleShowAllLayers}
            collapsedGroupIds={collapsedGroupIds}
            onToggleGroupCollapse={handleToggleGroupCollapse}
            onCollapseByType={handleCollapseByType}
            onCollapse={() => setLeftPanelCollapsed(true)}
          />
        ) : (
          <button
            className="collapsed-side-tab left"
            onClick={() => setLeftPanelCollapsed(false)}
            title="Expand Layer Stack panel"
          >
            <PanelLeftOpen size={15} />
            <span className="collapsed-side-label">Layers</span>
          </button>
        )}

        <main className="viewport-area">
          {(viewMode === '2d' || viewMode === 'split') && (
            <div className="split-pane">
              <Graph2DView
                config={activeConfig}
                folded={folded}
                layout={layout}
                layout2DMode={layout2DMode}
                onChangeLayout2DMode={setLayout2DMode}
                selection={selection}
                onSelect={setSelection}
                trace={trace}
                searchQuery={searchQuery}
                sim={sim}
                onToggleGroupCollapse={handleToggleGroupCollapse}
                onNodeDrag={handleNodeDrag}
              />
            </div>
          )}

          {(viewMode === '3d' || viewMode === 'split') && (
            <div className="split-pane">
              <Graph3DView
                config={activeConfig}
                folded={folded}
                layout={layout}
                selection={selection}
                onSelect={setSelection}
                trace={trace}
                searchQuery={searchQuery}
              />
            </div>
          )}

          <YamlDrawer
            open={yamlDrawerOpen}
            onClose={() => setYamlDrawerOpen(false)}
            yamlText={yamlText}
            onChangeYaml={setYamlText}
            issues={parseResult.issues}
            isWatchingLocal={isWatchingLocal}
            activeSourceLabel={activeSourceLabel}
            onSaveToDisk={handleSaveToDisk}
            saveStatus={saveStatus}
          />
        </main>

        {!rightPanelCollapsed ? (
          <InspectorPanel
            config={activeConfig}
            resolution={resolution}
            folded={folded}
            selection={selection}
            onSelect={setSelection}
            trace={trace}
            sim={sim}
            onToggleFailNode={handleToggleFailNode}
            onToggleFailLink={handleToggleFailLink}
            onCollapse={() => setRightPanelCollapsed(true)}
          />
        ) : (
          <button
            className="collapsed-side-tab right"
            onClick={() => setRightPanelCollapsed(false)}
            title="Expand Inspector panel"
          >
            <PanelRightOpen size={15} />
            {selection && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: '#38bdf8',
                  boxShadow: '0 0 6px #38bdf8',
                }}
              />
            )}
            <span className="collapsed-side-label">Inspector</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default App;
