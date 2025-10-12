import type { NodeData, EdgeData } from './types';

export interface PrismNode {
  id: string | number;
  name?: string;
  x?: number;
  y?: number;
  type?: 'initial' | 'target' | 'deadlock' | 'normal';
  properties?: Record<string, any>;
}

export interface PrismEdge {
  source: string | number;
  target: string | number;
  probability?: number;
  action?: string;
  weight?: number;
}

export interface PrismResponse {
  states?: PrismNode[];
  nodes?: PrismNode[];
  edges?: PrismEdge[];
  transitions?: PrismEdge[];
  graph?: {
    vertices: PrismNode[];
    transitions: PrismEdge[];
    metadata?: {
      stateCount: number;
      transitionCount: number;
    };
  };
}

export class PrismAPI {
  private baseUrl: string;
  private cache = new Map<string, { data: PrismResponse; timestamp: number }>();
  private readonly CACHE_TTL = 30000; // 30 seconds

  constructor(baseUrl: string = 'http://localhost:8080') {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
  }

  async fetchProject(projectId: string, viewIds?: number[]): Promise<PrismResponse> {
    const cacheKey = `${projectId}_${viewIds?.join(',') || 'all'}`;
    
    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
      return cached.data;
    }

    // Build URL
    let url = `${this.baseUrl}/${encodeURIComponent(projectId)}`;
    
    if (viewIds && viewIds.length > 0) {
      const params = new URLSearchParams();
      viewIds.forEach(id => params.append('view', id.toString()));
      url += `?${params.toString()}`;
    }

    console.log(`[PrismAPI] Fetching from: ${url}`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      // Cache the result
      this.cache.set(cacheKey, {
        data,
        timestamp: Date.now()
      });

      return data;

    } catch (error) {
      console.error('[PrismAPI] Fetch failed:', error);
      throw error;
    }
  }

  async fetchSimpleGraph(graphId: string = '0'): Promise<{ nodes: NodeData[]; edges: EdgeData[] }> {
    try {
      const url = `${this.baseUrl}/${graphId}`;
      console.log(`[PrismAPI] Fetching simple graph from: ${url}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (!data.nodes || !Array.isArray(data.nodes)) {
        throw new Error('Invalid response: missing nodes array');
      }
      
      if (!data.edges || !Array.isArray(data.edges)) {
        throw new Error('Invalid response: missing edges array');
      }

      return {
        nodes: data.nodes.map((node: any, index: number) => ({
          id: node.id !== undefined ? node.id : index,
          x: node.x || 0,
          y: node.y || 0,
          z: 0,
          radius: node.radius || 2,
          cluster: node.cluster || 0,
          value: node.value || Math.random(),
          type: node.type === 'important' ? 'important' : 'normal'
        })),
        edges: data.edges.map((edge: any) => ({
          from: edge.from !== undefined ? edge.from : edge.source,
          to: edge.to !== undefined ? edge.to : edge.target,
          weight: edge.weight || 1
        }))
      };

    } catch (error) {
      console.error('[PrismAPI] Simple graph fetch failed:', error);
      throw error;
    }
  }

  convertPrismToInternal(prismData: PrismResponse): { nodes: NodeData[]; edges: EdgeData[] } {
    let prismNodes: PrismNode[] = [];
    let prismEdges: PrismEdge[] = [];

    // Extract nodes from various possible formats
    if (prismData.states) {
      prismNodes = prismData.states;
    } else if (prismData.nodes) {
      prismNodes = prismData.nodes;
    } else if (prismData.graph?.vertices) {
      prismNodes = prismData.graph.vertices;
    }

    // Extract edges from various possible formats
    if (prismData.edges) {
      prismEdges = prismData.edges;
    } else if (prismData.transitions) {
      prismEdges = prismData.transitions;
    } else if (prismData.graph?.transitions) {
      prismEdges = prismData.graph.transitions;
    }

    // Create ID to index mapping
    const idToIndex = new Map();
    
    const nodes: NodeData[] = prismNodes.map((node, index) => {
      const nodeId = node.id !== undefined ? node.id : index;
      idToIndex.set(nodeId, index);
      
      return {
        id: index,
        x: node.x || 0,
        y: node.y || 0,
        z: 0,
        radius: node.type === 'target' ? 4 : (node.type === 'initial' ? 3 : 2),
        cluster: 0,
        value: node.properties?.value || Math.random(),
        type: (node.type === 'target' || node.type === 'initial') ? 'important' : 'normal'
      };
    });

    const edges: EdgeData[] = prismEdges
      .filter(edge => {
        const fromIndex = idToIndex.get(edge.source);
        const toIndex = idToIndex.get(edge.target);
        return fromIndex !== undefined && toIndex !== undefined;
      })
      .map(edge => ({
        from: idToIndex.get(edge.source),
        to: idToIndex.get(edge.target),
        weight: edge.probability || edge.weight || 1
      }));

    console.log(`[PrismAPI] Converted: ${nodes.length} nodes, ${edges.length} edges`);
    return { nodes, edges };
  }

  clearCache(): void {
    this.cache.clear();
  }

  updateBaseUrl(newBaseUrl: string): void {
    this.baseUrl = newBaseUrl.replace(/\/$/, '');
    this.clearCache();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(this.baseUrl, {
        method: 'HEAD',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }
}