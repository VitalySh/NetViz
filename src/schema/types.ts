export type HealthStatus = 'up' | 'degraded' | 'down';

export type LayerKind = 'physical' | 'underlay' | 'overlay' | 'service' | string;

export interface NetworkMetadata {
  name: string;
  description?: string;
  version?: string;
  tags?: string[];
}

export interface LayerSpec {
  id: string;
  name: string;
  order: number;
  kind?: LayerKind;
  color: string;
  description?: string;
}

export interface GroupSpec {
  id: string;
  name: string;
  type: string;
  parent?: string;
  layer?: string;
  collapsedByDefault?: boolean;
  color?: string;
  description?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface PortSpec {
  id: string;
  ip?: string;
  speed?: string;
  vlan?: number | string;
}

export interface NodeSpec {
  id: string;
  label: string;
  layer: string;
  type: string;
  role?: string;
  group?: string;
  hostedOn: string[];
  status: HealthStatus;
  ports?: PortSpec[];
  position?: { x: number; y: number };
  metadata?: Record<string, string | number | boolean>;
}

export interface LinkSpec {
  id: string;
  label?: string;
  layer: string;
  source: string;
  target: string;
  sourcePort?: string;
  targetPort?: string;
  type: string;
  encapsulation?: string;
  bandwidth?: string;
  status: HealthStatus;
  bidirectional: boolean;
  carriedBy?: string[];
  autoResolveUnderlay: boolean;
  metadata?: Record<string, string | number | boolean>;
}

export interface NetworkConfig {
  metadata: NetworkMetadata;
  layers: LayerSpec[];
  groups: GroupSpec[];
  nodes: NodeSpec[];
  links: LinkSpec[];
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  path?: string;
  line?: number;
}

export interface ParseResult {
  config: NetworkConfig | null;
  issues: ValidationIssue[];
}

export type LayerVisibilityMode = 'visible' | 'ghost' | 'hidden';

export interface EffectiveHealth {
  status: HealthStatus;
  reason?: string;
  activePaths?: number;
  totalPaths?: number;
}

export interface ResolvedLayerTrace {
  layerId: string;
  nodeIds: string[];
  linkIds: string[];
  /** Individual elementary paths (for ECMP inspection) in this layer */
  ecmpPaths: Array<{
    nodeIds: string[];
    linkIds: string[];
    healthy: boolean;
  }>;
  inferred: boolean;
}

export interface CrossLayerResolution {
  /** Downward trace for each linkId -> map of lower layerId -> ResolvedLayerTrace */
  linkUnderlayMap: Map<string, Map<string, ResolvedLayerTrace>>;
  /** Downward hosting ancestors for each nodeId (all lower layers recursively) */
  nodeAncestorsMap: Map<string, Set<string>>;
  /** Upward hosted dependents for each nodeId (all upper layers recursively) */
  nodeDependentsMap: Map<string, Set<string>>;
  /** Upward dependent links for each linkId (all upper overlay links that rely on this link) */
  linkDependentsMap: Map<string, Set<string>>;
  /** Upward dependent links for each nodeId (overlay links whose endpoints or transit rely on this node) */
  nodeImpactedLinksMap: Map<string, Set<string>>;
  /** Effective health per node accounting for simulated failures & underlay outages */
  nodeHealth: Map<string, EffectiveHealth>;
  /** Effective health per link accounting for simulated failures, ECMP redundancy & underlay outages */
  linkHealth: Map<string, EffectiveHealth>;
}
