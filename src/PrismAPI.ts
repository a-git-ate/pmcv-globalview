import type { NodeData, EdgeData } from './types';

export interface ParameterMetadata {
  type: 'number' | 'boolean' | 'nominal';
  status: string;
  min: number | string;
  max: number | string;
  identifier?: string;
  possibleValues?: string[];
}

export interface NodeTypeInfo {
  'Variable Values'?: Record<string, ParameterMetadata>;
  'Atomic Propositions'?: Record<string, ParameterMetadata>;
  'Model Checking Results'?: Record<string, ParameterMetadata>;
  'Reward Structures'?: Record<string, ParameterMetadata>;
  [key: string]: any;
}

export interface GraphInfo {
  id: string;
  scheduler?: Record<string, string>;
  s?: NodeTypeInfo; // State nodes
  t?: NodeTypeInfo; // Transition nodes
}



export class PrismAPI {
  private baseUrl: string;
  private readonly CACHE_TTL = 30000;
  private parameterMetadata: GraphInfo | null = null;
  private parameterOrder: Record<string, string[]> ={};

  constructor(baseUrl: string = 'http://localhost:8080') {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  getParameterMetadata(): GraphInfo | null {
    return this.parameterMetadata;
  }

  clearParameterMetadata(): void {
    this.parameterMetadata = null;
  }


  async fetchSimpleGraph(projectId: string = '0'): Promise<{ nodes: NodeData[]; edges: EdgeData[] }> {
    try {
      const url = `${this.baseUrl}/${projectId}`;
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
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();

      if (!data.nodes || !Array.isArray(data.nodes)) {
        throw new Error('Invalid response: missing nodes array');
      }

      if (!data.edges || !Array.isArray(data.edges)) {
        throw new Error('Invalid response: missing edges array');
      }

      return this.convertNewFormatToInternal(data);
    } catch (error) {
      console.error('[PrismAPI] Simple Graph fetch failed: ', error);
      throw error;
    }
  }
  private populateParameterOrder(info: any): void {
    const s_types = this.getParameterLabels('s');
    const t_types = this.getParameterLabels('t');
    const result = {...s_types, ...t_types };
    Object.keys(result).forEach((key) => {
      if (!(key in Object.keys(this.parameterOrder))) {
        this.parameterOrder[key] = result[key];
      }
    });
  }

  /* Retrieve nominal parameters from parameter metadata and returns
   2 json objects to be populated with possible values */
  private getNominalParams(): Record<string, string[]>[] {
    if (!this.parameterMetadata) return [];
    const sNominalParams: Record<string, string[]> = {};
    const tNominalParams: Record<string, string[]> = {};

    for (const type of ['s', 't'] as const) {
      const nodeInfo = this.parameterMetadata[type];
      if (!nodeInfo) continue;

      for (const category of Object.keys(nodeInfo)) {
        const params = nodeInfo[category];
        // Cast params to a known shape so entries have the expected type
        for (const [paramName, paramMeta] of Object.entries(params as Record<string, any>)) {
          if (type === 's'){
            if (paramMeta?.type === 'nominal' && !Object.keys(sNominalParams).includes(paramName)) {
              sNominalParams[paramName] = [];
            }
          }else{
            if (paramMeta?.type === 'nominal' && !Object.keys(tNominalParams).includes(paramName)) {
              tNominalParams[paramName] = [];
            }
          }

        }
      }
    }

    return [sNominalParams, tNominalParams];
  }
  private convertNewFormatToInternalST(data: any): { s_nodes: NodeData[]; t_nodes: NodeData[]; edges: EdgeData[] } {
    if (data.info) {
      this.parameterMetadata = data.info;
      this.populateParameterOrder(data.info);
    }

    const [sNominalParams, tNominalParams] = this.getNominalParams();

    const idToIndex = new Map<string, number>();

    // Filter s_nodes and t_nodes first
    const s_nodes_raw = data.nodes.filter((node: any) => node.type === 's');
    const t_nodes_raw = data.nodes.filter((node: any) => node.type === 't');

    // Create s_nodes with their global indices
    const s_nodes: NodeData[] = s_nodes_raw.map((node: any, arrayIndex: number) => {
      const nodeId = String(node.id);
      const globalIndex = arrayIndex; // Global index in the final combined array

      // Populate possible nominal parameter values
      // todo: see if you can get this directly from api
      for (const [categoryName, category] of Object.entries(node.details || {})){
        for (const [paramName, paramValue] of Object.entries(category as any)){
          if (Object.keys(sNominalParams).includes(paramName)){
            const valueStr = String(paramValue);
            if (!sNominalParams[paramName].includes(valueStr)){
              sNominalParams[paramName].push(valueStr);
            }
          }
        }
      }

      // Map original ID to global index for edge resolution
      idToIndex.set(nodeId, globalIndex);

      return {
        id: node.id, // Keep original ID
        index: globalIndex, // Add sequential index for positioning
        type: 's',
        name: node.name || '',
        x: 0,
        y: 0,
        cluster: 0,
        parameters: node.details || {}
      };
    });

    // Create t_nodes with their global indices (offset by s_nodes length)
    const t_nodes: NodeData[] = t_nodes_raw.map((node: any, arrayIndex: number) => {
      const nodeId = String(node.id);
      const globalIndex = s_nodes.length + arrayIndex; // Offset by s_nodes length

      // Populate possible values for nominal params
      for (const [categoryName, category] of Object.entries(node.details || {})){
        for (const [paramName, paramValue] of Object.entries(category as any)){
          if (Object.keys(tNominalParams).includes(paramName)){
            const valueStr = String(paramValue);
            if (!tNominalParams[paramName].includes(valueStr)){
              tNominalParams[paramName].push(valueStr);
            }
          }
        }
      }

      // Map original ID to global index for edge resolution
      idToIndex.set(nodeId, globalIndex);

      return {
        id: node.id, // Keep original ID
        index: globalIndex, // Add sequential index for positioning
        x: 0,
        y: 0,
        type: 't',
        cluster: 0,
        parameters: node.details || {},
        name: node.name || String(node.id)
      };
    });

    this.addNominalValuesToParameterMetadata(sNominalParams, tNominalParams);;

    const edges: EdgeData[] = [];
    for (let i = 0; i < data.edges.length; i++) {
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
      }
    }

    console.log(`[PrismAPI] Converted graph with ${s_nodes.length} s_nodes, ${t_nodes.length} t_nodes, ${edges.length} edges.`);
    return { s_nodes, t_nodes, edges };
  }


