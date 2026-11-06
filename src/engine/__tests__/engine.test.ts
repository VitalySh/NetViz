import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseNetworkYaml } from '../../schema/parser';
import { resolveCrossLayerTopology } from '../resolver';
import { buildFoldedGraph } from '../grouping';
import { computeLayout } from '../layout';
import { computeHighlightTrace } from '../selectionTrace';

const dcYaml = readFileSync(
  resolve(process.cwd(), 'examples/dc-evpn-k8s-5layer.yaml'),
  'utf-8'
);
const wanYaml = readFileSync(
  resolve(process.cwd(), 'examples/multi-site-wan-sdwan.yaml'),
  'utf-8'
);
const starterYaml = readFileSync(
  resolve(process.cwd(), 'examples/minimal-starter.yaml'),
  'utf-8'
);

describe('NetViz Multi-Layer YAML Parser & Cross-Layer Resolver', () => {
  it('parses all example YAML topologies cleanly with zero errors', () => {
    for (const raw of [dcYaml, wanYaml, starterYaml]) {
      const res = parseNetworkYaml(raw);
      expect(res.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(res.config).not.toBeNull();
    }
  });

  it('recursively resolves L4 service-mesh links all the way down to L0 physical fibers & ECMP spines', () => {
    const { config } = parseNetworkYaml(dcYaml);
    expect(config).not.toBeNull();
    const resolution = resolveCrossLayerTopology(config!);

    // Check `mesh-checkout-payment` (L4 Service Mesh) -> L3 CNI -> L2 VXLAN -> L1 eBGP -> L0 Physical
    const l4Traces = resolution.linkUnderlayMap.get('mesh-checkout-payment');
    expect(l4Traces).toBeDefined();
    expect(l4Traces!.get('k8s-cni')?.linkIds).toContain('cni-work1-work2');
    expect(l4Traces!.get('evpn-overlay')?.linkIds).toContain('vxlan-101-102');

    // L1 eBGP should have 2 ECMP paths via bgp-spine-01 and bgp-spine-02
    const l1Trace = l4Traces!.get('underlay');
    expect(l1Trace).toBeDefined();
    expect(l1Trace!.ecmpPaths.length).toBe(2);

    // L0 Physical trace should include server DACs AND dual-spine 400G fibers
    const l0Trace = l4Traces!.get('physical');
    expect(l0Trace).toBeDefined();
    expect(l0Trace!.linkIds).toEqual(
      expect.arrayContaining([
        'phy-srv101b-l101',
        'phy-srv102a-l102',
        'phy-l101-sp01',
        'phy-l101-sp02',
        'phy-l102-sp01',
        'phy-l102-sp02',
      ])
    );
  });

  it('distinguishes ECMP degradation (1 spine failed) from full outage (both spines failed)', () => {
    const { config } = parseNetworkYaml(dcYaml);
    // 1. Fail spine-01 only -> VXLAN, CNI, and Service Mesh links should degrade (not go down!)
    const oneSpineDown = resolveCrossLayerTopology(config!, {
      failedNodeIds: new Set(['spine-01']),
      failedLinkIds: new Set(),
    });

    expect(oneSpineDown.linkHealth.get('vxlan-101-102')?.status).toBe('degraded');
    expect(oneSpineDown.linkHealth.get('cni-work1-work2')?.status).toBe('degraded');
    expect(oneSpineDown.linkHealth.get('mesh-checkout-payment')?.status).toBe('degraded');
    // Intra-rack link `mesh-gw-checkout` only uses leaf-101, so it remains `up`!
    expect(oneSpineDown.linkHealth.get('mesh-gw-checkout')?.status).toBe('up');

    // 2. Fail BOTH spine-01 and spine-02 -> cross-rack overlays go completely `down`!
    const bothSpinesDown = resolveCrossLayerTopology(config!, {
      failedNodeIds: new Set(['spine-01', 'spine-02']),
      failedLinkIds: new Set(),
    });
    expect(bothSpinesDown.linkHealth.get('vxlan-101-102')?.status).toBe('down');
    expect(bothSpinesDown.linkHealth.get('cni-work1-work2')?.status).toBe('down');
    expect(bothSpinesDown.linkHealth.get('mesh-checkout-payment')?.status).toBe('down');
    expect(bothSpinesDown.linkHealth.get('mesh-gw-checkout')?.status).toBe('up');
  });

  it('folds collapsible racks/sites and projects cross-layer highlight traces cleanly', () => {
    const { config } = parseNetworkYaml(dcYaml);
    const resolution = resolveCrossLayerTopology(config!);
    const layerModes = new Map(config!.layers.map((l) => [l.id, 'visible' as const]));

    const folded = buildFoldedGraph(
      config!,
      new Set(['rack-101']),
      layerModes,
      resolution.nodeHealth,
      resolution.linkHealth
    );

    // rack-101 should be replaced by proxy node `group:rack-101`
    expect(folded.nodes.some((n) => n.id === 'group:rack-101')).toBe(true);
    expect(folded.nodes.some((n) => n.id === 'leaf-101')).toBe(false);

    const layout = computeLayout(config!, folded, 'swimlanes');
    expect(layout.positions.has('group:rack-101')).toBe(true);

    const trace = computeHighlightTrace(
      { kind: 'link', id: 'mesh-checkout-payment' },
      config!,
      resolution,
      folded
    );
    // Collapsed proxy `group:rack-101` should be highlighted in the underlay trace!
    expect(trace.underlayRenderNodeIds.has('group:rack-101')).toBe(true);
  });
});
