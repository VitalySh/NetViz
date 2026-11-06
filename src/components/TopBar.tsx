import React, { useRef } from 'react';
import {
  Box,
  Code2,
  Columns2,
  FolderOpen,
  Layers,
  Network,
  RotateCcw,
  Search,
  ZapOff,
} from 'lucide-react';
import { BUILTIN_EXAMPLES } from '../examples/catalog';

export type ViewMode = '2d' | '3d' | 'split';

interface TopBarProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  activeSourceLabel: string;
  isWatchingLocal: boolean;
  availableServerFiles: string[];
  onSelectBuiltin: (exampleId: string) => void;
  onSelectServerFile: (relPath: string) => void;
  onImportLocalFile: (fileName: string, content: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  failedCount: number;
  onResetFailures: () => void;
  yamlDrawerOpen: boolean;
  onToggleYamlDrawer: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  viewMode,
  onViewModeChange,
  activeSourceLabel,
  isWatchingLocal,
  availableServerFiles,
  onSelectBuiltin,
  onSelectServerFile,
  onImportLocalFile,
  searchQuery,
  onSearchChange,
  failedCount,
  onResetFailures,
  yamlDrawerOpen,
  onToggleYamlDrawer,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDropdownChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val.startsWith('server:')) {
      onSelectServerFile(val.slice('server:'.length));
    } else if (val.startsWith('builtin:')) {
      onSelectBuiltin(val.slice('builtin:'.length));
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        onImportLocalFile(file.name, reader.result);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const currentSelectValue = availableServerFiles.includes(activeSourceLabel)
    ? `server:${activeSourceLabel}`
    : BUILTIN_EXAMPLES.some((ex) => ex.fileName === activeSourceLabel || ex.id === activeSourceLabel)
    ? `builtin:${
        BUILTIN_EXAMPLES.find(
          (ex) => ex.fileName === activeSourceLabel || ex.id === activeSourceLabel
        )!.id
      }`
    : '';

  return (
    <header className="topbar">
      <div className="topbar-group">
        <div className="brand-badge">
          <div className="brand-icon">
            <Layers size={16} />
          </div>
          <span>NetViz</span>
        </div>

        <select
          className="select-input"
          value={currentSelectValue}
          onChange={handleDropdownChange}
          title="Select YAML network configuration"
          style={{ maxWidth: 260 }}
        >
          {currentSelectValue === '' && (
            <option value="">📄 {activeSourceLabel}</option>
          )}
          {availableServerFiles.length > 0 && (
            <optgroup label="Watched Workspace YAML Files">
              {availableServerFiles.map((f) => (
                <option key={f} value={`server:${f}`}>
                  {f}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Built-in Reference Topologies">
            {BUILTIN_EXAMPLES.map((ex) => (
              <option key={ex.id} value={`builtin:${ex.id}`}>
                {ex.title}
              </option>
            ))}
          </optgroup>
        </select>

        <button
          className="btn"
          onClick={() => fileInputRef.current?.click()}
          title="Load a .yaml / .yml file from disk"
        >
          <FolderOpen size={14} />
          <span>Open YAML</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".yaml,.yml"
          style={{ display: 'none' }}
          onChange={handleFileUpload}
        />

        {isWatchingLocal && (
          <div className="watch-pill" title="Live file watcher connected — edits on disk auto-reload">
            <span className="pulse-dot" />
            <span>Watching: {activeSourceLabel}</span>
          </div>
        )}
      </div>

      {/* Center View Mode Switcher */}
      <div className="topbar-group">
        <div className="segmented-control">
          <button
            className={`seg-btn ${viewMode === '2d' ? 'active' : ''}`}
            onClick={() => onViewModeChange('2d')}
          >
            <Network size={14} />
            <span>2D Topology</span>
          </button>
          <button
            className={`seg-btn ${viewMode === '3d' ? 'active' : ''}`}
            onClick={() => onViewModeChange('3d')}
          >
            <Box size={14} />
            <span>3D Stacked Planes</span>
          </button>
          <button
            className={`seg-btn ${viewMode === 'split' ? 'active' : ''}`}
            onClick={() => onViewModeChange('split')}
          >
            <Columns2 size={14} />
            <span>Split 2D + 3D</span>
          </button>
        </div>
      </div>

      {/* Right Search, Failure Sim Status & YAML Editor */}
      <div className="topbar-group">
        {failedCount > 0 && (
          <button
            className="btn btn-danger"
            onClick={onResetFailures}
            title="Clear all simulated node/link failures"
          >
            <ZapOff size={13} />
            <span>{failedCount} Simulated Failure{failedCount > 1 ? 's' : ''}</span>
            <RotateCcw size={12} />
          </button>
        )}

        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search
            size={13}
            style={{ position: 'absolute', left: 9, color: 'var(--text-muted)', pointerEvents: 'none' }}
          />
          <input
            type="text"
            className="search-input"
            placeholder="Filter or find node..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            style={{ paddingLeft: 28, width: 170 }}
          />
        </div>

        <button
          className={`btn ${yamlDrawerOpen ? 'btn-primary' : ''}`}
          onClick={onToggleYamlDrawer}
        >
          <Code2 size={14} />
          <span>YAML Source</span>
        </button>
      </div>
    </header>
  );
};
