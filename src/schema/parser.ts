import { parseDocument } from 'yaml';
import { z } from 'zod';
import type {
  GroupSpec,
  LayerSpec,
  LinkSpec,
  NetworkConfig,
  NodeSpec,
  ParseResult,
  ValidationIssue,
} from './types';

const DEFAULT_LAYER_PALETTE = [
  '#38bdf8', // sky-400 (Physical)
  '#34d399', // emerald-400 (Underlay)
  '#a78bfa', // violet-400 (Fabric Overlay)
  '#fbbf24', // amber-400 (Cluster / Tenant Overlay)
  '#f472b6', // pink-400 (Service Mesh / App Overlay)
  '#fb7185', // rose-400
  '#2dd4bf', // teal-400
];

const ScalarRecordSchema = z.record(z.union([z.string(), z.number(), z.boolean()]));

const RawLayerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  order: z.number().int(),
  kind: z.string().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
});

const RawGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().default('group'),
  parent: z.string().optional(),
  layer: z.string().optional(),
  collapsedByDefault: z.boolean().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
  metadata: ScalarRecordSchema.optional(),
});

const RawPortSchema = z.object({
  id: z.string().min(1),
  ip: z.string().optional(),
  speed: z.string().optional(),
  vlan: z.union([z.number(), z.string()]).optional(),
});

const RawNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  layer: z.string().min(1),
  type: z.string().default('device'),
  role: z.string().optional(),
  group: z.string().optional(),
  hostedOn: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
  status: z.enum(['up', 'degraded', 'down']).default('up'),
  ports: z.array(RawPortSchema).optional(),
  position: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .optional(),
  metadata: ScalarRecordSchema.optional(),
});

const RawLinkSchema = z.object({
  id: z.string().optional(),
  label: z.string().optional(),
  layer: z.string().optional(),
  source: z.string().min(1),
  target: z.string().min(1),
  sourcePort: z.string().optional(),
  targetPort: z.string().optional(),
  type: z.string().default('link'),
  encapsulation: z.string().optional(),
  bandwidth: z.string().optional(),
  status: z.enum(['up', 'degraded', 'down']).default('up'),
  bidirectional: z.boolean().default(true),
  carriedBy: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  autoResolveUnderlay: z.boolean().default(true),
  metadata: ScalarRecordSchema.optional(),
});

