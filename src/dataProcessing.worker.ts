/**
 * Web Worker for processing graph data off the main thread
 * Handles conversion of raw API data to internal format
 */

import type { NodeData, EdgeData } from './types';
import type { GraphInfo } from './PrismAPI';

interface WorkerInput {
  type: 'process';
  data: any;
}

interface WorkerOutput {
  type: 'result' | 'error';
  s_nodes?: NodeData[];
  t_nodes?: NodeData[];
  edges?: EdgeData[];
  parameterMetadata?: GraphInfo;
  error?: string;
}

// Process incoming messages
self.onmessage = (event: MessageEvent<WorkerInput>) => {
  const { type, data } = event.data;

  if (type === 'process') {
    try {
      const result = processGraphData(data);
      const output: WorkerOutput = {
        type: 'result',
        ...result
      };
      self.postMessage(output);
    } catch (error) {
      const output: WorkerOutput = {
        type: 'error',
        error: error instanceof Error ? error.message : String(error)
      };
      self.postMessage(output);
    }
  }
};

/**
 * Process graph data and convert to internal format
 */
function processGraphData(data: any): {
  s_nodes: NodeData[];
  t_nodes: NodeData[];
  edges: EdgeData[];
  parameterMetadata?: GraphInfo;
} {
  const startTime = performance.now();

  // Extract parameter metadata if available
  const parameterMetadata = data.info ? data.info : undefined;

  const idToIndex = new Map<string, number>();

  // Filter s_nodes and t_nodes first
  const s_nodes_raw = data.nodes.filter((node: any) => node.type === 's');
  const t_nodes_raw = data.nodes.filter((node: any) => node.type === 't');

  // Pre-allocate arrays for better performance
  const s_nodes: NodeData[] = new Array(s_nodes_raw.length);
  const t_nodes: NodeData[] = new Array(t_nodes_raw.length);

  // Create s_nodes with their global indices
  for (let i = 0; i < s_nodes_raw.length; i++) {
    const node = s_nodes_raw[i];
    const nodeId = String(node.id);
    const globalIndex = i;

    idToIndex.set(nodeId, globalIndex);

    s_nodes[i] = {
      id: node.id,
      index: globalIndex,
      type: 's',
      name: node.name || '',
      x: 0,
      y: 0,
      cluster: 0,
      degree: 0,
      parameters: node.details || {}
    };
  }

  // Create t_nodes with their global indices (offset by s_nodes length)
  const s_length = s_nodes.length;
  for (let i = 0; i < t_nodes_raw.length; i++) {
    const node = t_nodes_raw[i];
    const nodeId = String(node.id);
    const globalIndex = s_length + i;

    idToIndex.set(nodeId, globalIndex);

    t_nodes[i] = {
      id: node.id,
      index: globalIndex,
      type: 't',
      name: node.name || String(node.id),
      x: 0,
      y: 0,
      cluster: 0,
      degree: 0,
      parameters: node.details || {}
    };
  }

  // Combine nodes for degree calculation
  const allNodes = s_nodes.concat(t_nodes);

  // Process edges and calculate degrees in a single pass
  const edgeCount = data.edges.length;
  const edges: EdgeData[] = [];

  for (let i = 0; i < edgeCount; i++) {
    const edge = data.edges[i];
    const sourceId = String(edge.source);
    const targetId = String(edge.target);

    const fromIndex = idToIndex.get(sourceId);
    const toIndex = idToIndex.get(targetId);

    if (fromIndex !== undefined && toIndex !== undefined) {
      edges.push({
        from: fromIndex,
        to: toIndex,
        label: edge.label || ''
      });

      // Increment degree for both nodes
      allNodes[fromIndex].degree!++;
      allNodes[toIndex].degree!++;
    }
  }

  const endTime = performance.now();
  console.log(`[Worker] Processed graph in ${(endTime - startTime).toFixed(2)}ms: ${s_nodes.length} s_nodes, ${t_nodes.length} t_nodes, ${edges.length} edges`);

  return {
    s_nodes,
    t_nodes,
    edges,
    parameterMetadata
  };
}
