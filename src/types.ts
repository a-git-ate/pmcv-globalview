export interface NodeData {
  id: number | string; // Original ID from the API (can be string)
  index?: number; // Sequential index in the nodes array (used for positioning/rendering)
  name?: string;
  x: number;
  y: number;
  connections?: number[];
  degree?: number;
  parameters: Record<string, any>;
  type: 's' | 't';
  cluster: number;
  radius?: number;

}

export interface EdgeData {
  from: number;
  to: number;
  label?: string;
}

export interface GraphConfig {
  maxVisibleNodes: number;
  minZoom: number;
  maxZoom: number;
  edgesVisible: boolean;
  parameterXAxis?: string;
  parameterYAxis?: string;
  parameterColorAxis?: string;
  useParameterPositioning?: boolean;
  renderDistance: number;
}

export type LayoutType = 'none' | 'grid';

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