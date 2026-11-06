import React from 'react';
import { AlertTriangle, CheckCircle2, Download, Save, X } from 'lucide-react';
import type { ValidationIssue } from '../schema/types';

interface YamlDrawerProps {
  open: boolean;
  onClose: () => void;
  yamlText: string;
  onChangeYaml: (next: string) => void;
  issues: ValidationIssue[];
  isWatchingLocal: boolean;
  activeSourceLabel: string;
  onSaveToDisk: () => void;
  saveStatus: string | null;
}

export const YamlDrawer: React.FC<YamlDrawerProps> = ({
  open,
  onClose,
  yamlText,
  onChangeYaml,
  issues,
  isWatchingLocal,
  activeSourceLabel,
  onSaveToDisk,
  saveStatus,
}) => {
  if (!open) return null;

  const handleDownload = () => {
    const blob = new Blob([yamlText], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeSourceLabel.endsWith('.yaml') || activeSourceLabel.endsWith('.yml')
      ? activeSourceLabel.split('/').pop()!
      : 'network-topology.yaml';
    a.click();
    URL.revokeObjectURL(url);
  };

  const errorCount = issues.filter((i) => i.severity === 'error').length;

  return (
    <div className="yaml-drawer">
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: '#0c1322',
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Live YAML Configuration</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{activeSourceLabel}</div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isWatchingLocal && (
            <button
              className="btn btn-primary"
              onClick={onSaveToDisk}
              disabled={errorCount > 0}
              title="Write changes directly to the watched local YAML file"
            >
              <Save size={13} />
              <span>{saveStatus ?? 'Save to Disk'}</span>
            </button>
          )}
          <button className="btn" onClick={handleDownload}>
            <Download size={13} />
            <span>Export .yaml</span>
          </button>
          <button className="mini-btn" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Validation Status Bar */}
      <div
        style={{
          padding: '7px 14px',
          fontSize: 11.5,
          borderBottom: '1px solid var(--border-subtle)',
          background: errorCount > 0 ? 'rgba(239, 68, 68, 0.12)' : 'rgba(16, 185, 129, 0.08)',
          maxHeight: 130,
          overflowY: 'auto',
        }}
      >
        {issues.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#34d399' }}>
            <CheckCircle2 size={13} />
            <span>Schema &amp; cross-layer references valid — rendering live</span>
          </div>
        ) : (
          issues.map((iss, idx) => (
            <div
              key={idx}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
                color: iss.severity === 'error' ? '#fca5a5' : '#fde68a',
                marginBottom: 3,
              }}
            >
              <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                {iss.line ? `[Line ${iss.line}] ` : ''}
                {iss.message}
              </span>
            </div>
          ))
        )}
      </div>

      <textarea
        className="yaml-textarea"
        value={yamlText}
        onChange={(e) => onChangeYaml(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
};
