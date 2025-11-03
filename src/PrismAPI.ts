import type { NodeData, EdgeData } from './types';

export interface PrismNode {
  id: string | number;
  name?: string;
  x?: number;
  y?: number;
  type?: 's' | 't' | 'initial' | 'target' | 'deadlock' | 'normal';
  properties?: Record<string, any>;
  details?: {
    'Variable Values'?: Record<string, number>;
    'Atomic Propositions'?: Record<string, boolean>;
    'Model Checking Results'?: Record<string, number>;
    'Reward Structures'?: Record<string, number>;
    [key: string]: any;
  };
}

export interface PrismEdge {
  source: string | number;
  target: string | number;
  probability?: number;
  action?: string;
  label?: string;
  weight?: number;
}

export interface ParameterMetadata {
  type: 'number' | 'boolean' | 'nominal';
  status: string;
  min: number | string;
  max: number | string;
  identifier?: string;
  icon?: boolean;
}

export interface NodeTypeInfo {
  'Atomic Propositions'?: Record<string, ParameterMetadata>;
  'Model Checking Results'?: Record<string, ParameterMetadata>;
  'Reward Structures'?: Record<string, ParameterMetadata>;
  'Variable Values'?: Record<string, ParameterMetadata>;
  'Action Parameter'?: Record<string, ParameterMetadata>;
  [key: string]: any;
}

export interface GraphInfo {
  id: string;
  scheduler?: Record<string, string>;
  s?: NodeTypeInfo;  // State node metadata
  t?: NodeTypeInfo;  // Transition node metadata
}

export interface PrismResponse {
  states?: PrismNode[];
  nodes?: PrismNode[];
  edges?: PrismEdge[];
  transitions?: PrismEdge[];
  info?: GraphInfo;
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
  private parameterMetadata: GraphInfo | null = null;

  constructor(baseUrl: string = 'http://localhost:8080') {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
  }

  /**
   * Get the current parameter metadata from the most recent graph load
   */
  getParameterMetadata(): GraphInfo | null {
    return this.parameterMetadata;
  }

