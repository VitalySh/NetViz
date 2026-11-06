import dcEvpnYaml from '../../examples/dc-evpn-k8s-5layer.yaml?raw';
import wanSdwanYaml from '../../examples/multi-site-wan-sdwan.yaml?raw';
import minimalStarterYaml from '../../examples/minimal-starter.yaml?raw';

export interface ExampleTopologyItem {
  id: string;
  title: string;
  subtitle: string;
  fileName: string;
  yaml: string;
}

export const BUILTIN_EXAMPLES: ExampleTopologyItem[] = [
  {
    id: 'dc-evpn-k8s-5layer',
    title: '5-Layer Cloud-Native DC',
    subtitle: 'Physical Clos → eBGP → EVPN/VXLAN → K8s CNI → Service Mesh',
    fileName: 'examples/dc-evpn-k8s-5layer.yaml',
    yaml: dcEvpnYaml,
  },
  {
    id: 'multi-site-wan-sdwan',
    title: '4-Layer Global SD-WAN',
    subtitle: 'Optical/ISP → MPLS & DIA → Color-Pinned SD-WAN → App VRFs',
    fileName: 'examples/multi-site-wan-sdwan.yaml',
    yaml: wanSdwanYaml,
  },
  {
    id: 'minimal-starter',
    title: '3-Layer Starter Template',
    subtitle: 'Minimal auto-resolved Physical → VXLAN → App topology',
    fileName: 'examples/minimal-starter.yaml',
    yaml: minimalStarterYaml,
  },
];
