export interface NodeData {
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  cluster: number;
  value: number;
  type: 'normal' | 'important';
  connections?: number[];
  degree?: number;
  // 10 float parameters ranging from 0 to 100
  parameters: [number, number, number, number, number, number, number, number, number, number];
}

export interface EdgeData {
  from: number;
  to: number;
  weight?: number;
}

export interface GraphConfig {
  maxVisibleNodes: number;
  renderDistance: number;
  minZoom: number;
  maxZoom: number;
  lodEnabled: boolean;
  edgesVisible: boolean;
  clusterMode: boolean;
  edgeCount?: number;
  forceStrength?: number;
  springLength?: number;
  iterations?: number;
  // Parameter-based positioning
  parameterXAxis?: number; // Which parameter (0-9) to use for X axis
  parameterYAxis?: number; // Which parameter (0-9) to use for Y axis
  useParameterPositioning?: boolean;
}

export type LayoutType = 'random' | 'grid' | 'circular' | 'force' | 'force_directed';

export interface ViewportBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface NodeClickEvent {
  type: 'nodeClick';
  data: {
    position: { x: number; y: number; z: number };
    screenPosition: { x: number; y: number };
  };
}

export interface ForceSimulationNode extends NodeData {
  vx: number;
  vy: number;
  fx?: number;
  fy?: number;
}