  /**
   * Get ordered list of parameter labels for UI display
   * Returns array of {index: number, label: string, fullPath: string}
   */
  getParameterLabels(nodeType: string = 's'): Array<{ index: number; label: string; fullPath: string }> {
    if (!this.parameterMetadata) {
      // Return default labels if no metadata available
      return Array.from({ length: 10 }, (_, i) => ({
        index: i,
        label: `P${i}`,
        fullPath: `Parameter ${i}`
      }));
    }

    const parameterOrder = this.extractParameterOrder(this.parameterMetadata, nodeType);

    return parameterOrder.slice(0, 10).map((param, index) => ({
      index,
      label: param.key,
      fullPath: `${param.category}: ${param.key}`
    }));
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

      // Convert nodes from new format to internal format
      return this.convertNewFormatToInternal(data);

    } catch (error) {
      console.error('[PrismAPI] Simple graph fetch failed:', error);
      throw error;
    }
  }

  /**
   * Convert new JSON format to internal NodeData/EdgeData format
   * Handles nodes with details structure containing Variable Values, Atomic Propositions, etc.
   */
  private convertNewFormatToInternal(data: any): { nodes: NodeData[]; edges: EdgeData[] } {
    // Store parameter metadata from info section
    if (data.info) {
      this.parameterMetadata = data.info;
    }

    // Get the parameter order from info metadata
    const parameterOrder = this.extractParameterOrder(data.info, data.nodes[0]?.type || 's');

    // Create ID to index mapping (IDs might be strings like "244")
    const idToIndex = new Map<string, number>();

    const nodes: NodeData[] = data.nodes.map((node: any, index: number) => {
      const nodeId = String(node.id);
      idToIndex.set(nodeId, index);

      // Extract parameters from node details using the defined order
      const parameters = this.extractParametersFromNode(node, parameterOrder);

      // Determine node type based on Atomic Propositions
      let nodeType: 'normal' | 'important' = 'normal';
      if (node.details?.['Atomic Propositions']) {
        const props = node.details['Atomic Propositions'];
        if (props.init === true || props.deadlock === true) {
          nodeType = 'important';
        }
      }

      return {
        id: index,
        x: node.x || 0,
        y: node.y || 0,
        z: 0,
        radius: nodeType === 'important' ? 4 : 2,
        cluster: node.cluster || 0,
        value: node.value || Math.random(),
        type: nodeType,
        parameters
      };
    });

    // Convert edges, mapping string IDs to indices
    const edges: EdgeData[] = data.edges
      .filter((edge: any) => {
        const sourceId = String(edge.source);
        const targetId = String(edge.target);
        return idToIndex.has(sourceId) && idToIndex.has(targetId);
      })
      .map((edge: any) => {
        const sourceId = String(edge.source);
        const targetId = String(edge.target);
        return {
          from: idToIndex.get(sourceId)!,
          to: idToIndex.get(targetId)!,
          weight: edge.weight || edge.probability || 1
        };
      });

    console.log(`[PrismAPI] Converted: ${nodes.length} nodes, ${edges.length} edges`);
    return { nodes, edges };
  }

  /**
   * Extract parameter order from info metadata
   * Returns an ordered list of parameter paths to extract from node details
   */
  private extractParameterOrder(info: GraphInfo | undefined, nodeType: string): Array<{ category: string; key: string }> {
    const parameterOrder: Array<{ category: string; key: string }> = [];

    if (!info) {
      return parameterOrder;
    }

    // Get the appropriate node type info (s for states, t for transitions)
    const nodeTypeInfo = nodeType === 't' ? info.t : info.s;
    if (!nodeTypeInfo) {
      return parameterOrder;
    }

    // Define priority order for parameter categories
    const categoryOrder = [
      'Variable Values',
      'Model Checking Results',
      'Reward Structures',
      'Atomic Propositions'
    ];

    // Extract parameters in priority order
    for (const category of categoryOrder) {
      const categoryData = nodeTypeInfo[category];
      if (categoryData) {
        for (const key of Object.keys(categoryData)) {
          const metadata = categoryData[key];
          // Only include numeric types for visualization parameters
          if (metadata.type === 'number') {
            parameterOrder.push({ category, key });
          }
        }
      }
    }

    return parameterOrder;
  }

  /**
   * Extract 10 parameters from node details using the defined parameter order
   * If parameterOrder is provided, use it; otherwise fall back to default extraction
   */
  private extractParametersFromNode(
    node: any,
    parameterOrder?: Array<{ category: string; key: string }>
  ): [number, number, number, number, number, number, number, number, number, number] {
    const params: number[] = [];

    if (parameterOrder && parameterOrder.length > 0) {
      // Use the defined parameter order from metadata
      for (const { category, key } of parameterOrder) {
        if (params.length >= 10) break;

        const value = node.details?.[category]?.[key];
        if (typeof value === 'number' && !isNaN(value)) {
          params.push(value);
        }
      }
    } else {
      // Fallback to default extraction if no metadata available
      // Extract from Variable Values first
      if (node.details?.['Variable Values']) {
        const varValues = node.details['Variable Values'];
        for (const key of Object.keys(varValues)) {
          const value = varValues[key];
          if (typeof value === 'number' && !isNaN(value)) {
            params.push(value);
          }
        }
      }

      // Extract from Model Checking Results
      if (params.length < 10 && node.details?.['Model Checking Results']) {
        const mcResults = node.details['Model Checking Results'];
        for (const key of Object.keys(mcResults)) {
          const value = mcResults[key];
          if (typeof value === 'number' && !isNaN(value)) {
            params.push(value);
          }
          if (params.length >= 10) break;
        }
      }

      // Extract from Reward Structures
      if (params.length < 10 && node.details?.['Reward Structures']) {
        const rewards = node.details['Reward Structures'];
        for (const key of Object.keys(rewards)) {
          const value = rewards[key];
          if (typeof value === 'number' && !isNaN(value)) {
            params.push(value);
          }
          if (params.length >= 10) break;
        }
      }
    }

    // Pad with zeros if we don't have enough parameters
    while (params.length < 10) {
      params.push(0);
    }

    // Truncate to exactly 10 parameters
    return params.slice(0, 10) as [number, number, number, number, number, number, number, number, number, number];
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

    // Get parameter order if info is available
    const parameterOrder = prismData.info ? this.extractParameterOrder(prismData.info, 's') : undefined;

    const nodes: NodeData[] = prismNodes.map((node, index) => {
      const nodeId = node.id !== undefined ? node.id : index;
      idToIndex.set(nodeId, index);

      // Extract parameters from node (using details if available)
      const parameters = this.extractParametersFromNode(node, parameterOrder);

      return {
        id: index,
        x: node.x || 0,
        y: node.y || 0,
        z: 0,
        radius: node.type === 'target' ? 4 : (node.type === 'initial' ? 3 : 2),
        cluster: 0,
        value: node.properties?.value || Math.random(),
        type: (node.type === 'target' || node.type === 'initial') ? 'important' : 'normal',
        parameters
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

  /**
   * Fetch list of available projects
   */
  async fetchProjects(): Promise<string[]> {
    try {
      const url = `${this.baseUrl}/0/projects`;
      console.log(`[PrismAPI] Fetching projects from: ${url}`);

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

      const projects = await response.json();

      if (!Array.isArray(projects)) {
        throw new Error('Invalid response: expected array of project IDs');
      }

      console.log(`[PrismAPI] Found ${projects.length} projects`);
      return projects;

    } catch (error) {
      console.error('[PrismAPI] Failed to fetch projects:', error);
      throw error;
    }
  }

  /**
   * Fetch project status including parameter states
   */
  async fetchProjectStatus(projectId: string): Promise<any> {
    try {
      const url = `${this.baseUrl}/${encodeURIComponent(projectId)}/status`;
      console.log(`[PrismAPI] Fetching status from: ${url}`);

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

      const status = await response.json();

      // Update parameter metadata if status contains info
      if (status?.info) {
        this.parameterMetadata = status.info;
      }

      return status;

    } catch (error) {
      console.error('[PrismAPI] Failed to fetch project status:', error);
      throw error;
    }
  }

  /**
   * Trigger model checking for a project
   */
  async checkModel(projectId: string): Promise<any> {
    try {
      var url = `${this.baseUrl}/${encodeURIComponent(projectId)}/check`;
      var params = Object.keys(this.parameterMetadata?.s?.['Model Checking Results'] ?? {});
      if (params.length > 0) {
        const query = new URLSearchParams();
        params.forEach((p: string) => query.append('property', p));
        url += `?${query.toString()}`;
      }
      console.log(`[PrismAPI] Triggering model check: ${url}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // Longer timeout for model checking

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

      const result = await response.json();
      console.log(`[PrismAPI] Model check initiated for project: ${projectId}`);
      return result;

    } catch (error) {
      console.error('[PrismAPI] Model check failed:', error);
      throw error;
    }
  }

  /**
   * Reset model for a project
   */
  async resetModel(projectId: string): Promise<any> {
    try {
      const url = `${this.baseUrl}/${encodeURIComponent(projectId)}/clear`;
      console.log(`[PrismAPI] Resetting model: ${url}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

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

      const result = await response.json();
      console.log(`[PrismAPI] Model reset for project: ${projectId}`);
      return result;

    } catch (error) {
      console.error('[PrismAPI] Model reset failed:', error);
      throw error;
    }
  }

  /**
   * Check if any parameters are still missing in the status
   */
  hasMinsingParameters(status: any): boolean {
    if (!status?.info) return false;

    // Check scheduler section
    if (status.info.scheduler) {
      const schedulerValues = Object.values(status.info.scheduler);
      if (schedulerValues.some(v => v === 'missing')) {
        return true;
      }
    }

    // Check node type sections (s and t)
    for (const nodeType of ['s', 't']) {
      const nodeInfo = status.info[nodeType];
      if (!nodeInfo) continue;

      // Check all parameter categories
      for (const category of Object.keys(nodeInfo)) {
        const params = nodeInfo[category];
        if (typeof params === 'object') {
          for (const param of Object.values(params)) {
            if (typeof param === 'object' && (param as any).status === 'missing') {
              return true;
            }
          }
        }
      }
    }

    return false;
  }
}