  convertNewFormatToInternal(data: any): { nodes: NodeData[]; edges: EdgeData[] } {
    const { s_nodes, t_nodes, edges } = this.convertNewFormatToInternalST(data);
    const nodes = [...s_nodes, ...t_nodes];
    console.log(`[PrismAPI] Fetched Graph with ${nodes.length} nodes`);
    return { nodes, edges };
  }

  public getPossibleValuesForParameter(categoryName: string, paramName: string): string[] {
    if (!this.parameterMetadata) return [];
    const possibleValues: string[] = [];
    for (const type of ['s', 't'] as const) {
      const nodeInfo = this.parameterMetadata[type];
      if (!nodeInfo) continue;

      if (categoryName in nodeInfo) {
        const category = nodeInfo[categoryName];
        if (paramName in category) {
          const paramMeta = category[paramName] as ParameterMetadata | undefined;
          if (paramMeta && paramMeta.type === 'nominal' && paramMeta.possibleValues) {
            return paramMeta.possibleValues;
          }
        }
      }
    }
    return possibleValues;
  }
  private addNominalValuesToParameterMetadata(sNominalParams: Record<string, string[]>, tNominalParams: Record<string, string[]>): void {
    if (!this.parameterMetadata) return;
    console.log(sNominalParams);
    console.log(tNominalParams);
    for (const type of ['s', 't'] as const) {
      console.log(`Processing node type: ${type}`);
      const nodeInfo = this.parameterMetadata[type];
      if (!nodeInfo) continue;

      for (const category of Object.keys(nodeInfo)) {
        const params = nodeInfo[category];
        console.log(` Processing category: ${category}`);
        
        for (const paramName of Object.keys(params)){
          console.log(`  Processing parameter: ${paramName}`);
          if (type === 's' && Object.keys(sNominalParams).includes(paramName)) {
            params[paramName].possibleValues = sNominalParams[paramName];
            console.log(`Added possible values for s param ${paramName}: ${params[paramName].possibleValues}`);
          }else if (type === 't' && Object.keys(tNominalParams).includes(paramName)) {
            params[paramName].possibleValues = tNominalParams[paramName];
            console.log(`Added possible values for t param ${paramName}: ${params[paramName].possibleValues}`);
          }
        }
      }
    }
    
  }

  public getParameterLabels(type: string): Record<string, string[]> {
    if (!this.parameterMetadata) return {};
    const originalObject = type === 's' ? this.parameterMetadata.s : this.parameterMetadata.t;
    if (!originalObject) return {};
    const test = Object.keys(originalObject);
    const extractedKeys = Object.keys(originalObject).reduce((acc, key) => {
      acc[key] = Object.keys(originalObject[key]);
      return acc;
    }, {} as Record<string, string[]>);
    return extractedKeys;
  }

  updateBaseUrl(newBaseUrl: string): void {
    this.baseUrl = newBaseUrl.replace(/\/$/, "");
  }

  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(this.baseUrl, {
        method: 'GET',
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch (error) {
      console.error('[PrismAPI] Health check failed: ', error);
      return false;
    }
  }

  async fetchProjects(): Promise<string[]> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      console.log(`[PrismAPI] Fetching projects from: ${this.baseUrl}/0/projects`);

      const response = await fetch(this.baseUrl + '/0/projects', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const projects = await response.json();

      if (!Array.isArray(projects)) {
        throw new Error('Invalid response: expected an array of project IDs');
      }

      console.log(`[PrismAPI] Fetched ${projects.length} projects.`);

      return projects;
    } catch (error) {
      console.error('[PrismAPI] Fetch projects failed: ', error);
      return [];
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
  static getParameterValue(node: NodeData, param: string): any {
    for (const category of Object.values(node.parameters || {})) {
      if (category[param] !== undefined) {
        return category[param];
      }
    }
    return null;
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
  public hasMissingParameters(status: any): boolean {
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
