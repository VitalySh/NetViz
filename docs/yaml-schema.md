# NetViz YAML Configuration Schema

NetViz uses a clean, layer-agnostic YAML schema designed to model arbitrary overlay depths (`order: 0, 1, 2, ... N`) on top of physical infrastructure (`order: 0`).

## Core Concepts

1. **`layers`**: Ordered network planes from `order: 0` (bottom physical infrastructure) upward (`1, 2, 3...`).
2. **`groups`**: Hierarchical collapsible containers (`site`, `rack`, `cluster`, `vrf`, `namespace`, `zone`) supporting `parent` nesting.
3. **`nodes`**: Physical hardware or logical/virtual endpoints assigned to a `layer`, optional `group`, and optional `hostedOn` node ID(s) in any strictly lower layer.
4. **`links`**: Intra-layer (or inter-layer) connections supporting **two underlay resolution modes**:
   - **Automatic ECMP Underlay Resolution (`autoResolveUnderlay: true`, default)**: When `carriedBy` is omitted, NetViz projects `source` and `target` down through `hostedOn` to lower layers and automatically discovers all equal-cost shortest paths (ECMP) recursively down to `order: 0` physical links.
   - **Explicit Traffic Engineering (`carriedBy: [...]`)**: Pin an overlay tunnel to specific lower-layer links (e.g., MPLS vs Broadband DIA, or specific server NIC uplinks + VXLAN VNIs).

---

## Top-Level Structure

```yaml
metadata:
  name: "My Multi-Layer Network"
  version: "1.0"
  description: "Optional summary shown in the Inspector"
  tags: ["datacenter", "evpn"]

layers:
  - id: physical
    name: "L0 · Physical Infrastructure"
    order: 0
    kind: physical
    color: "#38bdf8"

  - id: vxlan
    name: "L1 · VXLAN Overlay"
    order: 1
    kind: overlay
    color: "#a78bfa"

groups:
  - id: dc-west
    name: "DC West"
    type: site
  - id: rack-01
    name: "Rack 01"
    type: rack
    parent: dc-west
    layer: physical
    collapsedByDefault: false

nodes:
  - id: spine-1
    label: "spine-01"
    layer: physical
    type: switch
    role: spine          # wan | core | spine | leaf | compute | gateway | worker | service
    group: dc-west
    status: up           # up | degraded | down
    metadata:
      model: "7060X5"

  - id: leaf-1
    label: "leaf-01"
    layer: physical
    type: switch
    role: leaf
    group: rack-01

  - id: vtep-1
    label: "VTEP-01"
    layer: vxlan
    type: vtep
    hostedOn: leaf-1     # Single node ID or list: [leaf-1a, leaf-1b]

links:
  - id: phy-l1-sp1
    label: "400G-LR4"
    layer: physical
    source: leaf-1
    target: spine-1
    bandwidth: "400Gbps"
    bidirectional: true

  - id: vni-5000
    label: "VNI 5000"
    layer: vxlan
    source: vtep-1
    target: vtep-2
    encapsulation: "VXLAN UDP/4789"
    # Omit `carriedBy` for automatic ECMP path resolution, or specify explicitly:
    # carriedBy: [phy-l1-sp1, phy-l2-sp1]
```

## Validation Rules Enforced Live

- Unique `id`s within `layers`, `groups`, `nodes`, and `links`.
- No circular `parent` chains in `groups`.
- `hostedOn` must reference existing nodes in a **strictly lower** `order` layer (guarantees a DAG with zero vertical cycles).
- `carriedBy` must reference existing links in a **strictly lower** `order` layer.