const RawNetworkSchema = z.object({
  metadata: z
    .object({
      name: z.string().default('Untitled Network'),
      description: z.string().optional(),
      version: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
    .default({ name: 'Untitled Network' }),
  layers: z.array(RawLayerSchema).min(1, 'At least one network layer must be defined.'),
  groups: z.array(RawGroupSchema).default([]),
  nodes: z.array(RawNodeSchema).min(1, 'At least one node must be defined.'),
  links: z.array(RawLinkSchema).default([]),
});

export function parseNetworkYaml(yamlText: string): ParseResult {
  const issues: ValidationIssue[] = [];

  if (!yamlText.trim()) {
    return {
      config: null,
      issues: [{ severity: 'error', message: 'YAML configuration is empty.' }],
    };
  }

  const doc = parseDocument(yamlText, { prettyErrors: true });
  if (doc.errors.length > 0) {
    for (const err of doc.errors) {
      issues.push({
        severity: 'error',
        message: err.message,
        line: err.linePos?.[0]?.line,
      });
    }
    return { config: null, issues };
  }

  for (const warn of doc.warnings) {
    issues.push({
      severity: 'warning',
      message: warn.message,
      line: warn.linePos?.[0]?.line,
    });
  }

  const rawJson = doc.toJS();
  const parsed = RawNetworkSchema.safeParse(rawJson);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        severity: 'error',
        path: issue.path.join('.'),
        message: `${issue.path.join('.') || 'root'}: ${issue.message}`,
      });
    }
    return { config: null, issues };
  }

  const raw = parsed.data;

  // Sort layers ascending by order (0 = bottom/physical -> top overlay)
  const sortedLayers = [...raw.layers].sort((a, b) => a.order - b.order);
  const layerMap = new Map<string, LayerSpec>();

  for (let i = 0; i < sortedLayers.length; i++) {
    const l = sortedLayers[i];
    if (layerMap.has(l.id)) {
      issues.push({
        severity: 'error',
        path: `layers.${l.id}`,
        message: `Duplicate layer id "${l.id}".`,
      });
      continue;
    }
    layerMap.set(l.id, {
      id: l.id,
      name: l.name,
      order: l.order,
      kind: l.kind ?? (i === 0 ? 'physical' : 'overlay'),
      color: l.color ?? DEFAULT_LAYER_PALETTE[i % DEFAULT_LAYER_PALETTE.length],
      description: l.description,
    });
  }

  // Validate groups
  const groupMap = new Map<string, GroupSpec>();
  for (const g of raw.groups) {
    if (groupMap.has(g.id)) {
      issues.push({
        severity: 'error',
        path: `groups.${g.id}`,
        message: `Duplicate group id "${g.id}".`,
      });
      continue;
    }
    if (g.layer && !layerMap.has(g.layer)) {
      issues.push({
        severity: 'warning',
        path: `groups.${g.id}.layer`,
        message: `Group "${g.id}" references unknown layer "${g.layer}".`,
      });
    }
    groupMap.set(g.id, g);
  }

  for (const g of groupMap.values()) {
    if (g.parent && !groupMap.has(g.parent)) {
      issues.push({
        severity: 'error',
        path: `groups.${g.id}.parent`,
        message: `Group "${g.id}" references non-existent parent group "${g.parent}".`,
      });
    }
    // Check group parent cycles
    let curr = g.parent;
    const seen = new Set<string>([g.id]);
    while (curr) {
      if (seen.has(curr)) {
        issues.push({
          severity: 'error',
          path: `groups.${g.id}.parent`,
          message: `Circular group hierarchy detected involving "${g.id}".`,
        });
        break;
      }
      seen.add(curr);
      curr = groupMap.get(curr)?.parent;
    }
  }

  // Validate nodes
  const nodeMap = new Map<string, NodeSpec>();
  for (const n of raw.nodes) {
    if (nodeMap.has(n.id)) {
      issues.push({
        severity: 'error',
        path: `nodes.${n.id}`,
        message: `Duplicate node id "${n.id}".`,
      });
      continue;
    }
    if (!layerMap.has(n.layer)) {
      issues.push({
        severity: 'error',
        path: `nodes.${n.id}.layer`,
        message: `Node "${n.id}" references unknown layer "${n.layer}".`,
      });
      continue;
    }
    if (n.group && !groupMap.has(n.group)) {
      issues.push({
        severity: 'warning',
        path: `nodes.${n.id}.group`,
        message: `Node "${n.id}" references unknown group "${n.group}".`,
      });
    }
    nodeMap.set(n.id, {
      ...n,
      label: n.label ?? n.id,
    });
  }

  // Validate hostedOn cross-layer references
  for (const n of nodeMap.values()) {
    const nodeLayer = layerMap.get(n.layer)!;
    const validHosts: string[] = [];
    for (const hostId of n.hostedOn) {
      const hostNode = nodeMap.get(hostId);
      if (!hostNode) {
        issues.push({
          severity: 'error',
          path: `nodes.${n.id}.hostedOn`,
          message: `Node "${n.id}" is hostedOn unknown node "${hostId}".`,
        });
        continue;
      }
      const hostLayer = layerMap.get(hostNode.layer)!;
      if (hostLayer.order >= nodeLayer.order) {
        issues.push({
          severity: 'error',
          path: `nodes.${n.id}.hostedOn`,
          message: `Node "${n.id}" (layer "${nodeLayer.id}", order ${nodeLayer.order}) must be hosted on a strictly lower layer than "${hostId}" (layer "${hostLayer.id}", order ${hostLayer.order}).`,
        });
        continue;
      }
      validHosts.push(hostId);
    }
    n.hostedOn = validHosts;
  }

  // Validate links
  const linkMap = new Map<string, LinkSpec>();
  raw.links.forEach((l, idx) => {
    const srcNode = nodeMap.get(l.source);
    const tgtNode = nodeMap.get(l.target);
    const generatedId = l.id ?? `${l.source}--${l.target}-${idx + 1}`;

    if (linkMap.has(generatedId)) {
      issues.push({
        severity: 'error',
        path: `links.${generatedId}`,
        message: `Duplicate link id "${generatedId}".`,
      });
      return;
    }
    if (!srcNode) {
      issues.push({
        severity: 'error',
        path: `links.${generatedId}.source`,
        message: `Link "${generatedId}" references unknown source node "${l.source}".`,
      });
      return;
    }
    if (!tgtNode) {
      issues.push({
        severity: 'error',
        path: `links.${generatedId}.target`,
        message: `Link "${generatedId}" references unknown target node "${l.target}".`,
      });
      return;
    }

    const srcLayer = layerMap.get(srcNode.layer)!;
    const tgtLayer = layerMap.get(tgtNode.layer)!;
    const defaultLayerId = srcLayer.order >= tgtLayer.order ? srcLayer.id : tgtLayer.id;
    const linkLayerId = l.layer ?? defaultLayerId;

    if (!layerMap.has(linkLayerId)) {
      issues.push({
        severity: 'error',
        path: `links.${generatedId}.layer`,
        message: `Link "${generatedId}" references unknown layer "${linkLayerId}".`,
      });
      return;
    }

    linkMap.set(generatedId, {
      id: generatedId,
      label: l.label,
      layer: linkLayerId,
      source: l.source,
      target: l.target,
      sourcePort: l.sourcePort,
      targetPort: l.targetPort,
      type: l.type,
      encapsulation: l.encapsulation,
      bandwidth: l.bandwidth,
      status: l.status,
      bidirectional: l.bidirectional,
      carriedBy: l.carriedBy,
      autoResolveUnderlay: l.autoResolveUnderlay,
      metadata: l.metadata,
    });
  });

  // Validate explicit carriedBy references
  for (const l of linkMap.values()) {
    if (!l.carriedBy) continue;
    const linkLayer = layerMap.get(l.layer)!;
    const validCarriers: string[] = [];
    for (const carrierId of l.carriedBy) {
      const carrier = linkMap.get(carrierId);
      if (!carrier) {
        issues.push({
          severity: 'error',
          path: `links.${l.id}.carriedBy`,
          message: `Link "${l.id}" carriedBy references unknown link "${carrierId}".`,
        });
        continue;
      }
      const carrierLayer = layerMap.get(carrier.layer)!;
      if (carrierLayer.order >= linkLayer.order) {
        issues.push({
          severity: 'error',
          path: `links.${l.id}.carriedBy`,
          message: `Link "${l.id}" (layer "${linkLayer.id}", order ${linkLayer.order}) must be carriedBy a strictly lower layer link than "${carrierId}" (layer "${carrierLayer.id}", order ${carrierLayer.order}).`,
        });
        continue;
      }
      validCarriers.push(carrierId);
    }
    l.carriedBy = validCarriers;
  }

  const hasErrors = issues.some((i) => i.severity === 'error');
  if (hasErrors) {
    return { config: null, issues };
  }

  const config: NetworkConfig = {
    metadata: raw.metadata,
    layers: Array.from(layerMap.values()),
    groups: Array.from(groupMap.values()),
    nodes: Array.from(nodeMap.values()),
    links: Array.from(linkMap.values()),
  };

  return { config, issues };
}
