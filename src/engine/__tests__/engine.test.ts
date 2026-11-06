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

  it('enforces zero node overlaps, zero group overlaps, vertical cross-layer alignment, and non-overlapping horizontal link tracks across all topologies', () => {
    const allYamls = [
      { name: 'dc-evpn', raw: dcYaml },
      { name: 'wan-sdwan', raw: wanYaml },
      { name: 'minimal', raw: starterYaml },
    ];

    const rectsOverlap = (
      ax: number,
      ay: number,
      aw: number,
      ah: number,
      bx: number,
      by: number,
      bw: number,
      bh: number
    ) => ax < bx + bw - 0.5 && ax + aw > bx + 0.5 && ay < by + bh - 0.5 && ay + ah > by + 0.5;

    for (const { name, raw } of allYamls) {
      const { config } = parseNetworkYaml(raw);
      expect(config).not.toBeNull();
      const resolution = resolveCrossLayerTopology(config!);
      const layerModes = new Map(config!.layers.map((l) => [l.id, 'visible' as const]));
      const folded = buildFoldedGraph(
        config!,
        new Set(),
        layerModes,
        resolution.nodeHealth,
        resolution.linkHealth
      );

      for (const mode of ['swimlanes', 'anchored'] as const) {
        const layout = computeLayout(config!, folded, mode);
        const groupMap = new Map(config!.groups.map((g) => [g.id, g]));

        const isGroupAncestor = (ancId: string, descId: string): boolean => {
          let curr = groupMap.get(descId)?.parent;
          while (curr) {
            if (curr === ancId) return true;
            curr = groupMap.get(curr)?.parent;
          }
          return false;
        };

        // 1. ZERO NODE OVERLAPS (2D & 3D same-layer)
        for (let i = 0; i < folded.nodes.length; i++) {
          for (let j = i + 1; j < folded.nodes.length; j++) {
            const a = folded.nodes[i];
            const b = folded.nodes[j];
            const pa = layout.positions.get(a.id)!;
            const pb = layout.positions.get(b.id)!;

            const overlap2D = rectsOverlap(
              pa.x - pa.width / 2,
              pa.y - pa.height / 2,
              pa.width,
              pa.height,
              pb.x - pb.width / 2,
              pb.y - pb.height / 2,
              pb.width,
              pb.height
            );
            expect(
              overlap2D,
              `[${name} · ${mode}] Nodes "${a.id}" and "${b.id}" overlap in 2D`
            ).toBe(false);

            if (a.layer === b.layer) {
              const overlap3D = rectsOverlap(
                pa.anchorX - pa.width / 2,
                pa.anchorZ - 30,
                pa.width,
                60,
                pb.anchorX - pb.width / 2,
                pb.anchorZ - 30,
                pb.width,
                60
              );
              expect(
                overlap3D,
                `[${name} · ${mode}] Same-layer nodes "${a.id}" and "${b.id}" overlap on 3D plane`
              ).toBe(false);
            }
          }
        }

        // 2. ZERO GROUP OVERLAPS (2D & 3D) + NO FOREIGN NODE INSIDE A GROUP BOX
        for (let i = 0; i < layout.groupBoxes.length; i++) {
          for (let j = i + 1; j < layout.groupBoxes.length; j++) {
            const ga = layout.groupBoxes[i];
            const gb = layout.groupBoxes[j];
            const nestedSameLayer =
              ga.layerId === gb.layerId &&
              ga.subRow === gb.subRow &&
              (isGroupAncestor(ga.group.id, gb.group.id) ||
                isGroupAncestor(gb.group.id, ga.group.id));
            if (nestedSameLayer) continue;

            const overlap2D = rectsOverlap(
              ga.x,
              ga.y,
              ga.width,
              ga.height,
              gb.x,
              gb.y,
              gb.width,
              gb.height
            );
            expect(
              overlap2D,
              `[${name} · ${mode}] Group boxes "${ga.key}" and "${gb.key}" overlap in 2D`
            ).toBe(false);

            if (ga.layerId && ga.layerId === gb.layerId) {
              const overlap3DPad = rectsOverlap(
                ga.anchorMinX,
                ga.anchorMinZ,
                ga.anchorMaxX - ga.anchorMinX,
                ga.anchorMaxZ - ga.anchorMinZ,
                gb.anchorMinX,
                gb.anchorMinZ,
                gb.anchorMaxX - gb.anchorMinX,
                gb.anchorMaxZ - gb.anchorMinZ
              );
              expect(
                overlap3DPad,
                `[${name} · ${mode}] 3D region pads "${ga.key}" and "${gb.key}" overlap`
              ).toBe(false);
            }
          }
        }

        for (const gb of layout.groupBoxes) {
          for (const rn of folded.nodes) {
            const belongs =
              rn.group === gb.group.id ||
              (rn.group !== undefined && isGroupAncestor(gb.group.id, rn.group));
            if (belongs && rn.layer === gb.layerId) continue;

            const p = layout.positions.get(rn.id)!;
            const nodeHitsForeignGroup = rectsOverlap(
              p.x - p.width / 2,
              p.y - p.height / 2,
              p.width,
              p.height,
              gb.x,
              gb.y,
              gb.width,
              gb.height
            );
            expect(
              nodeHitsForeignGroup,
              `[${name} · ${mode}] Foreign node "${rn.id}" overlaps group box "${gb.key}"`
            ).toBe(false);
          }
        }

        // 3. VERTICAL NODE ALIGNMENT ACROSS LAYERS (1-to-1 chains share exact X!)
        for (const rn of folded.nodes) {
          if (rn.hostedOn.length === 1) {
            const hostId = rn.hostedOn[0];
            const siblingsOnSameLayer = folded.nodes.filter(
              (other) => other.layer === rn.layer && other.hostedOn[0] === hostId
            );
            if (siblingsOnSameLayer.length === 1) {
              const upX = layout.positions.get(rn.id)!.x;
              const lowX = layout.positions.get(hostId)!.x;
              expect(
                Math.abs(upX - lowX),
                `[${name}] Node "${rn.id}" should align vertically with host "${hostId}"`
              ).toBeLessThan(1);
            }
          }
        }

        // 4. NON-OVERLAPPING HORIZONTAL CONNECTING LINES
        for (const rl of folded.links) {
          const route = layout.linkRoutes.get(rl.id);
          expect(route).toBeDefined();
          if (!route!.sameRow) continue;

          const sp = layout.positions.get(rl.source)!;
          const tp = layout.positions.get(rl.target)!;
          const minX = Math.min(sp.x, tp.x);
          const maxX = Math.max(sp.x, tp.x);

          const hasMiddleNode = folded.nodes.some((rn) => {
            if (rn.id === rl.source || rn.id === rl.target) return false;
            const p = layout.positions.get(rn.id)!;
            return Math.abs(p.y - sp.y) < 8 && p.x > minX + 10 && p.x < maxX - 10;
          });

          if (hasMiddleNode) {
            expect(
              route!.arcTrack,
              `[${name}] Skip-link "${rl.id}" crosses intermediate horizontal node(s) and must use non-zero arcTrack`
            ).not.toBe(0);
          }
        }

        // 5. NO TWO ARCHED HORIZONTAL LINKS ON THE SAME ROW WITH OVERLAPPING X SHARE AN ARC TRACK
        const sameRowArched = folded.links.filter((rl) => {
          const rt = layout.linkRoutes.get(rl.id);
          return rt?.sameRow && rt.arcTrack !== 0;
        });
        for (let i = 0; i < sameRowArched.length; i++) {
          for (let j = i + 1; j < sameRowArched.length; j++) {
            const la = sameRowArched[i];
            const lb = sameRowArched[j];
            const sa = layout.positions.get(la.source)!;
            const ta = layout.positions.get(la.target)!;
            const sb = layout.positions.get(lb.source)!;
            const tb = layout.positions.get(lb.target)!;
            if (Math.abs(sa.y - sb.y) > 8) continue;

            const minA = Math.min(sa.x, ta.x);
            const maxA = Math.max(sa.x, ta.x);
            const minB = Math.min(sb.x, tb.x);
            const maxB = Math.max(sb.x, tb.x);
            const xOverlaps = Math.min(maxA, maxB) - Math.max(minA, minB) > 1;
            if (xOverlaps) {
              expect(
                layout.linkRoutes.get(la.id)!.arcTrack,
                `[${name}] Overlapping horizontal arcs "${la.id}" and "${lb.id}" must not share the same track`
              ).not.toBe(layout.linkRoutes.get(lb.id)!.arcTrack);
            }
          }
        }

        // 6. RELATED GROUPS ACROSS LAYERS ARE VERTICALLY ALIGNED
        const boxesByGroupId = new Map<string, typeof layout.groupBoxes>();
        for (const gb of layout.groupBoxes) {
          if (!boxesByGroupId.has(gb.group.id)) boxesByGroupId.set(gb.group.id, []);
          boxesByGroupId.get(gb.group.id)!.push(gb);
        }
        for (const [gid, boxes] of boxesByGroupId.entries()) {
          if (boxes.length < 2) continue;
          for (let i = 1; i < boxes.length; i++) {
            const prev = boxes[i - 1];
            const curr = boxes[i];
            // Check horizontal overlap between the vertically stacked group boxes (one sits directly above the other!)
            const horizOverlap =
              Math.min(prev.x + prev.width, curr.x + curr.width) - Math.max(prev.x, curr.x);
            expect(
              horizOverlap,
              `[${name}] Group "${gid}" instances across layers should align vertically`
            ).toBeGreaterThan(Math.min(prev.width, curr.width) * 0.5);
          }
        }
      }
    }
  });
});
