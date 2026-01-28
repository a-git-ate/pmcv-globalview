import type { NodeData, EdgeData } from './types';
import type { ProgressIndicator } from './UIManager';
import { JSONParser } from '@streamparser/json';

export interface ParameterMetadata {
  type: 'number' | 'boolean' | 'nominal';
  status: string;
  min: number | string;
  max: number | string;
  identifier?: string;
  possibleValues?: string[];
  convertedFromNominal?: boolean;
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
  private worker: Worker | null = null;
  private useWorker: boolean = true; // Flag to enable/disable worker
  public progressIndicator: ProgressIndicator; // Public so other classes can use it
  private currentAbortController: AbortController | null = null; // For aborting fetch operations

  constructor(baseUrl: string = 'http://localhost:8080', useWorker: boolean = true, progressIndicator?: ProgressIndicator) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.useWorker = useWorker;

    // Use provided progress indicator or create a new one (for backwards compatibility)
    if (progressIndicator) {
      this.progressIndicator = progressIndicator;
    } else {
      // This should never happen in the refactored version, but keeping for safety
      throw new Error('[PrismAPI] ProgressIndicator must be provided');
    }

    // Initialize worker if enabled
    if (this.useWorker && typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./dataProcessing.worker.ts', import.meta.url), {
          type: 'module'
        });
        console.log('[PrismAPI] Web Worker initialized');
      } catch (error) {
        console.warn('[PrismAPI] Failed to initialize worker, falling back to main thread:', error);
        this.useWorker = false;
      }
    }
  }

  getParameterMetadata(): GraphInfo | null {
    return this.parameterMetadata;
  }

  clearParameterMetadata(): void {
    console.log('[PrismAPI] Clearing parameterMetadata');
    this.parameterMetadata = null;
  }

  /**
   * Cleanup method to terminate the worker when no longer needed
   */
  destroy(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      console.log('[PrismAPI] Web Worker terminated');
    }
  }


  async fetchSimpleGraph(projectId: string = '0'): Promise<{ nodes: NodeData[]; edges: EdgeData[] }> {
    try {
      const url = `${this.baseUrl}/${projectId}`;
      console.log(`[PrismAPI] Fetching simple graph from: ${url}`);
      const fetchStart = performance.now();

      // Create abort controller for this fetch
      this.currentAbortController = new AbortController();

      // Show progress indicator with abort button
      this.progressIndicator.show({
        title: 'Loading Graph Data',
        showAbortButton: true,
        onAbort: () => {
          console.log('[PrismAPI] User aborted fetch operation');
          if (this.currentAbortController) {
            this.currentAbortController.abort();
            this.currentAbortController = null;
          }
        }
      });
      this.progressIndicator.setIndeterminate('Downloading...');

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        signal: this.currentAbortController.signal
      });

      if (!response.ok) {
        this.currentAbortController = null;
        this.progressIndicator.hide();
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const fetchEnd = performance.now()
      const fetchTime = fetchEnd-fetchStart;
      console.log(`[PERFORMANCE] Fetched Graph in ${fetchTime.toFixed(2)}ms`);

      // Determine if we should use streaming based on content length
      const contentLength = response.headers.get('content-length');
      const estimatedSizeMB = contentLength ? parseInt(contentLength) / (1024 * 1024) : 0;
      const USE_STREAMING_THRESHOLD_MB = 50; // Use streaming for responses > 50MB

      let data: any;
      const parseStart = performance.now();

      if (estimatedSizeMB > USE_STREAMING_THRESHOLD_MB && response.body) {
        console.log(`[PrismAPI] Large response detected (${estimatedSizeMB.toFixed(2)}MB), using streaming parser`);
        this.progressIndicator.setStatus('Parsing JSON (streaming)...');
        data = await this.streamParseResponse(response, estimatedSizeMB);
      } else {
        console.log(`[PrismAPI] Small response (${estimatedSizeMB.toFixed(2)}MB), using standard parser`);
        this.progressIndicator.setStatus('Parsing JSON data...');
        data = await response.json();
      }

      const parseEnd = performance.now();
      const parseTime = parseEnd-parseStart;
      console.log(`[PERFORMANCE] Parsed JSON in ${parseTime.toFixed(2)}ms`)

      if (!data.nodes || !Array.isArray(data.nodes)) {
        this.currentAbortController = null;
        this.progressIndicator.hide();
        throw new Error('Invalid response: missing nodes array');
      }

      if (!data.edges || !Array.isArray(data.edges)) {
        this.currentAbortController = null;
        this.progressIndicator.hide();
        throw new Error('Invalid response: missing edges array');
      }

      // Update progress for data processing
      this.progressIndicator.setTitle('Processing Graph Data');
      this.progressIndicator.setStatus('Converting node data...');

      // Performance tracking: Start timer for local processing
      const PERFORMANCE = true;
      const processingStartTime = PERFORMANCE ? performance.now() : 0;

      const result = await this.convertNewFormatToInternal(data);

      // CRITICAL: Clear source data to free memory after conversion
      // This prevents 2x memory usage (parsed + converted)
      data.nodes = null;
      data.edges = null;
      data = null;

      // Performance tracking: End timer for local processing
      if (PERFORMANCE) {
        const processingTime = performance.now() - processingStartTime;
        console.log(`[PERFORMANCE] Local processing (model preprocessing): ${processingTime.toFixed(2)}ms`);
        console.log(`[PERFORMANCE] Sum: ${(fetchTime + parseTime + processingTime).toFixed(2)}ms`)
        console.log(`[MEMORY] Cleared source data after conversion to reduce memory footprint`);
      }

      // Clear abort controller and hide progress indicator when done
      this.currentAbortController = null;
      this.progressIndicator.hide();

      return result;
    } catch (error) {
      console.error('[PrismAPI] Simple Graph fetch failed: ', error);
      this.currentAbortController = null;
      this.progressIndicator.hide();

      // Check if it was aborted by user
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('[PrismAPI] Fetch was aborted by user');
        throw new Error('Operation cancelled by user');
      }

      throw error;
    }
  }

  /**
   * Stream-parse response body using @streamparser/json library
   * Optimized for large datasets (8M+ nodes)
   */
  private async streamParseResponse(response: Response, estimatedSizeMB: number): Promise<any> {
    return new Promise(async (resolve, reject) => {
      // Estimate node count from file size (rough: ~150 bytes per node in JSON)
      // Add 20% buffer to reduce reallocation probability
      const estimatedNodeCount = Math.floor((estimatedSizeMB * 1024 * 1024) / 150 * 1.2);

      // Pre-allocate arrays with conservative initial size to avoid massive reallocation
      const result: any = {
        nodes: new Array(Math.min(estimatedNodeCount > 0 ? estimatedNodeCount : 1000000, 10000000)), // Cap at 10M initial
        edges: new Array(Math.min(Math.floor(estimatedNodeCount * 1.5), 15000000)), // Pre-allocate edges too
        info: null
      };

      let nodeIndex = 0;
      let edgeIndex = 0;

      const parser = new JSONParser({
        stringBufferSize: 128 * 1024, // Increased to 128KB for better performance
        paths: ['$.nodes.*', '$.edges.*', '$.info'],
      });

      // Handle parsed values
      parser.onValue = ({ value, key, stack }) => {
        if (key === 'info' && stack.length === 1) {
          console.log('[PrismAPI] Captured info object from JSON');
          result.info = value;
        } else if (stack.length === 2) {
          const parentKey = stack[1]?.key;
          if (parentKey === 'nodes') {
            // Use direct index assignment instead of push for better performance
            result.nodes[nodeIndex++] = value;

            // Expand array if needed with larger chunks to reduce reallocations
            if (nodeIndex >= result.nodes.length) {
              // Use a more aggressive growth strategy for very large arrays
              // For arrays < 1M: double size
              // For arrays >= 1M: add 50% more
              const currentLength = result.nodes.length;
              const newSize = currentLength < 1000000
                ? currentLength * 2
                : Math.floor(currentLength * 1.5);

              console.log(`[PrismAPI] Expanding node array from ${currentLength.toLocaleString()} to ${newSize.toLocaleString()}`);

              // REVERT TO SIMPLE APPROACH: Just set length - V8 handles this efficiently
              // The manual array copy was causing massive slowdown at 80%+
              result.nodes.length = newSize;
            }

            if (nodeIndex % 50000 === 0) {
              console.log(`[PrismAPI] Parsed ${nodeIndex.toLocaleString()} nodes...`);
            }
          } else if (parentKey === 'edges') {
            result.edges[edgeIndex++] = value;

            // Expand edges array similarly
            if (edgeIndex >= result.edges.length) {
              const currentLength = result.edges.length;
              const newSize = currentLength < 1000000
                ? currentLength * 2
                : Math.floor(currentLength * 1.5);

              console.log(`[PrismAPI] Expanding edge array from ${currentLength.toLocaleString()} to ${newSize.toLocaleString()}`);

              // REVERT TO SIMPLE APPROACH: Just set length - V8 handles this efficiently
              result.edges.length = newSize;
            }

            if (edgeIndex % 50000 === 0) {
              console.log(`[PrismAPI] Parsed ${edgeIndex.toLocaleString()} edges...`);
            }
          }
        }
      };

      parser.onError = (error: Error) => {
        console.error('[PrismAPI] Stream parser error:', error);
        reject(error);
      };

      parser.onEnd = () => {
        // Trim arrays to actual size to free memory
        // IMPORTANT: Use slice() to create new arrays and allow GC to reclaim unused space
        result.nodes = result.nodes.slice(0, nodeIndex);
        result.edges = result.edges.slice(0, edgeIndex);

        console.log(`[PrismAPI] Stream parsing complete: ${nodeIndex.toLocaleString()} nodes, ${edgeIndex.toLocaleString()} edges`);
        console.log(`[PrismAPI] Memory optimization: Pre-allocated ${estimatedNodeCount.toLocaleString()} slots, used ${nodeIndex.toLocaleString()}`);
        console.log(`[PrismAPI] Trimmed arrays to exact size, freeing ${((estimatedNodeCount - nodeIndex) * 150).toLocaleString()} bytes estimate`);
        resolve(result);
      };

      try {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder('utf-8');
        let bytesReceived = 0;

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            parser.end();
            break;
          }

          // Decode chunk and pass to parser
          const chunk = decoder.decode(value, { stream: true });
          parser.write(chunk);

          // Update progress
          bytesReceived += value.length;
          const progressMB = bytesReceived / (1024 * 1024);
          const progressPercent = estimatedSizeMB > 0 ? (progressMB / estimatedSizeMB) * 100 : 0;
          this.progressIndicator.setStatus(
            `Parsing JSON... ${progressMB.toFixed(1)}MB / ${estimatedSizeMB.toFixed(1)}MB (${nodeIndex.toLocaleString()} nodes, ${edgeIndex.toLocaleString()} edges)`
          );
          if (estimatedSizeMB > 0) {
            this.progressIndicator.updateProgress(Math.min(100, progressPercent));
          }
        }
      } catch (error) {
        console.error('[PrismAPI] Error reading response stream:', error);
        reject(error);
      }
    });
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

  /**
   * Process graph data using Web Worker (if available)
   * Returns a promise that resolves with the processed data
   */
  private async convertNewFormatToInternalWorker(data: any): Promise<{ nodes: NodeData[]; edges: EdgeData[] }> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not available'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Worker processing timeout'));
      }, 30000); // 30 second timeout

      const handleMessage = (event: MessageEvent) => {
        const result = event.data;

        // Handle progress updates
        if (result.type === 'progress') {
          this.progressIndicator.updateProgress(result.progress);
          if (result.status) {
            this.progressIndicator.setStatus(result.status);
          }
          return; // Don't clear listeners, continue waiting for result
        }

        // Handle final result or error
        clearTimeout(timeout);
        this.worker!.removeEventListener('message', handleMessage);
        this.worker!.removeEventListener('error', handleError);

        if (result.type === 'error') {
          reject(new Error(result.error || 'Worker processing failed'));
          return;
        }

        // Store parameter metadata from worker result
        if (result.parameterMetadata) {
          this.parameterMetadata = result.parameterMetadata;
          this.populateParameterOrder(result.parameterMetadata);
        }

        const { nodes, edges } = result;

        // Process metadata on main thread using single-pass approach
        // The worker already did the node conversion, but we still need to process metadata
        // since it requires access to class state (this.parameterMetadata)
        this.processSinglePassMetadata(nodes);

        resolve({ nodes, edges });
      };

      const handleError = (error: ErrorEvent) => {
        clearTimeout(timeout);
        this.worker!.removeEventListener('message', handleMessage);
        this.worker!.removeEventListener('error', handleError);
        reject(new Error(`Worker error: ${error.message}`));
      };

      this.worker.addEventListener('message', handleMessage);
      this.worker.addEventListener('error', handleError);

      // Send data to worker
      this.worker.postMessage({ type: 'process', data });
    });
  }

  private async convertNewFormatToInternalMainThread(data: any): Promise<{ nodes: NodeData[]; edges: EdgeData[] }> {
    // Log memory at start
    const memStart = (performance as any).memory?.usedJSHeapSize || 0;
    console.log(`[PrismAPI] Memory at conversion start: ${(memStart / 1024 / 1024).toFixed(2)}MB`);

    if (data.info) {
      console.log('[PrismAPI] Setting parameterMetadata from data.info');
      this.parameterMetadata = data.info;
      this.populateParameterOrder(data.info);
    }

    const idToIndex = new Map<string, number>();

    // MEMORY OPTIMIZATION: Process nodes in-place to avoid creating 4 large arrays simultaneously
    // First, sort data.nodes in-place: s-nodes first, then t-nodes
    // This allows us to process without creating intermediate arrays

    const totalNodes = data.nodes.length;
    console.log(`[PrismAPI] Sorting ${totalNodes.toLocaleString()} nodes in-place by type...`);

    // Stable partition: move all s-nodes to front, t-nodes to back
    // This is more memory-efficient than creating separate arrays
    let writePos = 0;
    const tNodes: any[] = [];

    for (let i = 0; i < data.nodes.length; i++) {
      if (data.nodes[i].type === 's') {
        data.nodes[writePos++] = data.nodes[i];
      } else if (data.nodes[i].type === 't') {
        tNodes.push(data.nodes[i]);
      }
    }

    const s_count = writePos;
    const t_count = tNodes.length;

    // Append t-nodes after s-nodes
    for (let i = 0; i < tNodes.length; i++) {
      data.nodes[s_count + i] = tNodes[i];
    }

    // Trim to actual size
    data.nodes.length = s_count + t_count;

    console.log(`[PrismAPI] Sorted: ${s_count.toLocaleString()} s-nodes, ${t_count.toLocaleString()} t-nodes`);

    // Create output array
    const nodes: NodeData[] = new Array(totalNodes);

    console.log(`[PrismAPI] Converting ${totalNodes.toLocaleString()} nodes in a single pass...`);
    this.progressIndicator.setStatus(`Converting ${totalNodes.toLocaleString()} nodes...`);

    // Setup for single-pass parameter metadata collection
    // Get nominal params structure from metadata
    const [sNominalParams, tNominalParams] = this.getNominalParams();
    const sNominalKeys = Object.keys(sNominalParams);
    const tNominalKeys = Object.keys(tNominalParams);

    // Use Sets for nominal values (faster duplicate checking)
    const sNominalSets: Record<string, Set<string>> = {};
    const tNominalSets: Record<string, Set<string>> = {};

    // Initialize nominal sets with "undefined"
    for (let i = 0; i < sNominalKeys.length; i++) {
      sNominalSets[sNominalKeys[i]] = new Set(['undefined']);
    }
    for (let i = 0; i < tNominalKeys.length; i++) {
      tNominalSets[tNominalKeys[i]] = new Set(['undefined']);
    }

    // Track min/max for numeric parameters
    const paramStats: Record<string, { min: number; max: number }> = {};

    // For large graphs, use sampling for nominal values (but still calculate min/max for all)
    const SAMPLE_THRESHOLD = 50000;
    const SAMPLE_SIZE = 10000;
    const shouldSample = totalNodes > SAMPLE_THRESHOLD;
    const sampleEvery = shouldSample ? Math.ceil(totalNodes / SAMPLE_SIZE) : 1;

    if (shouldSample) {
      console.log(`[PrismAPI] Large graph detected (${totalNodes} nodes). Sampling every ${sampleEvery}th node for nominal values.`);
    }

    // SINGLE PASS: Create s_nodes with their global indices AND collect metadata
    // Now data.nodes is sorted: [s-nodes][t-nodes]
    for (let i = 0; i < s_count; i++) {
      const node = data.nodes[i];
      const nodeId = String(node.id);
      const globalIndex = i;

      idToIndex.set(nodeId, globalIndex);

      const nodeData: NodeData = {
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

      nodes[globalIndex] = nodeData;

      // Collect parameter metadata in the same pass
      if (nodeData.parameters && this.parameterMetadata) {
        const shouldSampleThisNode = !shouldSample || (i % sampleEvery === 0);

        for (const categoryName in nodeData.parameters) {
          if (!nodeData.parameters.hasOwnProperty(categoryName)) continue;

          const category = nodeData.parameters[categoryName];
          if (!category || typeof category !== 'object') continue;

          for (const paramName in category) {
            if (!category.hasOwnProperty(paramName)) continue;

            const value = category[paramName];

            // Collect nominal values (with sampling for large graphs)
            if (shouldSampleThisNode && sNominalKeys.includes(paramName)) {
              const valueStr = String(value);
              sNominalSets[paramName].add(valueStr);
            }

            // Always calculate min/max for numeric values (no sampling)
            if (typeof value === 'number' && isFinite(value)) {
              const key = `s::${categoryName}::${paramName}`;
              if (!paramStats[key]) {
                paramStats[key] = { min: value, max: value };
              } else {
                paramStats[key].min = Math.min(paramStats[key].min, value);
                paramStats[key].max = Math.max(paramStats[key].max, value);
              }
            }
          }
        }
      }

      // Yield to UI periodically
      if (i % 100000 === 0 && i > 0) {
        console.log(`[PrismAPI] Processed ${i.toLocaleString()} s-nodes...`);
        this.progressIndicator.setStatus(`Converting nodes: ${i.toLocaleString()} / ${totalNodes.toLocaleString()}`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // SINGLE PASS: Create t_nodes with their global indices AND collect metadata
    const s_length = s_count;
    for (let i = 0; i < t_count; i++) {
      const node = data.nodes[s_count + i];
      const nodeId = String(node.id);
      const globalIndex = s_length + i;

      idToIndex.set(nodeId, globalIndex);

      const nodeData: NodeData = {
        id: node.id,
        index: globalIndex,
        x: 0,
        y: 0,
        type: 't',
        cluster: 0,
        degree: 0,
        parameters: node.details || {},
        name: node.name || String(node.id)
      };

      nodes[globalIndex] = nodeData;

      // Collect parameter metadata in the same pass
      if (nodeData.parameters && this.parameterMetadata) {
        const shouldSampleThisNode = !shouldSample || (i % sampleEvery === 0);

        for (const categoryName in nodeData.parameters) {
          if (!nodeData.parameters.hasOwnProperty(categoryName)) continue;

          const category = nodeData.parameters[categoryName];
          if (!category || typeof category !== 'object') continue;

          for (const paramName in category) {
            if (!category.hasOwnProperty(paramName)) continue;

            const value = category[paramName];

            // Collect nominal values (with sampling for large graphs)
            if (shouldSampleThisNode && tNominalKeys.includes(paramName)) {
              const valueStr = String(value);
              tNominalSets[paramName].add(valueStr);
            }

            // Always calculate min/max for numeric values (no sampling)
            if (typeof value === 'number' && isFinite(value)) {
              const key = `t::${categoryName}::${paramName}`;
              if (!paramStats[key]) {
                paramStats[key] = { min: value, max: value };
              } else {
                paramStats[key].min = Math.min(paramStats[key].min, value);
                paramStats[key].max = Math.max(paramStats[key].max, value);
              }
            }
          }
        }
      }

      // Yield to UI periodically
      if (i % 100000 === 0 && i > 0) {
        const processed = s_length + i;
        console.log(`[PrismAPI] Processed ${processed.toLocaleString()} nodes total...`);
        this.progressIndicator.setStatus(`Converting nodes: ${processed.toLocaleString()} / ${totalNodes.toLocaleString()}`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    console.log(`[PrismAPI] All nodes converted, updating metadata...`);
    this.progressIndicator.setStatus('Updating parameter metadata...');
    await new Promise(resolve => setTimeout(resolve, 0));

    // Update parameterMetadata with collected nominal values
    if (this.parameterMetadata) {
      // Convert Sets to arrays and update s-type nominal params
      for (let i = 0; i < sNominalKeys.length; i++) {
        const paramName = sNominalKeys[i];
        sNominalParams[paramName] = Array.from(sNominalSets[paramName]);
      }

      // Convert Sets to arrays and update t-type nominal params
      for (let i = 0; i < tNominalKeys.length; i++) {
        const paramName = tNominalKeys[i];
        tNominalParams[paramName] = Array.from(tNominalSets[paramName]);
      }

      // Update metadata with nominal values
      for (const type of ['s', 't'] as const) {
        const nodeInfo = this.parameterMetadata[type];
        if (!nodeInfo) continue;

        const nominalParams = type === 's' ? sNominalParams : tNominalParams;
        const nominalKeys = type === 's' ? sNominalKeys : tNominalKeys;

        for (const category in nodeInfo) {
          if (!nodeInfo.hasOwnProperty(category)) continue;

          const params = nodeInfo[category];

          for (let i = 0; i < nominalKeys.length; i++) {
            const paramName = nominalKeys[i];
            if (paramName in params) {
              params[paramName].possibleValues = nominalParams[paramName];
            }
          }
        }
      }

      // Update metadata with min/max values
      for (const key in paramStats) {
        if (!paramStats.hasOwnProperty(key)) continue;

        const [nodeType, categoryName, paramName] = key.split('::');
        const stats = paramStats[key];

        const nodeInfo = this.parameterMetadata[nodeType as 's' | 't'];
        if (!nodeInfo) continue;

        const categoryParams = nodeInfo[categoryName];
        if (!categoryParams) continue;

        const param = categoryParams[paramName];
        if (!param) continue;

        if (param.type === 'number') {
          param.min = stats.min;
          param.max = stats.max;
        }
      }
    }

    // Convert numeric nominal parameters
    this.convertNumericNominalParameters();

    // CRITICAL MEMORY OPTIMIZATION: Clear data.nodes now that we've converted to NodeData[]
    // This frees up the raw parsed JSON objects before we process edges
    console.log('[PrismAPI] Clearing raw parsed data to free memory...');
    const memBeforeClear = (performance as any).memory?.usedJSHeapSize || 0;
    data.nodes.length = 0; // Clear the array to allow GC
    data.nodes = null; // Remove reference
    const memAfterClear = (performance as any).memory?.usedJSHeapSize || 0;
    if (memBeforeClear > 0) {
      console.log(`[PrismAPI] Memory before/after clearing nodes: ${(memBeforeClear / 1024 / 1024).toFixed(2)}MB -> ${(memAfterClear / 1024 / 1024).toFixed(2)}MB`);
    }

    // Process edges and calculate degrees in a single pass
    console.log(`[PrismAPI] Processing ${data.edges.length.toLocaleString()} edges...`);
    this.progressIndicator.setStatus(`Processing edges...`);
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

        nodes[fromIndex].degree!++;
        nodes[toIndex].degree!++;
      }

      // Yield to UI periodically for very large edge sets
      if (i % 100000 === 0 && i > 0) {
        console.log(`[PrismAPI] Processed ${i.toLocaleString()} edges...`);
        this.progressIndicator.setStatus(`Processing edges: ${i.toLocaleString()} / ${data.edges.length.toLocaleString()}`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // CRITICAL MEMORY OPTIMIZATION: Clear data.edges after processing
    data.edges.length = 0;
    data.edges = null;

    const memEnd = (performance as any).memory?.usedJSHeapSize || 0;
    console.log(`[PrismAPI] Converted graph with ${nodes.length} nodes, ${edges.length} edges in single pass.`);
    console.log('[PrismAPI] Cleared raw data - memory freed for GC');
    if (memStart > 0) {
      console.log(`[PrismAPI] Total memory delta: ${((memEnd - memStart) / 1024 / 1024).toFixed(2)}MB (start: ${(memStart / 1024 / 1024).toFixed(2)}MB, end: ${(memEnd / 1024 / 1024).toFixed(2)}MB)`);
    }

    return { nodes, edges };
  }


  async convertNewFormatToInternal(data: any): Promise<{ nodes: NodeData[]; edges: EdgeData[] }> {
    // Use worker if available, otherwise fall back to main thread
    if (this.useWorker && this.worker) {
      try {
        console.log('[PrismAPI] Processing data using Web Worker');
        return await this.convertNewFormatToInternalWorker(data);
      } catch (error) {
        console.warn('[PrismAPI] Worker processing failed, falling back to main thread:', error);
        return this.convertNewFormatToInternalMainThread(data);
      }
    } else {
      console.log('[PrismAPI] Processing data on main thread');
      return this.convertNewFormatToInternalMainThread(data);
    }
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
  /**
   * Process parameter metadata in a single pass (synchronous version for worker results)
   * This is called after worker processing to update metadata without re-iterating nodes
   */
  private processSinglePassMetadata(nodes: NodeData[]): void {
    if (!this.parameterMetadata || nodes.length === 0) return;

    console.log('[PrismAPI] Processing metadata in single pass (sync)...');

    // Get nominal params structure from metadata
    const [sNominalParams, tNominalParams] = this.getNominalParams();
    const sNominalKeys = Object.keys(sNominalParams);
    const tNominalKeys = Object.keys(tNominalParams);

    // Use Sets for nominal values
    const sNominalSets: Record<string, Set<string>> = {};
    const tNominalSets: Record<string, Set<string>> = {};

    // Initialize nominal sets
    for (let i = 0; i < sNominalKeys.length; i++) {
      sNominalSets[sNominalKeys[i]] = new Set(['undefined']);
    }
    for (let i = 0; i < tNominalKeys.length; i++) {
      tNominalSets[tNominalKeys[i]] = new Set(['undefined']);
    }

    // Track min/max for numeric parameters
    const paramStats: Record<string, { min: number; max: number }> = {};

    // Sampling for large graphs
    const SAMPLE_THRESHOLD = 50000;
    const SAMPLE_SIZE = 10000;
    const shouldSample = nodes.length > SAMPLE_THRESHOLD;
    const sampleEvery = shouldSample ? Math.ceil(nodes.length / SAMPLE_SIZE) : 1;

    // Single pass through nodes
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node.parameters) continue;

      const shouldSampleThisNode = !shouldSample || (i % sampleEvery === 0);
      const nominalKeys = node.type === 's' ? sNominalKeys : tNominalKeys;
      const nominalSets = node.type === 's' ? sNominalSets : tNominalSets;

      for (const categoryName in node.parameters) {
        if (!node.parameters.hasOwnProperty(categoryName)) continue;

        const category = node.parameters[categoryName];
        if (!category || typeof category !== 'object') continue;

        for (const paramName in category) {
          if (!category.hasOwnProperty(paramName)) continue;

          const value = category[paramName];

          // Collect nominal values (with sampling)
          if (shouldSampleThisNode && nominalKeys.includes(paramName)) {
            const valueStr = String(value);
            nominalSets[paramName].add(valueStr);
          }

          // Calculate min/max for numeric values (no sampling)
          if (typeof value === 'number' && isFinite(value)) {
            const key = `${node.type}::${categoryName}::${paramName}`;
            if (!paramStats[key]) {
              paramStats[key] = { min: value, max: value };
            } else {
              paramStats[key].min = Math.min(paramStats[key].min, value);
              paramStats[key].max = Math.max(paramStats[key].max, value);
            }
          }
        }
      }
    }

    // Update metadata with nominal values
    for (let i = 0; i < sNominalKeys.length; i++) {
      sNominalParams[sNominalKeys[i]] = Array.from(sNominalSets[sNominalKeys[i]]);
    }
    for (let i = 0; i < tNominalKeys.length; i++) {
      tNominalParams[tNominalKeys[i]] = Array.from(tNominalSets[tNominalKeys[i]]);
    }

    for (const type of ['s', 't'] as const) {
      const nodeInfo = this.parameterMetadata[type];
      if (!nodeInfo) continue;

      const nominalParams = type === 's' ? sNominalParams : tNominalParams;
      const nominalKeys = type === 's' ? sNominalKeys : tNominalKeys;

      for (const category in nodeInfo) {
        if (!nodeInfo.hasOwnProperty(category)) continue;

        const params = nodeInfo[category];

        for (let i = 0; i < nominalKeys.length; i++) {
          const paramName = nominalKeys[i];
          if (paramName in params) {
            params[paramName].possibleValues = nominalParams[paramName];
          }
        }
      }
    }

    // Update metadata with min/max values
    for (const key in paramStats) {
      if (!paramStats.hasOwnProperty(key)) continue;

      const [nodeType, categoryName, paramName] = key.split('::');
      const stats = paramStats[key];

      const nodeInfo = this.parameterMetadata[nodeType as 's' | 't'];
      if (!nodeInfo) continue;

      const categoryParams = nodeInfo[categoryName];
      if (!categoryParams) continue;

      const param = categoryParams[paramName];
      if (!param) continue;

      if (param.type === 'number') {
        param.min = stats.min;
        param.max = stats.max;
      }
    }

    // Convert numeric nominal parameters
    this.convertNumericNominalParameters();

    console.log('[PrismAPI] Metadata processing complete (sync)');
  }

  private addNominalValuesToParameterMetadata(nodes: NodeData[]): void {
    if (!this.parameterMetadata) return;

    const DEBUG = false; // Set to true to enable verbose logging
    if (DEBUG) console.log('[PrismAPI] addNominalValuesToParameterMetadata - START');

    // Get nominal params structure from metadata
    const [sNominalParams, tNominalParams] = this.getNominalParams();

    // Early exit if no nominal params
    const sNominalKeys = Object.keys(sNominalParams);
    const tNominalKeys = Object.keys(tNominalParams);
    if (sNominalKeys.length === 0 && tNominalKeys.length === 0) {
      return;
    }

    // Use Sets for much faster duplicate checking
    const sNominalSets: Record<string, Set<string>> = {};
    const tNominalSets: Record<string, Set<string>> = {};

    // Initialize with "undefined" value
    for (let i = 0; i < sNominalKeys.length; i++) {
      const paramName = sNominalKeys[i];
      sNominalSets[paramName] = new Set(['undefined']);
    }
    for (let i = 0; i < tNominalKeys.length; i++) {
      const paramName = tNominalKeys[i];
      tNominalSets[paramName] = new Set(['undefined']);
    }

    // For large graphs, use sampling strategy to avoid scanning all nodes
    const SAMPLE_THRESHOLD = 50000;
    const SAMPLE_SIZE = 10000;
    const shouldSample = nodes.length > SAMPLE_THRESHOLD;
    const nodesToScan = shouldSample ? Math.min(SAMPLE_SIZE, nodes.length) : nodes.length;

    if (shouldSample && DEBUG) {
      console.log(`[PrismAPI] Large graph detected (${nodes.length} nodes). Sampling ${nodesToScan} nodes for nominal values.`);
    }

    // Populate nominal params with actual values from nodes
    // Use direct property access instead of Object.entries() for better performance
    for (let i = 0; i < nodesToScan; i++) {
      const node = nodes[i];
      const nominalSets = node.type === 's' ? sNominalSets : tNominalSets;
      const nominalKeys = node.type === 's' ? sNominalKeys : tNominalKeys;

      if (!node.parameters) continue;

      // Direct iteration without Object.entries()
      for (const categoryName in node.parameters) {
        if (!node.parameters.hasOwnProperty(categoryName)) continue;

        const category = node.parameters[categoryName];
        if (!category || typeof category !== 'object') continue;

        // Check each nominal parameter directly
        for (let j = 0; j < nominalKeys.length; j++) {
          const paramName = nominalKeys[j];
          if (paramName in category) {
            const valueStr = String(category[paramName]);
            nominalSets[paramName].add(valueStr);
          }
        }
      }
    }

    // Convert Sets back to arrays
    for (let i = 0; i < sNominalKeys.length; i++) {
      const paramName = sNominalKeys[i];
      sNominalParams[paramName] = Array.from(sNominalSets[paramName]);
    }
    for (let i = 0; i < tNominalKeys.length; i++) {
      const paramName = tNominalKeys[i];
      tNominalParams[paramName] = Array.from(tNominalSets[paramName]);
    }

    if (DEBUG) {
      console.log('[PrismAPI] sNominalParams:', sNominalParams);
      console.log('[PrismAPI] tNominalParams:', tNominalParams);
    }

    // Update metadata - optimized with direct access
    for (const type of ['s', 't'] as const) {
      const nodeInfo = this.parameterMetadata[type];
      if (!nodeInfo) continue;

      const nominalParams = type === 's' ? sNominalParams : tNominalParams;
      const nominalKeys = type === 's' ? sNominalKeys : tNominalKeys;

      // Direct iteration without Object.keys()
      for (const category in nodeInfo) {
        if (!nodeInfo.hasOwnProperty(category)) continue;

        const params = nodeInfo[category];

        for (let i = 0; i < nominalKeys.length; i++) {
          const paramName = nominalKeys[i];
          if (paramName in params) {
            params[paramName].possibleValues = nominalParams[paramName];
          }
        }
      }
    }

    if (DEBUG) {
      console.log('[PrismAPI] addNominalValuesToParameterMetadata - END');
    }
  }

  /**
   * Async version that yields to UI for very large datasets
   */
  private async addNominalValuesToParameterMetadataAsync(nodes: NodeData[]): Promise<void> {
    if (!this.parameterMetadata) return;

    console.log('[PrismAPI] addNominalValuesToParameterMetadata (async) - START');

    // Get nominal params structure from metadata
    const [sNominalParams, tNominalParams] = this.getNominalParams();

    // Early exit if no nominal params
    const sNominalKeys = Object.keys(sNominalParams);
    const tNominalKeys = Object.keys(tNominalParams);
    if (sNominalKeys.length === 0 && tNominalKeys.length === 0) {
      return;
    }

    // Use Sets for much faster duplicate checking
    const sNominalSets: Record<string, Set<string>> = {};
    const tNominalSets: Record<string, Set<string>> = {};

    // Initialize with "undefined" value
    for (let i = 0; i < sNominalKeys.length; i++) {
      const paramName = sNominalKeys[i];
      sNominalSets[paramName] = new Set(['undefined']);
    }
    for (let i = 0; i < tNominalKeys.length; i++) {
      const paramName = tNominalKeys[i];
      tNominalSets[paramName] = new Set(['undefined']);
    }

    // For large graphs, use sampling strategy to avoid scanning all nodes
    const SAMPLE_THRESHOLD = 50000;
    const SAMPLE_SIZE = 10000;
    const shouldSample = nodes.length > SAMPLE_THRESHOLD;
    const nodesToScan = shouldSample ? Math.min(SAMPLE_SIZE, nodes.length) : nodes.length;

    if (shouldSample) {
      console.log(`[PrismAPI] Large graph detected (${nodes.length} nodes). Sampling ${nodesToScan} nodes for nominal values.`);
    }

    // Populate nominal params with actual values from nodes
    for (let i = 0; i < nodesToScan; i++) {
      const node = nodes[i];
      const nominalSets = node.type === 's' ? sNominalSets : tNominalSets;
      const nominalKeys = node.type === 's' ? sNominalKeys : tNominalKeys;

      if (!node.parameters) continue;

      for (const categoryName in node.parameters) {
        if (!node.parameters.hasOwnProperty(categoryName)) continue;

        const category = node.parameters[categoryName];
        if (!category || typeof category !== 'object') continue;

        for (let j = 0; j < nominalKeys.length; j++) {
          const paramName = nominalKeys[j];
          if (paramName in category) {
            const valueStr = String(category[paramName]);
            nominalSets[paramName].add(valueStr);
          }
        }
      }

      // Yield to UI periodically
      if (i % 50000 === 0 && i > 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // Convert Sets back to arrays
    for (let i = 0; i < sNominalKeys.length; i++) {
      const paramName = sNominalKeys[i];
      sNominalParams[paramName] = Array.from(sNominalSets[paramName]);
    }
    for (let i = 0; i < tNominalKeys.length; i++) {
      const paramName = tNominalKeys[i];
      tNominalParams[paramName] = Array.from(tNominalSets[paramName]);
    }

    // Update metadata
    for (const type of ['s', 't'] as const) {
      const nodeInfo = this.parameterMetadata[type];
      if (!nodeInfo) continue;

      const nominalParams = type === 's' ? sNominalParams : tNominalParams;
      const nominalKeys = type === 's' ? sNominalKeys : tNominalKeys;

      for (const category in nodeInfo) {
        if (!nodeInfo.hasOwnProperty(category)) continue;

        const params = nodeInfo[category];

        for (let i = 0; i < nominalKeys.length; i++) {
          const paramName = nominalKeys[i];
          if (paramName in params) {
            params[paramName].possibleValues = nominalParams[paramName];
          }
        }
      }
    }

    console.log('[PrismAPI] addNominalValuesToParameterMetadata (async) - END');
  }

  /**
   * Convert nominal parameters to number type if all their possible values are numeric
   * This should be called after addNominalValuesToParameterMetadata
   */
  private convertNumericNominalParameters(): void {
    if (!this.parameterMetadata) return;

    const DEBUG = false;
    if (DEBUG) console.log('[PrismAPI] convertNumericNominalParameters - START');

    // Check both s and t node types
    for (const type of ['s', 't'] as const) {
      const nodeInfo = this.parameterMetadata[type];
      if (!nodeInfo) continue;

      // Iterate through categories
      for (const categoryName in nodeInfo) {
        if (!nodeInfo.hasOwnProperty(categoryName)) continue;

        const params = nodeInfo[categoryName];
        if (!params || typeof params !== 'object') continue;

        // Check each parameter
        for (const paramName in params) {
          if (!params.hasOwnProperty(paramName)) continue;

          const paramMeta = params[paramName] as ParameterMetadata;

          // Only process nominal parameters with possibleValues
          if (paramMeta.type !== 'nominal' || !paramMeta.possibleValues || paramMeta.possibleValues.length === 0) {
            continue;
          }

          // Check if all possible values (excluding 'undefined') are numeric
          const numericValues: number[] = [];
          let allNumeric = true;

          for (const val of paramMeta.possibleValues) {
            if (val === 'undefined') continue; // Skip 'undefined' values

            const numVal = parseFloat(val);
            if (isNaN(numVal)) {
              allNumeric = false;
              break;
            }
            numericValues.push(numVal);
          }

          // If all values are numeric, convert the parameter type to 'number'
          if (allNumeric && numericValues.length > 0) {
            const min = Math.min(...numericValues);
            const max = Math.max(...numericValues);

            if (DEBUG) {
              console.log(`[PrismAPI] Converting ${type}/${categoryName}/${paramName} from nominal to number (min=${min}, max=${max})`);
            }

            // Convert to number type
            paramMeta.type = 'number';
            paramMeta.min = min;
            paramMeta.max = max;
            // Keep possibleValues for reference if needed, but mark as converted
            (paramMeta as any).convertedFromNominal = true;
          }
        }
      }
    }

    if (DEBUG) console.log('[PrismAPI] convertNumericNominalParameters - END');
  }

  /**
   * Calculate actual min/max values for all numeric parameters from node data
   * and update the parameterMetadata cache
   */
  private calculateParameterMinMax(nodes: NodeData[]): void {
    if (!this.parameterMetadata || nodes.length === 0) return;

    const DEBUG = false; // Set to true to enable verbose logging
    if (DEBUG) console.log('[PrismAPI] calculateParameterMinMax - START');

    // Track min/max for each parameter across all nodes
    const paramStats: Record<string, { min: number; max: number; category: string; nodeType: 's' | 't' }> = {};

    // Single pass through all nodes to calculate min/max
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node.parameters) continue;

      const nodeType = node.type;

      // Iterate through categories
      for (const categoryName in node.parameters) {
        if (!node.parameters.hasOwnProperty(categoryName)) continue;

        const category = node.parameters[categoryName];
        if (!category || typeof category !== 'object') continue;

        // Iterate through parameters in this category
        for (const paramName in category) {
          if (!category.hasOwnProperty(paramName)) continue;

          const value = category[paramName];

          // Only process numeric values
          if (typeof value !== 'number' || !isFinite(value)) continue;

          const key = `${nodeType}::${categoryName}::${paramName}`;

          if (!paramStats[key]) {
            paramStats[key] = {
              min: value,
              max: value,
              category: categoryName,
              nodeType: nodeType
            };
          } else {
            paramStats[key].min = Math.min(paramStats[key].min, value);
            paramStats[key].max = Math.max(paramStats[key].max, value);
          }
        }
      }
    }

    // Update parameterMetadata with calculated min/max values
    for (const key in paramStats) {
      if (!paramStats.hasOwnProperty(key)) continue;

      const [nodeType, categoryName, paramName] = key.split('::');
      const stats = paramStats[key];

      const nodeInfo = this.parameterMetadata[nodeType as 's' | 't'];
      if (!nodeInfo) continue;

      const categoryParams = nodeInfo[categoryName];
      if (!categoryParams) continue;

      const param = categoryParams[paramName];
      if (!param) continue;

      // Update min/max only if they are numeric parameters
      if (param.type === 'number') {
        param.min = stats.min;
        param.max = stats.max;

        if (DEBUG) {
          console.log(`[PrismAPI] Updated ${nodeType}/${categoryName}/${paramName}: min=${stats.min}, max=${stats.max}`);
        }
      }
    }

    if (DEBUG) console.log('[PrismAPI] calculateParameterMinMax - END');
  }

  /**
   * Async version that yields to UI for very large datasets
   */
  private async calculateParameterMinMaxAsync(nodes: NodeData[]): Promise<void> {
    if (!this.parameterMetadata || nodes.length === 0) return;

    console.log('[PrismAPI] calculateParameterMinMax (async) - START');

    // Track min/max for each parameter across all nodes
    const paramStats: Record<string, { min: number; max: number; category: string; nodeType: 's' | 't' }> = {};

    // Single pass through all nodes to calculate min/max
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node.parameters) continue;

      const nodeType = node.type;

      // Iterate through categories
      for (const categoryName in node.parameters) {
        if (!node.parameters.hasOwnProperty(categoryName)) continue;

        const category = node.parameters[categoryName];
        if (!category || typeof category !== 'object') continue;

        // Iterate through parameters in this category
        for (const paramName in category) {
          if (!category.hasOwnProperty(paramName)) continue;

          const value = category[paramName];

          // Only process numeric values
          if (typeof value !== 'number' || !isFinite(value)) continue;

          const key = `${nodeType}::${categoryName}::${paramName}`;

          if (!paramStats[key]) {
            paramStats[key] = {
              min: value,
              max: value,
              category: categoryName,
              nodeType: nodeType
            };
          } else {
            paramStats[key].min = Math.min(paramStats[key].min, value);
            paramStats[key].max = Math.max(paramStats[key].max, value);
          }
        }
      }

      // Yield to UI periodically
      if (i % 100000 === 0 && i > 0) {
        console.log(`[PrismAPI] Calculated min/max for ${i.toLocaleString()} / ${nodes.length.toLocaleString()} nodes...`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // Update parameterMetadata with calculated min/max values
    for (const key in paramStats) {
      if (!paramStats.hasOwnProperty(key)) continue;

      const [nodeType, categoryName, paramName] = key.split('::');
      const stats = paramStats[key];

      const nodeInfo = this.parameterMetadata[nodeType as 's' | 't'];
      if (!nodeInfo) continue;

      const categoryParams = nodeInfo[categoryName];
      if (!categoryParams) continue;

      const param = categoryParams[paramName];
      if (!param) continue;

      // Update min/max only if they are numeric parameters
      if (param.type === 'number') {
        param.min = stats.min;
        param.max = stats.max;
      }
    }

    console.log('[PrismAPI] calculateParameterMinMax (async) - END');
  }

  /**
   * Public method to recalculate parameter min/max values
   * Useful after adding new parameters (like PCA components) to nodes
   */
  public recalculateParameterMinMax(nodes: NodeData[]): void {
    this.calculateParameterMinMax(nodes);
  }

  /**
   * Get cached min/max values for a specific parameter
   * Returns null if parameter not found or not numeric
   */
  public getParameterMinMax(paramName: string, nodeType?: 's' | 't'): { min: number; max: number } | null {
    if (!this.parameterMetadata) return null;

    // Search through node types
    const nodeTypes: Array<'s' | 't'> = nodeType ? [nodeType] : ['s', 't'];

    for (const type of nodeTypes) {
      const nodeInfo = this.parameterMetadata[type];
      if (!nodeInfo) continue;

      // Search through categories
      for (const categoryName in nodeInfo) {
        if (!nodeInfo.hasOwnProperty(categoryName)) continue;

        const category = nodeInfo[categoryName];
        if (!category || typeof category !== 'object') continue;

        // Check if parameter exists in this category
        if (paramName in category) {
          const param = category[paramName] as ParameterMetadata;

          // Return min/max only for numeric parameters
          if (param.type === 'number' && typeof param.min === 'number' && typeof param.max === 'number') {
            return { min: param.min, max: param.max };
          }
        }
      }
    }

    return null;
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

  /**
   * Get parameter labels from both s and t node types, merged together
   * Returns a combined map of all available parameters
   */
  public getAllParameterLabels(): Record<string, string[]> {
    if (!this.parameterMetadata) return {};

    const result: Record<string, string[]> = {};

    // Process both s and t node types
    for (const type of ['s', 't'] as const) {
      const nodeInfo = this.parameterMetadata[type];
      if (!nodeInfo) continue;

      // Iterate through categories
      for (const categoryName of Object.keys(nodeInfo)) {
        const params = nodeInfo[categoryName];
        if (!params || typeof params !== 'object') continue;

        // Get parameter names for this category
        const paramNames = Object.keys(params);

        // Merge with existing parameters for this category
        if (!result[categoryName]) {
          result[categoryName] = [];
        }

        // Add parameters that don't already exist in the result
        for (const paramName of paramNames) {
          if (!result[categoryName].includes(paramName)) {
            result[categoryName].push(paramName);
          }
        }
      }
    }

    return result;
  }

  /**
   * Check which node types (s, t, or both) have a specific parameter
   * Returns 's', 't', 'st', or null
   * @param paramName Parameter name, can be in "category::paramName" format or just "paramName"
   */
  public getParameterNodeTypes(paramName: string): string | null {
    if (!this.parameterMetadata) return null;

    let hasS = false;
    let hasT = false;

    // Handle "category::paramName" format
    if (paramName.includes('::')) {
      const [category, name] = paramName.split('::');

      // Check in 's' nodes
      if (this.parameterMetadata.s && this.parameterMetadata.s[category] && this.parameterMetadata.s[category][name]) {
        hasS = true;
      }

      // Check in 't' nodes
      if (this.parameterMetadata.t && this.parameterMetadata.t[category] && this.parameterMetadata.t[category][name]) {
        hasT = true;
      }
    } else {
      // Original behavior: search all categories for the parameter
      // Check in 's' nodes
      if (this.parameterMetadata.s) {
        for (const category of Object.keys(this.parameterMetadata.s)) {
          if (this.parameterMetadata.s[category][paramName]) {
            hasS = true;
            break;
          }
        }
      }

      // Check in 't' nodes
      if (this.parameterMetadata.t) {
        for (const category of Object.keys(this.parameterMetadata.t)) {
          if (this.parameterMetadata.t[category][paramName]) {
            hasT = true;
            break;
          }
        }
      }
    }

    if (hasS && hasT) return 'st';
    if (hasS) return 's';
    if (hasT) return 't';
    return null;
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
        console.log('[PrismAPI] Updating parameterMetadata from status.info');

        // Preserve possibleValues from existing metadata before overwriting
        if (this.parameterMetadata) {
          for (const type of ['s', 't'] as const) {
            const existingNodeInfo = this.parameterMetadata[type];
            const newNodeInfo = status.info[type];

            if (existingNodeInfo && newNodeInfo) {
              for (const category of Object.keys(existingNodeInfo)) {
                if (newNodeInfo[category]) {
                  for (const paramName of Object.keys(existingNodeInfo[category])) {
                    if (newNodeInfo[category][paramName]) {
                      const possibleValues = existingNodeInfo[category][paramName]?.possibleValues;
                      if (possibleValues) {
                        console.log(`[PrismAPI] Preserving possibleValues for ${type}.${category}.${paramName}:`, possibleValues);
                        newNodeInfo[category][paramName].possibleValues = possibleValues;
                      }
                    }
                  }
                }
              }
            }
          }
        }

        this.parameterMetadata = status.info;
        console.log('[PrismAPI] parameterMetadata updated with preserved possibleValues');
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
      // Collect Model Checking Results from both s and t node types
      const sParams = Object.keys(this.parameterMetadata?.s?.['Model Checking Results'] ?? {});
      const tParams = Object.keys(this.parameterMetadata?.t?.['Model Checking Results'] ?? {});
      const params = [...new Set([...sParams, ...tParams])]; // Merge and deduplicate
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
    // Check if param is in "category::paramName" format
    if (param.includes('::')) {
      const [category, paramName] = param.split('::');
      if (node.parameters[category] && node.parameters[category][paramName] !== undefined) {
        return node.parameters[category][paramName];
      }
      return null;
    }

    // BUGFIX: When searching for parameters without explicit category, use a priority order
    // to handle duplicate parameter names across categories consistently.
    // Priority: Model Checking Results > Scheduler > Action Parameter > Reward Structures > others
    const categoryPriority = [
      'Model Checking Results',
      'Scheduler',
      'Action Parameter',
      'Reward Structures',
      'Atomic Propositions'
    ];

    // First, check priority categories in order
    for (const categoryName of categoryPriority) {
      const category = node.parameters[categoryName];
      if (category && category[param] !== undefined) {
        return category[param];
      }
    }

    // Then check any remaining categories
    for (const [categoryName, category] of Object.entries(node.parameters || {})) {
      if (!categoryPriority.includes(categoryName) && category[param] !== undefined) {
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
