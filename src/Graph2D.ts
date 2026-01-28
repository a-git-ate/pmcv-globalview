import * as THREE from 'three';
import { UIManager } from './UIManager';
import { PrismAPI } from './PrismAPI';
import { ProjectManager } from './ProjectManager';
import { PCA as MLPCA } from 'ml-pca';

import type {
  NodeData,
  EdgeData,
  GraphConfig,
  LayoutType,
  NodeClickEvent
} from './types';
import { min } from 'three/examples/jsm/nodes/Nodes.js';

// Global logging configuration
const DEBUG = true;        // Enable/disable debug logs
const PERFORMANCE = true;  // Enable/disable performance logs
const STATUS = false;        // Enable/disable status logs

export class Graph2D {
  // Three.js core
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private renderer: THREE.WebGLRenderer | null = null;
  private pointCloud: THREE.Points | null = null;

  // Graph data
  private nodes: NodeData[] = [];
  private edges: EdgeData[] = [];
  // REMOVED: fullNodes and fullEdges were unused duplicates causing 2x memory usage
  // private fullNodes : NodeData[] = [];
  // private fullEdges : EdgeData[] = [];
  private nodeCount: number = 0;
  private currentLayout: LayoutType = 'none';
  private loadedProjectId: string | null = null;
  private edgeLines: THREE.Group | THREE.LineSegments | null = null;

  // Axis visualization
  private axisGroup: THREE.Group | null = null;
  private gridLinesVisible: boolean = false;

  // Overlap labels
  private overlapLabelsGroup: THREE.Group | null = null;

  // Current filter function (for overlap label counting)
  private currentFilterFn: ((node: NodeData) => boolean) | null = null;

  // Tooltip
  private tooltipElement: HTMLElement | null = null;
  private hoveredNodeIndex: number = -1;

  // Selection
  private selectedNodeIndices: Set<number> = new Set();

  // Geometry to nodes mapping (for stacked nodes)
  // Maps geometry point index to array of node indices at that position
  private geometryToNodesMap: Map<number, number[]> = new Map();

  // Cached stack map created during node placement (optimization)
  private cachedStackMap: Map<number, number[]> | null = null;
  private lastStackGenTime: number = 0;

  // PCA Results storage
  private pcaResults: {
    eigenvectors: Array<{eigenvalue: number, eigenvector: number[]}>;
    parameterNames: string[];
    varianceExplained: number;
  } | null = null;

  // Store current parameter axes info for dynamic updates
  private currentAxisInfo: {
    xParamIndex: string;
    yParamIndex: string;
    minValues: { x: number; y: number };
    maxValues: { x: number; y: number };
    spread: number;
  } | null = null;

  // Transform and interaction
  private panOffset: THREE.Vector2 = new THREE.Vector2(0, 0);
  private zoomLevel: number = 1.0;

  // Animation and effects
  private autoRotate: boolean = false;
  private pulseEffect: boolean = false;
  private animationTime: number = 0;

  // Configuration
  private config: GraphConfig;

  // UI Manager
  public ui: UIManager;

  // PRISM API Integration
  public prismAPI: PrismAPI;

  // Project Manager
  public projectManager: ProjectManager;

  // Performance tracking
  private lastRenderTime: number = 0;

  constructor(config?: Partial<GraphConfig>) {
    // Initialize configuration with defaults
    this.config = {
      maxVisibleNodes: 10000,
      renderDistance: 500,
      minZoom: 0.001, // Allow zooming out much further (was 0.1)
      maxZoom: 10000.0, // Allow extreme zoom in (was 100.0)
      lodEnabled: true,
      edgesVisible: true, // Show edges by default
      clusterMode: false,
      forceStrength: 0.1,
      springLength: 30,
      iterations: 100,
      ...config
    };

    // Initialize Three.js scene
    this.scene = new THREE.Scene();

    // Create orthographic camera for true 2D view
    const aspect = window.innerWidth / window.innerHeight;
    const viewSize = 50;
    this.camera = new THREE.OrthographicCamera(
      -viewSize * aspect, 
      viewSize * aspect,
      viewSize, 
      -viewSize,
      0.1, 
      1000
    );

    // Initialize UI Manager
    this.ui = new UIManager(this);

    // Initialize PRISM API with progress indicator from UI Manager
    this.prismAPI = new PrismAPI('http://localhost:8080', true, this.ui.progressIndicator);

    // Initialize Project Manager
    this.projectManager = new ProjectManager(this, this.prismAPI);

    this.init();
  }

  private init(): void {
    this.ui.updateStatus("Initializing 2D graph...");

    try {
      this.setupRenderer();
      this.setupCamera();
      this.setupControls();
      this.setupTooltip();
      this.startAnimationLoop();

      // Notify UI of initial layout state
      this.ui.onLayoutChange(this.currentLayout);

      this.ui.updateStatus("2D system ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.ui.showError(message);
      return;
    }
  }

  private setupTooltip(): void {
    this.tooltipElement = document.getElementById('node-tooltip');
    if (!this.tooltipElement) {
      console.warn('Tooltip element not found');
    }
  }

  private setupRenderer(): void {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false
    });

    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0xf5f5f5, 1.0); // Light gray background

    const container = document.getElementById('container');
    if (!container) {
      throw new Error('Container element not found');
    }

    container.appendChild(this.renderer.domElement);
  }

  // MEMORY OPTIMIZATION: Removed fullNodes/fullEdges duplicates
  // These were storing the same references as this.nodes/this.edges
  public getFullNodes(): NodeData[] {
    return this.nodes; // Return nodes directly (no duplication)
  }

  public getFullEdges(): EdgeData[] {
    return this.edges; // Return edges directly (no duplication)
  }

  private setupCamera(): void {
    this.camera.position.set(0, 0, 100);
    this.camera.lookAt(0, 0, 0);
  }

  private setupControls(): void {
    if (!this.renderer) return;

    let isDragging = false;
    const lastMouse = new THREE.Vector2();
    const canvas = this.renderer.domElement;

    // Mouse down
    canvas.addEventListener('mousedown', (event: MouseEvent) => {
      isDragging = true;
      lastMouse.set(event.clientX, event.clientY);
    });

    // Mouse up
    window.addEventListener('mouseup', () => {
      isDragging = false;
    });

    // Mouse move (panning)
    canvas.addEventListener('mousemove', (event: MouseEvent) => {
      if (!isDragging) return;

      const deltaX = event.clientX - lastMouse.x;
      const deltaY = event.clientY - lastMouse.y;

      const panSpeed = 0.1 / this.zoomLevel;
      this.panOffset.x -= deltaX * panSpeed;
      this.panOffset.y += deltaY * panSpeed;

      this.updateCameraPosition();
      lastMouse.set(event.clientX, event.clientY);
    });

    // Wheel (zooming)
    canvas.addEventListener('wheel', (event: WheelEvent) => {
      event.preventDefault();

      // Use multiplicative zoom for constant speed regardless of zoom level
      const zoomFactor = 1.1; // 10% change per scroll
      const newZoomLevel = event.deltaY > 0
        ? this.zoomLevel / zoomFactor  // Zoom out
        : this.zoomLevel * zoomFactor; // Zoom in

      this.zoomLevel = Math.max(
        this.config.minZoom,
        Math.min(this.config.maxZoom, newZoomLevel)
      );

      this.updateCameraPosition();
      this.ui.updateZoomDisplay(this.zoomLevel);
    });

    // Click (node selection)
    canvas.addEventListener('click', (event: MouseEvent) => {
      this.onNodeClick(event);
    });

    // Hover (tooltip)
    canvas.addEventListener('mousemove', (event: MouseEvent) => {
      this.onMouseMove(event);
    });

    // Window resize
    window.addEventListener('resize', () => this.onWindowResize());
  }

  private updateCameraPosition(): void {
    const aspect = window.innerWidth / window.innerHeight;
    const viewSize = 50 / this.zoomLevel;

    // For 1:1 aspect ratio, use the same scale for both X and Y
    // Only adjust horizontal extent based on aspect ratio
    if (aspect > 1) {
      // Wider than tall - expand horizontally
      this.camera.left = -viewSize * aspect + this.panOffset.x;
      this.camera.right = viewSize * aspect + this.panOffset.x;
      this.camera.top = viewSize + this.panOffset.y;
      this.camera.bottom = -viewSize + this.panOffset.y;
    } else {
      // Taller than wide - expand vertically
      this.camera.left = -viewSize + this.panOffset.x;
      this.camera.right = viewSize + this.panOffset.x;
      this.camera.top = viewSize / aspect + this.panOffset.y;
      this.camera.bottom = -viewSize / aspect + this.panOffset.y;
    }

    this.camera.updateProjectionMatrix();

    // Update axes if they exist
    if (this.currentAxisInfo) {
      this.updateAxisVisualization();
    }

    // Update overlap label positions for new zoom/pan
    if (this.overlapLabelsGroup) {
      this.updateOverlapLabelPositions();
    }
  }



  /**
   * Perform PCA using ml-pca library on selected parameters and node types
   * @param selectedParams Array of parameter objects with category, paramName, and nodeTypes
   * @param center Whether to center the data (subtract mean)
   * @param scale Whether to scale the data (standardize)
   * @returns Object containing success status and any zero variance parameters that were auto-deselected
   */
  public doMLPCAWithSelection(
    selectedParams: Array<{category: string, paramName: string, nodeTypes: Set<'s' | 't'>}>,
    center: boolean = true,
    scale: boolean = true
  ): { success: boolean; zeroVarianceParams: string[] } {
    if (this.nodes.length === 0) {
      console.warn('[Graph2D] No nodes available for PCA');
      return { success: false, zeroVarianceParams: [] };
    }

    if (selectedParams.length < 2) {
      console.warn('[Graph2D] PCA requires at least 2 parameters');
      alert('Please select at least 2 parameters for PCA');
      return { success: false, zeroVarianceParams: [] };
    }

    if (STATUS) console.log('[Graph2D] ========== ML-PCA PERFORMANCE METRICS ==========');
    if (STATUS) console.log('[Graph2D] Starting ML-PCA with selected parameters:', selectedParams);

    const perfStart = performance.now();
    const memStart = (performance as any).memory ? (performance as any).memory.usedJSHeapSize : 0;

    // Track zero variance parameters that were auto-removed during retry
    let zeroVarianceParamsToReturn: string[] = [];

    // 1. Clear existing PCA data from all nodes
    this.prismAPI.progressIndicator.setStatus('Clearing previous PCA data...');
    this.clearPCAData();

    // 2. Get selected node types from checkboxes
    const sNodeCheckbox = document.getElementById('pca-node-type-s') as HTMLInputElement;
    const tNodeCheckbox = document.getElementById('pca-node-type-t') as HTMLInputElement;
    const includeS = sNodeCheckbox?.checked ?? true;
    const includeT = tNodeCheckbox?.checked ?? true;

    // 3. Build data matrix from selected nodes and parameters
    this.prismAPI.progressIndicator.setStatus('Building data matrix...');
    let { dataMatrix, nodeIndices, parameterNames } = this.buildPCADataMatrix(
      selectedParams,
      includeS,
      includeT
    );

    if (dataMatrix.length === 0) {
      console.warn('[Graph2D] No valid data for PCA');
      alert('No valid numeric data found for selected parameters');
      return { success: false, zeroVarianceParams: [] };
    }

    if (DEBUG) console.log(`[Graph2D] PCA data matrix: ${dataMatrix.length} nodes × ${parameterNames.length} parameters`);

    // DEBUG: Check data matrix for NaN or invalid values
    let nanCount = 0;
    let infCount = 0;
    for (let i = 0; i < Math.min(5, dataMatrix.length); i++) {
      if (DEBUG) console.log(`[Graph2D] DEBUG data matrix row ${i}:`, dataMatrix[i]);
      for (let j = 0; j < dataMatrix[i].length; j++) {
        if (isNaN(dataMatrix[i][j])) nanCount++;
        if (!isFinite(dataMatrix[i][j])) infCount++;
      }
    }
    if (nanCount > 0 || infCount > 0) {
      console.error(`[Graph2D] ERROR: Data matrix contains ${nanCount} NaN values and ${infCount} infinite values!`);
      alert(`PCA data validation failed: Found ${nanCount} NaN and ${infCount} infinite values in the data matrix. Please check your parameter selections.`);
      this.prismAPI.progressIndicator.hide();
      return { success: false, zeroVarianceParams: [] };
    }

    // Check data variance
    for (let col = 0; col < parameterNames.length; col++) {
      const values = dataMatrix.map(row => row[col]);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
      const stdDev = Math.sqrt(variance);

      // Find min/max without using spread operator (which causes stack overflow on large arrays)
      let min = values[0];
      let max = values[0];
      for (let i = 1; i < values.length; i++) {
        if (values[i] < min) min = values[i];
        if (values[i] > max) max = values[i];
      }

      if (DEBUG) console.log(`[Graph2D] DEBUG param "${parameterNames[col]}": mean=${mean.toFixed(4)}, std=${stdDev.toFixed(4)}, min=${min.toFixed(4)}, max=${max.toFixed(4)}`);
    }

    // 4. Perform PCA using ml-pca
    this.prismAPI.progressIndicator.setStatus(`Computing PCA for ${dataMatrix.length.toLocaleString()} nodes...`);
    const pcaStart = performance.now();

    // ml-pca expects data in the format: rows = samples, columns = features
    let mlpca;
    try {
      mlpca = new MLPCA(dataMatrix, { center: center, scale: scale });
    } catch (error) {
      // Check if error is due to zero standard deviation (only relevant when scaling is enabled)
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (scale && (errorMsg.includes('standard deviation') || errorMsg.includes('zero') || errorMsg.includes('variance'))) {
        console.error('[Graph2D] ML-PCA scaling failed, likely due to zero standard deviation. Checking parameters...');

        // Calculate standard deviation for each parameter to identify problematic ones
        const problematicParams: string[] = [];
        for (let col = 0; col < parameterNames.length; col++) {
          const values = dataMatrix.map(row => row[col]);
          const mean = values.reduce((a, b) => a + b, 0) / values.length;
          const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
          const stdDev = Math.sqrt(variance);

          if (stdDev < 1e-10) {
            console.warn(`[Graph2D] Parameter "${parameterNames[col]}" has zero standard deviation (all values are constant)`);
            problematicParams.push(parameterNames[col]);
          }
        }

        if (problematicParams.length > 0) {
          console.log(`[Graph2D] Automatically deselecting ${problematicParams.length} zero variance parameters and retrying PCA...`);

          // Filter out problematic parameters from selectedParams
          const filteredParams = selectedParams.filter(param => {
            const fullParamName = `${param.category}::${param.paramName}`;
            return !problematicParams.includes(fullParamName);
          });

          // Check if we still have enough parameters
          if (filteredParams.length < 2) {
            console.error('[Graph2D] Not enough valid parameters left after removing zero variance parameters');
            alert(`Cannot perform PCA: ${problematicParams.length} parameter(s) have zero variance, and removing them leaves fewer than 2 parameters.\n\nZero variance parameters: ${problematicParams.join(', ')}`);
            this.prismAPI.progressIndicator.hide();
            return { success: false, zeroVarianceParams: problematicParams };
          }

          console.log(`[Graph2D] Retrying PCA with ${filteredParams.length} parameters (removed ${problematicParams.length} zero variance parameters)`);

          // Don't clear PCA data again - just rebuild the data matrix with filtered params
          // and continue from here
          this.prismAPI.progressIndicator.setStatus('Rebuilding data matrix with valid parameters...');
          const retryResult = this.buildPCADataMatrix(filteredParams, includeS, includeT);

          if (retryResult.dataMatrix.length === 0) {
            console.warn('[Graph2D] No valid data for PCA after filtering');
            alert('No valid numeric data found for remaining parameters after removing zero variance parameters');
            this.prismAPI.progressIndicator.hide();
            return { success: false, zeroVarianceParams: problematicParams };
          }

          // Update variables with retry data
          dataMatrix = retryResult.dataMatrix;
          nodeIndices = retryResult.nodeIndices;
          parameterNames = retryResult.parameterNames;

          console.log(`[Graph2D] Retry data matrix: ${dataMatrix.length} nodes × ${parameterNames.length} parameters`);

          // Try PCA again with the new data
          this.prismAPI.progressIndicator.setStatus(`Computing PCA for ${dataMatrix.length.toLocaleString()} nodes...`);
          try {
            mlpca = new MLPCA(dataMatrix, { center: center, scale: scale });

            // If successful, continue with the rest of the function (break out of error handling)
            // We'll store the problematic params to return at the end
            // Note: We don't return here, we let the function continue normally
            console.log('[Graph2D] PCA retry succeeded with filtered parameters');
          } catch (retryError) {
            // If it still fails, give up
            const retryErrorMsg = retryError instanceof Error ? retryError.message : String(retryError);
            console.error('[Graph2D] PCA retry failed:', retryErrorMsg);
            alert(`PCA failed even after removing zero variance parameters:\n${retryErrorMsg}`);
            this.prismAPI.progressIndicator.hide();
            return { success: false, zeroVarianceParams: problematicParams };
          }

          // Store problematic params to return at the end
          zeroVarianceParamsToReturn = problematicParams;

          // Continue to the rest of the function with the successful mlpca object
          // Fall through to continue with normal PCA processing
        } else {
          // If no problematic params identified, throw original error
          throw new Error(`Cannot scale dataset: ${errorMsg}`);
        }
      } else {
        // Re-throw if it's a different error
        throw error;
      }
    }

    const pcaEnd = performance.now();
    if (PERFORMANCE) console.log(`[Graph2D] [PERF] ML-PCA computation time: ${(pcaEnd - pcaStart).toFixed(2)} ms`);
    if (PERFORMANCE) console.log(`[Graph2D] [PERF] Time per node: ${((pcaEnd - pcaStart) / dataMatrix.length).toFixed(4)} ms`);
    if (PERFORMANCE) console.log(`[Graph2D] [PERF] Time per parameter: ${((pcaEnd - pcaStart) / parameterNames.length).toFixed(4)} ms`);

    // Get the projected data (predict returns the data in PC space)
    const pcData = mlpca.predict(dataMatrix);

    // Get explained variance
    const explainedVariance = mlpca.getExplainedVariance();
    const cumulativeVariance = mlpca.getCumulativeVariance();
    const eigenvalues = mlpca.getEigenvalues();
    const eigenvectors = mlpca.getEigenvectors();

    if (STATUS) console.log('[Graph2D] ML-PCA eigenvalues:', eigenvalues.slice(0, 3));
    if (STATUS) console.log('[Graph2D] ML-PCA explained variance:', explainedVariance.slice(0, 3));
    if (STATUS) console.log('[Graph2D] ML-PCA cumulative variance:', cumulativeVariance.slice(0, 3));

    // DEBUG: Check eigenvectors structure
    if (DEBUG) console.log('[Graph2D] DEBUG eigenvectors structure:', {
      rows: eigenvectors.rows,
      columns: eigenvectors.columns,
      type: eigenvectors.constructor.name
    });
    if (DEBUG) console.log('[Graph2D] DEBUG eigenvectors column 0 (first 5):', eigenvectors.getColumn(0).slice(0, 5));
    if (DEBUG) console.log('[Graph2D] DEBUG eigenvectors column 1 (first 5):', eigenvectors.getColumn(1).slice(0, 5));
    if (DEBUG) console.log('[Graph2D] DEBUG eigenvectors column 2 (first 5):', eigenvectors.getColumn(2).slice(0, 5));

    // Check for NaN or invalid eigenvalues
    const hasInvalidEigenvalues = eigenvalues.some((ev: number) => isNaN(ev) || !isFinite(ev));
    if (hasInvalidEigenvalues) {
      console.error('[Graph2D] ERROR: Invalid eigenvalues detected:', eigenvalues.slice(0, 3));
      alert('PCA computation failed: Invalid eigenvalues detected. This may be due to insufficient data variance or numerical instability. Try selecting different parameters or disabling scaling.');
      this.prismAPI.progressIndicator.hide();
      return { success: false, zeroVarianceParams: [] };
    }

    // Check for NaN or invalid eigenvectors
    let hasInvalidEigenvectors = false;
    for (let pcIdx = 0; pcIdx < Math.min(3, eigenvectors.columns); pcIdx++) {
      const eigenvector = eigenvectors.getColumn(pcIdx);
      if (eigenvector.some((v: number) => isNaN(v) || !isFinite(v))) {
        console.error(`[Graph2D] ERROR: Invalid eigenvector detected in PC${pcIdx + 1}:`, eigenvector.slice(0, 5));
        hasInvalidEigenvectors = true;
      }
    }
    if (hasInvalidEigenvectors) {
      console.error('[Graph2D] ERROR: Invalid eigenvectors detected');
      alert('PCA computation failed: Invalid eigenvectors detected. This may be due to insufficient data variance or numerical instability. Try selecting different parameters or disabling scaling.');
      this.prismAPI.progressIndicator.hide();
      return { success: false, zeroVarianceParams: [] };
    }

    const totalVariance = cumulativeVariance[Math.min(2, cumulativeVariance.length - 1)] * 100;
    if (STATUS) console.log('[Graph2D] Variance explained by first 3 PCs:', totalVariance.toFixed(2) + '%');

    // Debug: check pcData structure
    if (STATUS) console.log('[Graph2D] ML-PCA pcData structure:', {
      rows: pcData.rows,
      columns: pcData.columns,
      type: pcData.constructor.name,
      firstRow: pcData.rows > 0 ? [pcData.get(0, 0), pcData.get(0, 1), pcData.get(0, 2)] : []
    });

    // Verify we have at least 3 principal components
    if (pcData.columns < 3) {
      console.error('[Graph2D] ML-PCA did not generate enough principal components');
      alert('ML-PCA failed: not enough principal components generated');
      return { success: false, zeroVarianceParams: [] };
    }

    // Extract first 3 PCs for each node
    const pcDataForNodes: number[][] = [];
    let pcDataNaNCount = 0;
    for (let i = 0; i < pcData.rows; i++) {
      const pc1 = pcData.get(i, 0);
      const pc2 = pcData.get(i, 1);
      const pc3 = pcData.get(i, 2);

      // Check for NaN values in PC data
      if (isNaN(pc1) || isNaN(pc2) || isNaN(pc3)) {
        pcDataNaNCount++;
        if (pcDataNaNCount <= 3) {
          console.error(`[Graph2D] ERROR: NaN values in PC data for node ${i}: PC1=${pc1}, PC2=${pc2}, PC3=${pc3}`);
        }
      }

      pcDataForNodes.push([pc1, pc2, pc3]);
    }

    if (pcDataNaNCount > 0) {
      console.error(`[Graph2D] ERROR: ${pcDataNaNCount} nodes have NaN values in their PC coordinates`);
      alert(`PCA computation produced ${pcDataNaNCount} nodes with invalid coordinates. This may be due to numerical instability. Try disabling scaling or selecting different parameters.`);
      this.prismAPI.progressIndicator.hide();
      return { success: false, zeroVarianceParams: [] };
    }

    if (STATUS) console.log('[Graph2D] ML-PCA PC data dimensions:', pcDataForNodes.length, 'x', pcDataForNodes[0]?.length);
    if (STATUS) console.log('[Graph2D] ML-PCA sample PC values (first 3 nodes):', pcDataForNodes.slice(0, 3));

    // Store PCA results for display (format to match pca-js structure)
    this.pcaResults = {
      eigenvectors: [
        { eigenvalue: eigenvalues[0], eigenvector: eigenvectors.getColumn(0) },
        { eigenvalue: eigenvalues[1], eigenvector: eigenvectors.getColumn(1) },
        { eigenvalue: eigenvalues[2], eigenvector: eigenvectors.getColumn(2) }
      ],
      parameterNames: parameterNames,
      varianceExplained: totalVariance
    };

    // 5. Add PC values as parameters to nodes
    this.prismAPI.progressIndicator.setStatus('Adding PC values to nodes...');
    this.addPCParametersToNodes(nodeIndices, pcDataForNodes, includeS, includeT);

    // 6. Apply parameter view with PC1 (x), PC2 (y), PC3 (color)
    this.prismAPI.progressIndicator.setStatus('Applying PCA visualization...');
    this.applyPCAView(includeS, includeT);

    // 7. Update PCA eigenvectors display
    this.updatePCAEigenvectorsDisplay();

    const perfEnd = performance.now();
    const memEnd = (performance as any).memory ? (performance as any).memory.usedJSHeapSize : 0;
    const totalTime = perfEnd - perfStart;
    const memUsed = memEnd - memStart;

    if (PERFORMANCE) console.log('[Graph2D] [PERF] ===== TOTAL PERFORMANCE SUMMARY (ml-pca) =====');
    if (PERFORMANCE) console.log(`[Graph2D] [PERF] Total execution time: ${totalTime.toFixed(2)} ms`);
    if (PERFORMANCE) console.log(`[Graph2D] [PERF] Nodes: ${dataMatrix.length}`)
    if (PERFORMANCE) console.log(`[Graph2D] [PERF] Total time per node: ${(totalTime / dataMatrix.length).toFixed(4)} ms`);
    if (PERFORMANCE) console.log(`[Graph2D] [PERF] Total time per parameter: ${(totalTime / parameterNames.length).toFixed(4)} ms`);
    if (memUsed > 0) {
      if (PERFORMANCE) console.log(`[Graph2D] [PERF] Memory delta: ${(memUsed / 1024 / 1024).toFixed(2)} MB`);
      if (PERFORMANCE) console.log(`[Graph2D] [PERF] Memory per node: ${(memUsed / dataMatrix.length).toFixed(2)} bytes`);
    }
    if (PERFORMANCE) console.log('[Graph2D] [PERF] ================================================');
    if (STATUS) console.log('[Graph2D] ML-PCA complete');

    return { success: true, zeroVarianceParams: zeroVarianceParamsToReturn };
  }

  /**
   * Clear existing PCA data from all nodes and metadata
   */
  private clearPCAData(): void {
    // Clear PCA parameters from nodes
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (node.parameters['PCA']) {
        delete node.parameters['PCA'];
      }
    }

    // Clear PCA parameters from metadata
    const metadata = this.prismAPI.getParameterMetadata();
    if (metadata) {
      if (metadata.s && metadata.s['PCA']) {
        delete metadata.s['PCA'];
        if (STATUS) console.log('[Graph2D] Cleared PCA from S node metadata');
      }
      if (metadata.t && metadata.t['PCA']) {
        delete metadata.t['PCA'];
        if (STATUS) console.log('[Graph2D] Cleared PCA from T node metadata');
      }
    }

    if (STATUS) console.log('[Graph2D] Cleared existing PCA data from nodes and metadata');
  }

  /**
   * Convert a parameter value to a number, handling booleans, strings, and numbers
   * Returns NaN if the value cannot be converted to a valid number
   */
  private convertParameterValueToNumber(value: any): number {
    if (value === null || value === undefined) {
      return NaN;
    }

    // Handle boolean values
    if (typeof value === 'boolean') {
      return value ? 1 : 0;
    }

    // Handle numeric values
    if (typeof value === 'number') {
      return value;
    }

    // Handle string values
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      return parsed;
    }

    // Unknown type
    return NaN;
  }

  /**
   * Check if a node should be visible based on parameter values and node type
   * Returns true if the node has valid parameter values and the parameter applies to this node type
   */
  private isNodeVisibleForParameters(node: NodeData, xParam: string, yParam: string): boolean {
    // Get parameter values
    const xVal = PrismAPI.getParameterValue(node, xParam);
    const yVal = PrismAPI.getParameterValue(node, yParam);

    // Convert to numbers
    const xNum = this.convertParameterValueToNumber(xVal);
    const yNum = this.convertParameterValueToNumber(yVal);

    // Must have valid numeric values for both parameters
    if (isNaN(xNum) || isNaN(yNum) || !isFinite(xNum) || !isFinite(yNum)) {
      return false;
    }

    // Check if parameters apply to this node type
    const xParamTypes = this.prismAPI.getParameterNodeTypes(xParam);
    const yParamTypes = this.prismAPI.getParameterNodeTypes(yParam);

    // ROBUST FIX: If parameter type info is missing from metadata, but the node HAS the parameter
    // with valid values, then assume it's applicable (this handles dynamically added parameters like PCA)
    if (!xParamTypes || !yParamTypes) {
      // If we got valid numeric values, the parameter exists on this node
      // This is especially important for dynamically computed parameters like PCA
      if (DEBUG && (!xParamTypes || !yParamTypes)) {
        console.log(`[Graph2D] Parameter type info missing for node ${node.id} (type=${node.type}): xParam="${xParam}" (${xParamTypes}), yParam="${yParam}" (${yParamTypes}). Accepting based on valid values.`);
      }
      return true; // If we have valid values, assume the parameter applies
    }

    // Check if node type matches both parameters
    const xTypes = new Set(xParamTypes.split('') as Array<'s' | 't'>);
    const yTypes = new Set(yParamTypes.split('') as Array<'s' | 't'>);

    return xTypes.has(node.type) && yTypes.has(node.type);
  }

  /**
   * Build data matrix for PCA from selected parameters
   */
  private buildPCADataMatrix(
    selectedParams: Array<{category: string, paramName: string, nodeTypes: Set<'s' | 't'>}>,
    includeS: boolean,
    includeT: boolean
  ): { dataMatrix: number[][], nodeIndices: number[], parameterNames: string[] } {
    const dataMatrix: number[][] = [];
    const nodeIndices: number[] = [];
    const parameterNames: string[] = selectedParams.map(p => `${p.category}::${p.paramName}`);

    if (STATUS) console.log(`[Graph2D] buildPCADataMatrix: Processing ${this.nodes.length} nodes`);
    if (STATUS) console.log(`[Graph2D] buildPCADataMatrix: includeS=${includeS}, includeT=${includeT}`);
    if (STATUS) console.log(`[Graph2D] buildPCADataMatrix: selectedParams=`, selectedParams);

    // Count node types
    const sCount = this.nodes.filter(n => n.type === 's').length;
    const tCount = this.nodes.filter(n => n.type === 't').length;
    if (STATUS) console.log(`[Graph2D] buildPCADataMatrix: Node type distribution: s=${sCount}, t=${tCount}`);

    // Log which node types each parameter applies to
    for (const param of selectedParams) {
      const nodeTypesArray = Array.from(param.nodeTypes);
      if (STATUS) console.log(`[Graph2D] buildPCADataMatrix: Param "${param.paramName}" applies to node types:`, nodeTypesArray);
    }

    let skippedByType = 0;
    let skippedByParamType = 0;
    let skippedByMissingValue = 0;
    let skippedByInfinite = 0;

    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];

      // Skip node if its type is not selected
      if (node.type === 's' && !includeS) {
        skippedByType++;
        continue;
      }
      if (node.type === 't' && !includeT) {
        skippedByType++;
        continue;
      }

      // Check if node has all selected parameters for its type
      const rowData: number[] = [];
      let validRow = true;
      let skipReason = '';

      for (const param of selectedParams) {
        // Check if this parameter applies to this node type
        if (!param.nodeTypes.has(node.type)) {
          validRow = false;
          skipReason = `param ${param.paramName} not applicable to node type ${node.type}`;
          skippedByParamType++;
          break;
        }

        // Get parameter value using category::paramName format
        const value = PrismAPI.getParameterValue(node, `${param.category}::${param.paramName}`);

        // Handle boolean values: true -> 1, false -> 0
        let numValue: number;
        if (typeof value === 'boolean') {
          numValue = value ? 1 : 0;
        } else {
          numValue = parseFloat(value);
        }

        // Check for NaN values
        if (isNaN(numValue)) {
          validRow = false;
          skipReason = `param ${param.paramName} has invalid value: ${value} (type: ${typeof value})`;
          skippedByMissingValue++;
          break;
        }

        // Check for infinite values
        if (!isFinite(numValue)) {
          validRow = false;
          skipReason = `param ${param.paramName} has infinite value: ${numValue}`;
          skippedByInfinite++;
          break;
        }

        rowData.push(numValue);
      }

      if (validRow && rowData.length === selectedParams.length) {
        dataMatrix.push(rowData);
        nodeIndices.push(i);
        if (STATUS && dataMatrix.length <= 3) {
          console.log(`[Graph2D] Added node ${i} (type=${node.type}) to matrix. Row data:`, rowData);
        }
      } else if (i < 10) {
        // Log first 10 skipped nodes for debugging
        if (STATUS) console.log(`[Graph2D] Skipped node ${i} (type=${node.type}): ${skipReason}`);
      }
    }

    if (STATUS) console.log(`[Graph2D] buildPCADataMatrix: Result: ${dataMatrix.length} valid nodes`);
    if (STATUS) console.log(`[Graph2D] buildPCADataMatrix: Skipped by type: ${skippedByType}`);
    if (STATUS) console.log(`[Graph2D] buildPCADataMatrix: Skipped by param type: ${skippedByParamType}`);
    if (STATUS) console.log(`[Graph2D] buildPCADataMatrix: Skipped by missing/invalid value: ${skippedByMissingValue}`);
    if (STATUS) console.log(`[Graph2D] buildPCADataMatrix: Skipped by infinite value: ${skippedByInfinite}`);

    // Warn if many nodes were skipped due to infinite values
    if (skippedByInfinite > 0) {
      console.warn(`[Graph2D] Warning: ${skippedByInfinite} nodes were excluded from PCA due to infinite parameter values. Consider filtering or transforming these parameters.`);
    }

    return { dataMatrix, nodeIndices, parameterNames };
  }

  /**
   * Add principal component values as parameters to nodes
   * @param nodeIndices Indices of nodes included in PCA
   * @param pcData PCA values for included nodes
   * @param includeS Whether S nodes were included in PCA
   * @param includeT Whether T nodes were included in PCA
   */
  private addPCParametersToNodes(nodeIndices: number[], pcData: number[][], includeS: boolean, includeT: boolean): void {
    if (!pcData || pcData.length === 0) {
      console.error('[Graph2D] pcData is empty or undefined');
      throw new Error('PCA data is empty');
    }

    if (STATUS) console.log(`[Graph2D] Adding PC parameters to ${nodeIndices.length} nodes (includeS=${includeS}, includeT=${includeT})`);
    if (STATUS) console.log(`[Graph2D] pcData length: ${pcData.length}, dimensions: ${pcData.length} x ${pcData[0]?.length}`);

    // First, add PCA parameters to nodes that were included in PCA
    for (let i = 0; i < nodeIndices.length; i++) {
      const nodeIdx = nodeIndices[i];
      const node = this.nodes[nodeIdx];

      if (!pcData[i]) {
        console.error(`[Graph2D] pcData[${i}] is undefined. pcData length: ${pcData.length}, nodeIndices length: ${nodeIndices.length}`);
        throw new Error(`PCA data missing for node index ${i}`);
      }

      // Only add PCA parameters to nodes whose type was selected
      const shouldAddToNode = (node.type === 's' && includeS) || (node.type === 't' && includeT);
      if (!shouldAddToNode) {
        console.warn(`[Graph2D] Skipping node ${nodeIdx} (type=${node.type}) - not included in selected types`);
        continue;
      }

      // Create PCA category if it doesn't exist
      if (!node.parameters['PCA']) {
        node.parameters['PCA'] = {};
      }

      // Add PC1, PC2, PC3 values
      // pcData[i] is an array: [PC1, PC2, PC3, ...]
      node.parameters['PCA']['PC1'] = pcData[i][0] ?? 0;
      node.parameters['PCA']['PC2'] = pcData[i][1] ?? 0;
      node.parameters['PCA']['PC3'] = pcData[i][2] ?? 0;

      // Log first few nodes for debugging
      if (i < 3) {
        if (STATUS) console.log(`[Graph2D] Node ${nodeIdx} (${node.id}, type=${node.type}): PC1=${node.parameters['PCA']['PC1']}, PC2=${node.parameters['PCA']['PC2']}, PC3=${node.parameters['PCA']['PC3']}`);
      }
    }

    if (STATUS) console.log(`[Graph2D] Added PC1, PC2, PC3 parameters to nodes`);
  }

  /**
   * Apply parameter view with PC1 (x-axis), PC2 (y-axis), PC3 (color)
   * @param includeS Whether S nodes were included in PCA
   * @param includeT Whether T nodes were included in PCA
   */
  private applyPCAView(includeS: boolean, includeT: boolean): void {
    if (STATUS) console.log(`[Graph2D] Applying PCA view (includeS=${includeS}, includeT=${includeT})...`);

    // Check a few nodes to verify PCA data was added
    for (let i = 0; i < Math.min(3, this.nodes.length); i++) {
      const node = this.nodes[i];
      if (node.parameters['PCA']) {
        if (STATUS) console.log(`[Graph2D] Sample node ${i} (${node.id}, type=${node.type}) PCA values:`, node.parameters['PCA']);
      }
    }

    // Update parameter metadata to include PCA parameters
    // Only add to node types that were selected for PCA
    const metadata = this.prismAPI.getParameterMetadata();
    if (metadata) {
      const pcaParamDef = {
        PC1: { type: 'number' as const, status: 'active', min: 0, max: 1 },
        PC2: { type: 'number' as const, status: 'active', min: 0, max: 1 },
        PC3: { type: 'number' as const, status: 'active', min: 0, max: 1 }
      };

      // Add PCA category to S nodes if they were included
      if (includeS) {
        if (!metadata.s) metadata.s = {};
        if (!metadata.s['PCA']) {
          metadata.s['PCA'] = pcaParamDef;
          if (STATUS) console.log('[Graph2D] Added PCA parameters to S node metadata');
        }
      }

      // Add PCA category to T nodes if they were included
      if (includeT) {
        if (!metadata.t) metadata.t = {};
        if (!metadata.t['PCA']) {
          metadata.t['PCA'] = pcaParamDef;
          if (STATUS) console.log('[Graph2D] Added PCA parameters to T node metadata');
        }
      }
    }

    // Recalculate parameter min/max to include PCA parameters
    const allNodes = this.nodes;
    this.prismAPI.recalculateParameterMinMax(allNodes);

    // Verify that PCA parameters are now in metadata
    if (STATUS) {
      const pcaTypes = this.prismAPI.getParameterNodeTypes('PCA::PC1');
      console.log(`[Graph2D] After metadata update, PCA::PC1 node types: ${pcaTypes}`);
    }

    // Update UI dropdowns with new PCA parameters and select them
    // Get all parameter labels from both s and t node types
    const paramLabels = this.prismAPI.getAllParameterLabels();
    this.ui.updateParameterSelections(paramLabels, {
      x: 'PCA::PC1',
      y: 'PCA::PC2',
      color: 'PCA::PC3'
    });

    // Apply parameter view with PC1 (x), PC2 (y), PC3 (color)
    this.rearrangeByParameters('PCA::PC1', 'PCA::PC2', 'PCA::PC3');

    if (STATUS) console.log('[Graph2D] Applied PCA view (PC1=X, PC2=Y, PC3=Color)');
  }


  public filterNodes(filterFn: (node: NodeData) => boolean): void{
    const alphas = this.pointCloud?.geometry.getAttribute('alpha') as THREE.BufferAttribute;

    if (!alphas) return;

    // Store the filter function for overlap label counting
    this.currentFilterFn = filterFn;

    // Show progress indicator for large datasets
    const showProgress = this.geometryToNodesMap.size > 1000;
    if (showProgress) {
      this.prismAPI.progressIndicator.show({ title: 'Filtering nodes' });
      this.prismAPI.progressIndicator.setIndeterminate('Applying filter...');
    }

    let geometryPointsHidden = 0;
    let geometryPointsVisible = 0;
    let nodesHidden = 0;
    let nodesVisible = 0;

    // Iterate over geometry points (stacks), not individual nodes
    for (const [geometryIndex, nodeIndices] of this.geometryToNodesMap.entries()) {
      if (nodeIndices.length === 0) continue;

      // Check all nodes in this stack
      let allHidden = true;
      let hiddenCount = 0;
      const debugNodeIds: (number | string)[] = [264, 266, 288, 422, 244, 246, 382, 328];
      let shouldDebugStack = false;

      for (const nodeIndex of nodeIndices) {
        const node = this.nodes[nodeIndex];
        const shouldHide = filterFn(node);

        if (debugNodeIds.includes(node.id)) {
          shouldDebugStack = true;
        }

        if (shouldHide) {
          hiddenCount++;
        } else {
          allHidden = false;
        }
      }

      if (shouldDebugStack) {
        console.log(`[Filter Stack Debug] Geometry ${geometryIndex} has ${nodeIndices.length} nodes:`);
        for (const nodeIndex of nodeIndices) {
          const node = this.nodes[nodeIndex];
          const shouldHide = filterFn(node);
          const prMaxEqual1 = node.parameters?.['Model Checking Results']?.['PrMax_equal_1'];
          console.log(`  Node ${node.id} (type=${node.type}): PrMax_equal_1=${prMaxEqual1}, shouldHide=${shouldHide}`);
        }
        console.log(`  -> Stack decision: ${allHidden ? 'HIDE' : 'SHOW'} (${hiddenCount}/${nodeIndices.length} should be hidden)`);
      }

      // Only hide the geometry point if ALL nodes in the stack should be hidden
      if (allHidden) {
        alphas.setX(geometryIndex, 0.0);
        geometryPointsHidden++;
        nodesHidden += hiddenCount;
      } else {
        alphas.setX(geometryIndex, 1.0);
        geometryPointsVisible++;
        // All nodes in this visible stack are counted as visible
        // (even if some match the filter criteria, they're still rendered)
        nodesVisible += nodeIndices.length;
      }
    }

    alphas.needsUpdate = true;

    // Update visible node counter
    this.updateVisibleNodeCounter(nodesVisible);

    if (STATUS) console.log(`[Filter Nodes] Visible: ${nodesVisible} nodes in ${geometryPointsVisible} geometry points`);
    if (STATUS) console.log(`[Filter Nodes] Hidden: ${nodesHidden} nodes in ${geometryPointsHidden} fully-hidden geometry points`);

    this.renderer?.render(this.scene, this.camera);

    // Update overlap labels to reflect filtered counts
    this.updateOverlapLabels();

    if (showProgress) {
      this.prismAPI.progressIndicator.hide();
    }
  }


  public async generateNodes(count: number): Promise<void> {
    this.ui.updateStatus(`Generating ${count.toLocaleString()} nodes in 2D...`);
    this.ui.disableButtons();

    try {
      // Clear existing nodes and edges
      this.clearPointCloud();
      this.clearEdgeLines();
      this.nodes = [];
      this.edges = [];

      // Reset parameter centers for new random distribution
      this.parameterCenters = null;

      // Create geometry arrays
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      const sizes = new Float32Array(count);

      // Generate random edges first
      this.generateRandomEdges(count);
      if (STATUS) console.log(`[Generate Nodes] Created ${this.edges.length} random edges for ${count} nodes`);
      
      // Generate layout based on connectivity
      await this.generateLayout(count, positions, colors, sizes);

      // Create edge lines if edges are visible
      // Note: edges default to hidden for better performance
      if (this.config.edgesVisible) {
        this.createEdgeLines();
      } else {
        if (STATUS) console.log(`[Generate Nodes] ${this.edges.length} edges created but hidden (use Toggle Edges to show)`);
      }

      // Create point cloud
      await this.createPointCloud(geometry, positions, colors, sizes);

      // Update state
      this.nodeCount = count;
      this.ui.updateNodeCount(count);
      this.updateVisibleNodeCounter(count);
      this.resetView();

      // Apply default type-based coloring
      this.applyColorParameter('__type__');

      this.ui.updateStatus(`${count.toLocaleString()} 2D nodes ready`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate nodes';
      this.ui.showError(message);
    } finally {
      this.ui.enableButtons();
    }
  }


  public async loadGraph(graphId: string = '0', filteredNodes?: NodeData[], filteredEdges?: EdgeData[]): Promise<void> {
    const startTime = performance.now();
    this.ui.updateStatus('Fetching graph data from API...');
    this.ui.disableButtons();

    try {
      // Clear existing state when switching projects
      this.clearPointCloud();
      this.clearEdgeLines();
      this.clearSelection(); // Clear selected nodes
      this.nodes = [];
      this.edges = [];
      if (!filteredNodes || !filteredEdges) {
        // Fetch graph data using PrismAPI
        const fetchStart = performance.now();
        const graphData = await this.prismAPI.fetchSimpleGraph(graphId);
        //if (PERFORMANCE) console.log(`[Performance] API fetch: ${(performance.now() - fetchStart).toFixed(2)}ms`);
        this.nodes = graphData.nodes;
        this.edges = graphData.edges;
        // REMOVED: fullNodes/fullEdges assignments (memory optimization)
      } else {
        this.nodes = filteredNodes;
        this.edges = filteredEdges;

      }


      const nodeCount = this.nodes.length;

      // Create geometry arrays
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(nodeCount * 3);
      const colors = new Float32Array(nodeCount * 3);
      const sizes = new Float32Array(nodeCount);

      // Populate geometry arrays directly from loaded nodes (no recreation)
      const layoutStart = performance.now();
      await this.populateGeometryFromNodes(positions, colors, sizes);
      //if (PERFORMANCE) console.log(`[Performance] Layout population: ${(performance.now() - layoutStart).toFixed(2)}ms`);

      // Create point cloud first for visual feedback
      const cloudStart = performance.now();
      await this.createPointCloud(geometry, positions, colors, sizes);
      this.nodeCount = nodeCount;
      this.ui.updateNodeCount(nodeCount);
      this.resetView();
      if (PERFORMANCE) console.log(`[Performance] Point cloud creation: ${(performance.now() - cloudStart).toFixed(2)}ms`);

      // Update UI with basic info
      const paramLabels = this.prismAPI.getAllParameterLabels();
      this.ui.updateParameterSelections(paramLabels);
      this.ui.updateModelInfo(graphId, nodeCount, this.edges.length);
      this.config.parameterXAxis = "";
      this.config.parameterYAxis = "";

      // Apply default type-based coloring
      this.applyColorParameter('__type__');


      // Create edge lines if edges are visible (deferred rendering for large graphs)
      if (this.config.edgesVisible && this.edges.length > 0) {
        const edgeStart = performance.now();

        if (this.edges.length > 10000) {
          // For large graphs, defer edge rendering
          this.ui.updateStatus(`Loaded ${nodeCount.toLocaleString()} nodes, rendering ${this.edges.length.toLocaleString()} edges...`);
          await new Promise(resolve => setTimeout(resolve, 16)); // Let browser render nodes first
        }

        this.createEdgeLines();
        this.updateArrowScales();
        if (PERFORMANCE) console.log(`[Performance] Edge rendering: ${(performance.now() - edgeStart).toFixed(2)}ms`);
      }

      // Update overlap labels (deferred for very large graphs)
      if (nodeCount < 500000) {
        this.updateOverlapLabels();
      } else {
        // Defer overlap calculation for very large graphs
        setTimeout(() => this.updateOverlapLabels(), 100);
      }

      const totalTime = (performance.now() - startTime).toFixed(2);
      //if (PERFORMANCE) console.log(`[Performance] Total load time: ${totalTime}ms`);
      if (PERFORMANCE) console.log(`Loaded ${nodeCount.toLocaleString()} nodes and ${this.edges.length.toLocaleString()} edges from API (${totalTime}ms)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load graph from API';
      this.ui.showError(message);
      this.ui.clearModelInfo();
      throw error; // Re-throw to allow fallback in main.ts
    } finally {
      this.ui.enableButtons();
    }
  }

  /**
   * Load graph data without rendering - waits for user to select a layout
   */
  public async loadGraphData(graphId: string = '0'): Promise<void> {
    const startTime = performance.now();
    this.ui.updateStatus('Fetching graph data from API...');
    this.ui.disableButtons();

    try {
      // Clear existing state when switching projects
      this.clearGraphCanvas();

      // Fetch graph data using PrismAPI
      const fetchStart = performance.now();
      const graphData = await this.prismAPI.fetchSimpleGraph(graphId);
      if (PERFORMANCE) console.log(`[Performance] API fetch: ${(performance.now() - fetchStart).toFixed(2)}ms`);

      // Store the data but don't render yet
      this.nodes = graphData.nodes;
      this.edges = graphData.edges;
      // REMOVED: fullNodes/fullEdges assignments (memory optimization)
      this.loadedProjectId = graphId;
      this.nodeCount = this.nodes.length;

      // Update UI with basic info
      const paramLabels = this.prismAPI.getAllParameterLabels();
      this.ui.updateParameterSelections(paramLabels);
      this.ui.updateModelInfo(graphId, this.nodes.length, this.edges.length);
      this.config.parameterXAxis = "";
      this.config.parameterYAxis = "";

      const totalTime = (performance.now() - startTime).toFixed(2);
      this.ui.updateStatus(`Loaded ${this.nodes.length.toLocaleString()} nodes and ${this.edges.length.toLocaleString()} edges from API (${totalTime}ms). Select a layout to visualize.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load graph from API';
      this.ui.showError(message);
      this.ui.clearModelInfo();
      throw error;
    } finally {
      this.ui.enableButtons();
    }
  }

  /**
   * Load graph data from memory (e.g., uploaded JSON) without rendering
   */
  public async loadGraphDataFromMemory(nodes: NodeData[], edges: EdgeData[], projectName: string): Promise<void> {
    const startTime = performance.now();
    this.ui.disableButtons();

    try {
      // Clear existing state when switching projects
      this.clearGraphCanvas();

      // Store the data but don't render yet
      this.nodes = nodes;
      this.edges = edges;
      // REMOVED: fullNodes/fullEdges assignments (memory optimization)
      this.loadedProjectId = projectName;
      this.nodeCount = this.nodes.length;

      // Update UI with basic info
      const paramLabels = this.prismAPI.getAllParameterLabels();
      this.ui.updateParameterSelections(paramLabels);
      this.ui.updateModelInfo(projectName, this.nodes.length, this.edges.length);
      this.config.parameterXAxis = "";
      this.config.parameterYAxis = "";

      const totalTime = (performance.now() - startTime).toFixed(2);
      this.ui.updateStatus(`Loaded ${this.nodes.length.toLocaleString()} nodes and ${this.edges.length.toLocaleString()} edges (${totalTime}ms). Select a layout to visualize.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load graph data';
      this.ui.showError(message);
      this.ui.clearModelInfo();
      throw error;
    } finally {
      this.ui.enableButtons();
    }
  }

  /**
   * Render data that was loaded via loadGraphData (triggered by layout selection)
   */
  private async renderLoadedData(): Promise<void> {
    if (this.nodes.length === 0) {
      this.ui.updateStatus("No data to render!");
      return;
    }

    const startTime = performance.now();
    const perfTimes = { layout: 0, stack: 0, display: 0 }; // Track all performance timings
    this.ui.disableButtons();

    try {
      // CRITICAL: Dispose old geometry before creating new one to prevent memory leaks
      if (this.pointCloud) {
        if (this.pointCloud.geometry) {
          this.pointCloud.geometry.dispose();
        }
        if (this.pointCloud.material instanceof THREE.Material) {
          this.pointCloud.material.dispose();
        }
        this.scene.remove(this.pointCloud);
        this.pointCloud = null;
      }

      // Clear edge lines as well
      this.clearEdgeLines();

      const nodeCount = this.nodes.length;

      // Create geometry arrays
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(nodeCount * 3);
      const colors = new Float32Array(nodeCount * 3);
      const sizes = new Float32Array(nodeCount);

      // Populate geometry arrays from loaded nodes
      const layoutStart = performance.now();
      await this.populateGeometryFromNodes(positions, colors, sizes);
      perfTimes.layout = performance.now() - layoutStart;
      if (PERFORMANCE) console.log(`[Performance] Layout population: ${perfTimes.layout.toFixed(2)}ms`);

      // Create point cloud
      const cloudStart = performance.now();
      await this.createPointCloud(geometry, positions, colors, sizes);
      perfTimes.stack = this.lastStackGenTime || 0; // Stack time captured in deduplicateStackedNodes
      perfTimes.display = performance.now() - cloudStart - perfTimes.stack;
      if (PERFORMANCE) console.log(`[Performance] Point cloud creation: ${(performance.now() - cloudStart).toFixed(2)}ms`);
      this.ui.updateNodeCount(nodeCount);

      // If using parameter positioning, set alpha values for visibility
      if (this.config.useParameterPositioning && this.config.parameterXAxis && this.config.parameterYAxis) {
        const xParam = this.config.parameterXAxis;
        const yParam = this.config.parameterYAxis;
        // pointCloud is created by createPointCloud above, safe to access here
        const alphas = this.pointCloud!.geometry.getAttribute('alpha') as THREE.BufferAttribute;

        if (alphas) {
          let visibleCount = 0;
          // Set alpha based on node visibility for each geometry point
          for (const [geometryIndex, nodeIndices] of this.geometryToNodesMap.entries()) {
            let hasVisibleNode = false;

            for (const nodeIndex of nodeIndices) {
              const node = this.nodes[nodeIndex];
              if (this.isNodeVisibleForParameters(node, xParam, yParam)) {
                hasVisibleNode = true;
                visibleCount++;
              }
            }

            alphas.setX(geometryIndex, hasVisibleNode ? 1.0 : 0.0);
          }

          alphas.needsUpdate = true;
          this.updateVisibleNodeCounter(visibleCount);
          if (DEBUG) console.log(`[renderLoadedData] Set visibility: ${visibleCount} visible nodes`);
        }
      } else {
        this.updateVisibleNodeCounter(nodeCount);
      }

      this.resetView();
      if (PERFORMANCE) console.log(`[Performance] Point cloud creation: ${(performance.now() - cloudStart).toFixed(2)}ms`);

      // Create edge lines if edges are visible
      if (this.config.edgesVisible && this.edges.length > 0) {
        const edgeStart = performance.now();

        if (this.edges.length > 10000) {
          this.ui.updateStatus(`Rendering ${this.edges.length.toLocaleString()} edges...`);
          await new Promise(resolve => setTimeout(resolve, 16));
        }

        this.createEdgeLines();
        this.updateArrowScales();
        if (PERFORMANCE) console.log(`[Performance] Edge rendering: ${(performance.now() - edgeStart).toFixed(2)}ms`);
      }

      // Apply color parameter (use configured color if set, otherwise default to type)
      const colorParam = this.config.parameterColorAxis || '__type__';
      this.applyColorParameter(colorParam);

      // Update overlap labels
      if (nodeCount < 500000) {
        this.updateOverlapLabels();
      } else {
        setTimeout(() => this.updateOverlapLabels(), 100);
      }

      // Create axis visualization if using parameter positioning
      if (this.config.useParameterPositioning && this.config.parameterXAxis && this.config.parameterYAxis) {
        const xParam = this.config.parameterXAxis;
        const yParam = this.config.parameterYAxis;

        // Use cached min/max values from PrismAPI (calculated during data loading)
        const xRange = this.prismAPI.getParameterMinMax(xParam);
        const yRange = this.prismAPI.getParameterMinMax(yParam);

        let minX = 0, maxX = 100;
        let minY = 0, maxY = 100;

        // Use cached values if available, otherwise fall back to calculating
        if (xRange) {
          minX = xRange.min;
          maxX = xRange.max;
        } else {
          // Fallback: calculate from nodes (shouldn't happen for API-loaded data)
          minX = Infinity; maxX = -Infinity;
          for (let i = 0; i < this.nodes.length; i++) {
            const val = PrismAPI.getParameterValue(this.nodes[i], xParam);
            minX = Math.min(minX, val);
            maxX = Math.max(maxX, val);
          }
        }

        if (yRange) {
          minY = yRange.min;
          maxY = yRange.max;
        } else {
          // Fallback: calculate from nodes (shouldn't happen for API-loaded data)
          minY = Infinity; maxY = -Infinity;
          for (let i = 0; i < this.nodes.length; i++) {
            const val = PrismAPI.getParameterValue(this.nodes[i], yParam);
            minY = Math.min(minY, val);
            maxY = Math.max(maxY, val);
          }
        }

        const spread = Math.sqrt(nodeCount) * 0.5;
        this.createAxisVisualization(xParam, yParam, { x: minX, y: minY }, { x: maxX, y: maxY }, spread);
        this.fitViewToParameterRange(spread);
      }

      const totalTime = performance.now() - startTime;

      // Display comprehensive performance summary
      if (PERFORMANCE) {
        console.log(`[NodePlacement] [PERF] ===== RENDERING SUMMARY =====`);
        console.log(`[NodePlacement] [PERF] Node count: ${nodeCount.toLocaleString()}`);
        console.log(`[NodePlacement] [PERF] Total time: ${totalTime.toFixed(2)}ms`);
        console.log(`[NodePlacement] [PERF] Breakdown:`);
        console.log(`[NodePlacement] [PERF]   - Layout generation: ${perfTimes.layout.toFixed(2)}ms (${((perfTimes.layout / totalTime) * 100).toFixed(1)}%)`);
        console.log(`[NodePlacement] [PERF]   - Stack generation: ${perfTimes.stack.toFixed(2)}ms (${((perfTimes.stack / totalTime) * 100).toFixed(1)}%)`);
        console.log(`[NodePlacement] [PERF]   - Node display: ${perfTimes.display.toFixed(2)}ms (${((perfTimes.display / totalTime) * 100).toFixed(1)}%)`);
        console.log(`[NodePlacement] [PERF] Time per node: ${((totalTime / nodeCount) * 1000).toFixed(2)}µs`);

        // Memory stats (Chrome-specific API)
        const perfWithMemory = performance as any;
        if (perfWithMemory.memory) {
          const memUsed = perfWithMemory.memory.usedJSHeapSize / (1024 * 1024);
          console.log(`[NodePlacement] [PERF] Memory used: ${memUsed.toFixed(2)}MB`);
        }

        console.log(`[NodePlacement] [PERF] ======================================`);
      }

      this.ui.updateStatus(`Rendered ${nodeCount.toLocaleString()} nodes with ${this.currentLayout} layout (${totalTime.toFixed(0)}ms)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to render graph';
      this.ui.showError(message);
      throw error;
    } finally {
      this.ui.enableButtons();
    }
  }

  /**
   * ============================================================================
   * COMPLETE REWRITE: Node Placement System
   * ============================================================================
   *
   * This method orchestrates the complete process of placing nodes in the
   * coordinate system and preparing them for rendering.
   *
   * Process:
   * 1. Determine coordinate system bounds (parameter-based or layout-based)
   * 2. Position each node in the coordinate system
   * 3. Apply optional force-directed layout
   * 4. Generate visual attributes (colors, sizes)
   *
   * Note: Stack generation happens later in deduplicateStackedNodes()
   */
  private async populateGeometryFromNodes(
    positions: Float32Array,
    colors: Float32Array,
    sizes: Float32Array
  ): Promise<void> {
    const perfStart = performance.now();
    const memStart = (performance as any).memory ? (performance as any).memory.usedJSHeapSize : 0;

    const count = this.nodes.length;
    const spread = Math.sqrt(count) * 0.5;

    console.log(`[NodePlacement] Starting layout generation for ${count.toLocaleString()} nodes`);

    // Show progress indicator for large datasets
    const showProgress = count > 10000;
    if (showProgress) {
      this.prismAPI.progressIndicator.show({ title: 'Generating Layout' });
    }

    // ============================================================
    // STEP 1: Determine Coordinate System Bounds
    // ============================================================
    if (showProgress) this.prismAPI.progressIndicator.setStatus('Determining coordinate system...');
    const coordStart = performance.now();
    const coordinateSystem = this.determineCoordinateSystem(count, spread);
    const coordTime = performance.now() - coordStart;
    if (PERFORMANCE && coordTime > 10) console.log(`[NodePlacement] [PERF] Coordinate system: ${coordTime.toFixed(2)}ms`);

    // Store for later use (e.g., axis rendering)
    this.currentAxisInfo = coordinateSystem;

    // ============================================================
    // STEP 2: Position All Nodes AND Generate Stack Map
    // ============================================================
    if (showProgress) this.prismAPI.progressIndicator.setStatus('Positioning nodes...');
    const posStart = performance.now();
    const stackMap = await this.positionNodesInCoordinateSystem(
      positions,
      count,
      spread,
      coordinateSystem,
      showProgress
    );
    const posTime = performance.now() - posStart;
    if (PERFORMANCE) console.log(`[NodePlacement] [PERF] Node positioning + stack grouping: ${posTime.toFixed(2)}ms (${(posTime / count * 1000).toFixed(2)}µs per node)`);

    // ============================================================
    // STEP 3: Apply Force-Directed Layout (Optional)
    // ============================================================
    let forceTime = 0;
    if (this.currentLayout === 'force' && count > 0) {
      if (showProgress) this.prismAPI.progressIndicator.setStatus('Computing force-directed layout...');
      this.ui.updateStatus('Computing force-directed layout...');
      const forceStart = performance.now();
      this.applyForceDirectedLayout(count, positions, spread);
      forceTime = performance.now() - forceStart;
      if (PERFORMANCE) console.log(`[NodePlacement] [PERF] Force-directed layout: ${forceTime.toFixed(2)}ms`);
    }

    // ============================================================
    // STEP 4: Generate Visual Attributes
    // ============================================================
    if (showProgress) this.prismAPI.progressIndicator.setStatus('Generating visual attributes...');
    const attrStart = performance.now();
    this.generateNodeVisualAttributes(colors, sizes, count);
    const attrTime = performance.now() - attrStart;
    if (PERFORMANCE) console.log(`[NodePlacement] [PERF] Visual attributes: ${attrTime.toFixed(2)}ms`);

    // ============================================================
    // STEP 5: Store Stack Map for Later Use
    // ============================================================
    // Store the stack map so createPointCloud can use it instead of recomputing
    this.cachedStackMap = stackMap;

    // Hide progress indicator
    if (showProgress) {
      this.prismAPI.progressIndicator.hide();
    }

    // ============================================================
    // PERFORMANCE SUMMARY
    // ============================================================
    const perfEnd = performance.now();
    const memEnd = (performance as any).memory ? (performance as any).memory.usedJSHeapSize : 0;
    const totalTime = perfEnd - perfStart;
    const memUsed = memEnd - memStart;

    console.log(`[NodePlacement] [PERF] ===== LAYOUT GENERATION SUMMARY =====`);
    console.log(`[NodePlacement] [PERF] Node count: ${count.toLocaleString()}`);
    console.log(`[NodePlacement] [PERF] Total time: ${totalTime.toFixed(2)}ms`);
    console.log(`[NodePlacement] [PERF] Breakdown:`);
    console.log(`[NodePlacement] [PERF]   - Coordinate system: ${coordTime.toFixed(2)}ms (${(coordTime/totalTime*100).toFixed(1)}%)`);
    console.log(`[NodePlacement] [PERF]   - Node positioning: ${posTime.toFixed(2)}ms (${(posTime/totalTime*100).toFixed(1)}%)`);
    if (forceTime > 0) {
      console.log(`[NodePlacement] [PERF]   - Force layout: ${forceTime.toFixed(2)}ms (${(forceTime/totalTime*100).toFixed(1)}%)`);
    }
    console.log(`[NodePlacement] [PERF]   - Visual attributes: ${attrTime.toFixed(2)}ms (${(attrTime/totalTime*100).toFixed(1)}%)`);
    console.log(`[NodePlacement] [PERF] Time per node: ${(totalTime / count * 1000).toFixed(2)}µs`);
    if (memUsed !== 0) {
      console.log(`[NodePlacement] [PERF] Memory delta: ${(memUsed / 1024 / 1024).toFixed(2)}MB`);
      console.log(`[NodePlacement] [PERF] Memory per node: ${(memUsed / count).toFixed(2)} bytes`);
    }
    console.log(`[NodePlacement] [PERF] ======================================`);
    console.log(`[NodePlacement] Layout generation complete for ${count.toLocaleString()} nodes`);
  }

  /**
   * Determine the coordinate system bounds based on positioning mode
   */
  private determineCoordinateSystem(
    _count: number,
    spread: number
  ): {
    mode: 'parameter' | 'layout';
    xParamIndex: string;
    yParamIndex: string;
    minValues: { x: number; y: number };
    maxValues: { x: number; y: number };
    spread: number;
  } {
    if (!this.config.useParameterPositioning) {
      // Layout-based positioning (force, random, grid, etc.)
      return {
        mode: 'layout',
        xParamIndex: '',
        yParamIndex: '',
        minValues: { x: -spread, y: -spread },
        maxValues: { x: spread, y: spread },
        spread
      };
    }

    // Parameter-based positioning
    const xParamIndex = this.config.parameterXAxis ?? "";
    const yParamIndex = this.config.parameterYAxis ?? "";

    if (DEBUG) console.log(`[CoordinateSystem] Parameter mode: X="${xParamIndex}", Y="${yParamIndex}"`);

    // Get parameter ranges from PrismAPI cache
    const xRange = this.prismAPI.getParameterMinMax(xParamIndex);
    const yRange = this.prismAPI.getParameterMinMax(yParamIndex);

    let minX = 0, maxX = 100;
    let minY = 0, maxY = 100;

    // Use cached ranges or calculate from nodes
    if (xRange) {
      minX = xRange.min;
      maxX = xRange.max;
      if (DEBUG) console.log(`[CoordinateSystem] X range from cache: [${minX}, ${maxX}]`);
    } else {
      const calculated = this.calculateParameterRange(xParamIndex);
      minX = calculated.min;
      maxX = calculated.max;
      if (DEBUG) console.log(`[CoordinateSystem] X range calculated: [${minX}, ${maxX}]`);
    }

    if (yRange) {
      minY = yRange.min;
      maxY = yRange.max;
      if (DEBUG) console.log(`[CoordinateSystem] Y range from cache: [${minY}, ${maxY}]`);
    } else {
      const calculated = this.calculateParameterRange(yParamIndex);
      minY = calculated.min;
      maxY = calculated.max;
      if (DEBUG) console.log(`[CoordinateSystem] Y range calculated: [${minY}, ${maxY}]`);
    }

    return {
      mode: 'parameter',
      xParamIndex,
      yParamIndex,
      minValues: { x: minX, y: minY },
      maxValues: { x: maxX, y: maxY },
      spread
    };
  }

  /**
   * Calculate min/max range for a parameter across all nodes
   */
  private calculateParameterRange(paramIndex: string): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;

    for (const node of this.nodes) {
      const valRaw = PrismAPI.getParameterValue(node, paramIndex);
      const val = this.convertParameterValueToNumber(valRaw);
      if (!isNaN(val) && isFinite(val)) {
        min = Math.min(min, val);
        max = Math.max(max, val);
      }
    }

    // Fallback if no valid values found
    if (!isFinite(min) || !isFinite(max)) {
      return { min: 0, max: 100 };
    }

    return { min, max };
  }

  /**
   * Position all nodes in the coordinate system AND build stack map simultaneously
   * This is where each node gets its (x, y) coordinates AND gets grouped by position
   */
  private async positionNodesInCoordinateSystem(
    positions: Float32Array,
    count: number,
    spread: number,
    coordinateSystem: {
      mode: 'parameter' | 'layout';
      xParamIndex: string;
      yParamIndex: string;
      minValues: { x: number; y: number };
      maxValues: { x: number; y: number };
      spread: number;
    },
    showProgress: boolean = false
  ): Promise<Map<number, number[]>> {
    const batchSize = 100000;
    const isParameterMode = coordinateSystem.mode === 'parameter';
    const POSITION_EPSILON = 0.001;

    // Build stack map while positioning nodes
    const positionToNodesMap = new Map<number, number[]>();

    for (let batch = 0; batch < count; batch += batchSize) {
      const end = Math.min(batch + batchSize, count);

      for (let i = batch; i < end; i++) {
        const nodeData = this.nodes[i];
        let position: THREE.Vector2;

        if (isParameterMode) {
          // Parameter-based positioning
          position = this.positionNodeByParameters(
            nodeData,
            coordinateSystem
          );
        } else {
          // Layout-based positioning (random, force initial, etc.)
          position = this.positionNodeByLayout(
            nodeData,
            i,
            count,
            spread
          );
        }

        // Update node data
        nodeData.x = position.x;
        nodeData.y = position.y;

        // Update positions array
        const x = position.x;
        const y = position.y;
        const z = 0;
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        // OPTIMIZATION: Build stack map during placement (not after!)
        const positionKey = this.createPositionKey(x, y, z, POSITION_EPSILON);
        if (!positionToNodesMap.has(positionKey)) {
          positionToNodesMap.set(positionKey, []);
        }
        positionToNodesMap.get(positionKey)!.push(i);
      }

      // Yield control and update progress for large graphs
      if (end < count) {
        if (showProgress) {
          const progress = (end / count) * 100;
          this.prismAPI.progressIndicator.updateProgress(progress);
          this.prismAPI.progressIndicator.setStatus(`Positioning nodes: ${end.toLocaleString()} / ${count.toLocaleString()}`);
        }
        if (count > 50000) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }

    console.log(`[NodePlacement] Positioned ${count.toLocaleString()} nodes`);
    console.log(`[NodePlacement] Generated ${positionToNodesMap.size.toLocaleString()} unique positions (${((1 - positionToNodesMap.size / count) * 100).toFixed(1)}% reduction)`);

    return positionToNodesMap;
  }

  /**
   * Position a single node based on parameter values
   */
  private positionNodeByParameters(
    node: NodeData,
    coordinateSystem: {
      xParamIndex: string;
      yParamIndex: string;
      minValues: { x: number; y: number };
      maxValues: { x: number; y: number };
      spread: number;
    }
  ): THREE.Vector2 {
    const { xParamIndex, yParamIndex, minValues, maxValues, spread } = coordinateSystem;

    // Check if node is visible (has valid parameter values)
    const isVisible = this.isNodeVisibleForParameters(node, xParamIndex, yParamIndex);

    if (!isVisible) {
      // Hide invisible nodes off-screen
      return new THREE.Vector2(-999999, -999999);
    }

    // Get parameter values
    const paramXRaw = PrismAPI.getParameterValue(node, xParamIndex);
    const paramYRaw = PrismAPI.getParameterValue(node, yParamIndex);

    // Convert to numbers
    const paramX = this.convertParameterValueToNumber(paramXRaw);
    const paramY = this.convertParameterValueToNumber(paramYRaw);

    // Map parameter values to world coordinates
    const worldX = this.mapParameterToWorldCoordinate(
      paramX,
      minValues.x,
      maxValues.x,
      spread
    );
    const worldY = this.mapParameterToWorldCoordinate(
      paramY,
      minValues.y,
      maxValues.y,
      spread
    );

    return new THREE.Vector2(worldX, worldY);
  }

  /**
   * Map a parameter value to world coordinate
   */
  private mapParameterToWorldCoordinate(
    paramValue: number,
    minParam: number,
    maxParam: number,
    spread: number
  ): number {
    // Handle edge case: all parameters have same value
    if (maxParam === minParam) {
      return 0;
    }

    // Normalize parameter value to [0, 1]
    const normalized = (paramValue - minParam) / (maxParam - minParam);

    // Map to world coordinates: [0, 1] -> [-spread, +spread]
    return (normalized * 2 - 1) * spread;
  }

  /**
   * Position a single node based on layout algorithm
   */
  private positionNodeByLayout(
    node: NodeData,
    index: number,
    count: number,
    spread: number
  ): THREE.Vector2 {
    // If node already has a position from API, use it
    if (node.x !== 0 || node.y !== 0) {
      return new THREE.Vector2(node.x, node.y);
    }

    // Otherwise, calculate position based on current layout
    return this.calculateNodePosition(index, count, spread);
  }

  /**
   * Generate visual attributes (colors, sizes) for all nodes
   */
  private generateNodeVisualAttributes(
    colors: Float32Array,
    sizes: Float32Array,
    count: number
  ): void {
    // Pre-calculate color cache for performance
    const colorCache = new Map<number, { r: number; g: number; b: number }>();
    const getColorForDegree = (degree: number): { r: number; g: number; b: number } => {
      const key = Math.min(degree, 20);
      if (!colorCache.has(key)) {
        const hue = key > 0 ? Math.min(0.3, key * 0.05) : 0.6;
        const color = new THREE.Color().setHSL(hue, 0.8, 0.6);
        colorCache.set(key, { r: color.r, g: color.g, b: color.b });
      }
      return colorCache.get(key)!;
    };

    // Generate colors and sizes based on node degree
    for (let i = 0; i < count; i++) {
      const nodeData = this.nodes[i];
      const degree = nodeData.degree ?? 0;
      const colorData = getColorForDegree(degree);

      colors[i * 3] = colorData.r;
      colors[i * 3 + 1] = colorData.g;
      colors[i * 3 + 2] = colorData.b;

      sizes[i] = 1.0;
    }
  }


  //random layout
  private async generateLayout(
    count: number,
    positions: Float32Array,
    colors: Float32Array,
    sizes: Float32Array
  ): Promise<void> {
    const spread = Math.sqrt(count) * 0.5;

    // Pre-allocate array for better performance
    this.nodes = new Array(count);

    // Initialize nodes with parameters in batches for large graphs
    const batchSize = 50000;
    for (let batch = 0; batch < count; batch += batchSize) {
      const end = Math.min(batch + batchSize, count);

      for (let i = batch; i < end; i++) {
        this.nodes[i] = {
          id: i,
          x: 0, // Will be set below
          y: 0, // Will be set below
          radius: 0,
          cluster: Math.floor(i / Math.max(1, count / 10)) % 10,
          type: 's', // Todo: s/t typing
          parameters: this.generateNodeParameters()
        };
      }

      // Yield control for large graphs to keep UI responsive
      if (count > 50000 && end < count) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // Calculate min/max parameter values if using parameter positioning
    let minX = 0, maxX = 100;
    let minY = 0, maxY = 100;

    if (this.config.useParameterPositioning) {
      const xParamIndex = this.config.parameterXAxis ?? "";
      const yParamIndex = this.config.parameterYAxis ?? "";

      // Use cached min/max values from PrismAPI (calculated during data loading)
      const xRange = this.prismAPI.getParameterMinMax(xParamIndex);
      const yRange = this.prismAPI.getParameterMinMax(yParamIndex);

      if (xRange) {
        minX = xRange.min;
        maxX = xRange.max;
      } else {
        // Fallback: calculate from nodes (shouldn't happen for API-loaded data)
        minX = Infinity;
        maxX = -Infinity;
        for (let i = 0; i < count; i++) {
          const valRaw = PrismAPI.getParameterValue(this.nodes[i], xParamIndex);
          const val = this.convertParameterValueToNumber(valRaw);
          if (!isNaN(val) && isFinite(val)) {
            minX = Math.min(minX, val);
            maxX = Math.max(maxX, val);
          }
        }
      }

      if (yRange) {
        minY = yRange.min;
        maxY = yRange.max;
      } else {
        // Fallback: calculate from nodes (shouldn't happen for API-loaded data)
        minY = Infinity;
        maxY = -Infinity;
        for (let i = 0; i < count; i++) {
          const valRaw = PrismAPI.getParameterValue(this.nodes[i], yParamIndex);
          const val = this.convertParameterValueToNumber(valRaw);
          if (!isNaN(val) && isFinite(val)) {
            minY = Math.min(minY, val);
            maxY = Math.max(maxY, val);
          }
        }
      }
    }

    // Now position all nodes
    for (let i = 0; i < count; i++) {
      const nodeData = this.nodes[i];

      // Calculate position based on parameters or layout
      let position: THREE.Vector2;
      if (this.config.useParameterPositioning) {
        position = this.calculateParameterPosition(
          nodeData,
          spread,
          { x: minX, y: minY },
          { x: maxX, y: maxY }
        );
      } else {
        position = this.calculateNodePosition(i, count, spread);
      }

      // Update node position
      nodeData.x = position.x;
      nodeData.y = position.y;

      // Set initial positions array
      positions[i * 3] = position.x;
      positions[i * 3 + 1] = position.y;
      positions[i * 3 + 2] = 0;
    }
    
    // Apply force-directed layout if selected
    if (this.currentLayout === 'force') {
      this.ui.updateStatus('Computing force-directed layout...');
      this.applyForceDirectedLayout(count, positions, spread);
    }
    
    // // Pre-calculate color table for common degree values to avoid creating Color objects
    // const colorCache = new Map<number, { r: number; g: number; b: number }>();
    // const getColorForDegree = (degree: number): { r: number; g: number; b: number } => {
    //   const key = Math.min(degree, 20); // Cap at 20 for cache efficiency
    //   if (!colorCache.has(key)) {
    //     const hue = key > 0 ? Math.min(0.3, key * 0.05) : 0.6;
    //     const color = new THREE.Color().setHSL(hue, 0.8, 0.6);
    //     colorCache.set(key, { r: color.r, g: color.g, b: color.b });
    //   }
    //   return colorCache.get(key)!;
    // };

    // // Update colors and sizes based on final positions and connectivity
    // for (let i = 0; i < count; i++) {
    //   const x = positions[i * 3];
    //   const y = positions[i * 3 + 1];

    //   const size = this.calculateNodeSize(x, y, spread);

    //   // Adjust size based on node degree (connectivity)
    //   const degree = (this.nodes[i] as any).degree || 0;
    //   const adjustedSize = size + (degree * 0.2);

    //   this.nodes[i].radius = adjustedSize;

    //   // Set colors array - color based on connectivity (using cache)
    //   const color = getColorForDegree(degree);
    //   colors[i * 3] = color.r;
    //   colors[i * 3 + 1] = color.g;
    //   colors[i * 3 + 2] = color.b;

    //   // Set sizes array
    //   sizes[i] = adjustedSize;
    // }
  }

  // Gaussian distribution generator using Box-Muller transform
  private generateGaussian(mean: number = 50, stdDev: number = 15): number {
    let u = 0, v = 0;
    while(u === 0) u = Math.random(); // Converting [0,1) to (0,1)
    while(v === 0) v = Math.random();

    const normal = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    const value = mean + stdDev * normal;

    // No clamping - allow full Gaussian distribution
    return value;
  }

  // Random center points for each parameter (shared across all nodes)
  private parameterCenters: number[] | null = null;

  // Viridis color scale - excellent for ordinal/sequential data
  // 6 distinct colors with larger perceptual differences
  private viridisColors = [
    { r: 0.267004, g: 0.004874, b: 0.329415 }, // Dark purple
    { r: 0.253935, g: 0.265254, b: 0.529983 }, // Blue-purple
    { r: 0.163625, g: 0.471133, b: 0.558148 }, // Cyan-blue
    { r: 0.134692, g: 0.658636, b: 0.517649 }, // Green-cyan
    { r: 0.477504, g: 0.821444, b: 0.318195 }, // Yellow-green
    { r: 0.993248, g: 0.906157, b: 0.143936 }  // Bright yellow
  ];

  // Initialize random center points for parameters
  private initializeParameterCenters(): void {
    this.parameterCenters = [
      Math.random() * 100, // Parameter 0 center
      Math.random() * 100, // Parameter 1 center
      Math.random() * 100, // Parameter 2 center
      Math.random() * 100, // Parameter 3 center
      Math.random() * 100, // Parameter 4 center
      Math.random() * 100, // Parameter 5 center
      Math.random() * 100, // Parameter 6 center
      Math.random() * 100, // Parameter 7 center
      Math.random() * 100, // Parameter 8 center
      Math.random() * 100  // Parameter 9 center
    ];
  }

  // Map parameter value to viridis color using linear interpolation
  // Uses dynamic range based on actual min/max values in the dataset
  private getColorFromParameter(value: number, minValue: number, maxValue: number): { r: number; g: number; b: number } {
    // Safety check: ensure viridisColors array is not empty
    if (!this.viridisColors || this.viridisColors.length === 0) {
      console.error('[Graph2D] viridisColors array is empty or undefined');
      return { r: 0.5, g: 0.5, b: 0.5 }; // Return gray as fallback
    }

    // Handle invalid input values - return middle color without logging
    // (Some nodes may not have the parameter being visualized, which is expected)
    if (!isFinite(value) || !isFinite(minValue) || !isFinite(maxValue)) {
      // Return middle color from viridis scale
      const midIndex = Math.floor(this.viridisColors.length / 2);
      return this.viridisColors[midIndex];
    }

    // Normalize value to [0, 1] range based on actual data range
    const range = maxValue - minValue;
    const normalizedValue = range > 0 ? (value - minValue) / range : 0.5;
    const clampedValue = Math.max(0, Math.min(1, normalizedValue));

    // Map to color stops range (0 to length-1)
    const scaledValue = clampedValue * (this.viridisColors.length - 1);
    const lowerIndex = Math.floor(scaledValue);
    const upperIndex = Math.min(lowerIndex + 1, this.viridisColors.length - 1);
    const t = scaledValue - lowerIndex; // interpolation factor [0, 1]

    // Linear interpolation between two color stops
    const colorLower = this.viridisColors[lowerIndex];
    const colorUpper = this.viridisColors[upperIndex];

    // Safety check: ensure colors exist at these indices
    if (!colorLower || !colorUpper) {
      console.error('[Graph2D] Color not found at indices:', { lowerIndex, upperIndex, arrayLength: this.viridisColors.length });
      return { r: 0.5, g: 0.5, b: 0.5 }; // Return gray as fallback
    }

    return {
      r: colorLower.r + (colorUpper.r - colorLower.r) * t,
      g: colorLower.g + (colorUpper.g - colorLower.g) * t,
      b: colorLower.b + (colorUpper.b - colorLower.b) * t
    };
  }

  // Random Generation: Generate 10 parameters with Gaussian distribution for a node
  private generateNodeParameters(): [number, number, number, number, number, number, number, number, number, number] {
    // Initialize centers if not already done
    if (!this.parameterCenters) {
      this.initializeParameterCenters();
    }

    const parameters: [number, number, number, number, number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const stdDev = 15; // Standard deviation for all parameters

    for (let i = 0; i < 10; i++) {
      // Use the shared center point for this parameter
      parameters[i] = this.generateGaussian(this.parameterCenters![i], stdDev);
    }

    return parameters;
  }

  /**
   * Convert parameter value to Three.js world coordinate
   * @param paramValue - The parameter value to convert
   * @param minParam - Minimum parameter value in the dataset
   * @param maxParam - Maximum parameter value in the dataset
   * @param spread - The world space extent (world coordinates go from -spread to +spread)
   * @returns World coordinate in Three.js space
   */
  private paramToWorld(
    paramValue: number,
    minParam: number,
    maxParam: number,
    spread: number
  ): number {
    // Handle invalid parameter values
    if (paramValue === null || paramValue === undefined || isNaN(paramValue)) {
      console.warn(`[paramToWorld] Invalid paramValue: ${paramValue}`);
      return 0; // Default to origin for invalid values
    }

    const range = maxParam - minParam;
    if (range === 0) {
      console.warn(`[paramToWorld] Zero range: min=${minParam}, max=${maxParam}`);
      return 0; // If no range, center at origin
    }

    // Normalize to [0, 1]
    const normalized = (paramValue - minParam) / range;

    // Map from [0, 1] to [-spread, spread]
    const worldPos = (normalized - 0.5) * 2 * spread;

    // Debug logging for first few calls
    if (Math.random() < 0.01) { // Log ~1% of calls to avoid spam
      console.log(`[paramToWorld] param=${paramValue}, min=${minParam}, max=${maxParam}, spread=${spread}`);
      console.log(`[paramToWorld]   normalized=${normalized.toFixed(4)}, worldPos=${worldPos.toFixed(2)}`);
    }

    return worldPos;
  }

  /**
   * Convert Three.js world coordinate to parameter value
   * @param worldPos - The world position to convert
   * @param minParam - Minimum parameter value in the dataset
   * @param maxParam - Maximum parameter value in the dataset
   * @param spread - The world space extent (world coordinates go from -spread to +spread)
   * @returns Parameter value
   */
  private worldToParam(
    worldPos: number,
    minParam: number,
    maxParam: number,
    spread: number
  ): number {
    if (spread === 0) return minParam;

    // Normalize world position to [0, 1]
    const normalized = (worldPos + spread) / (2 * spread);

    // Map to parameter range
    const range = maxParam - minParam;
    return minParam + normalized * range;
  }

  // Calculate position based on parameter values
  // Note: minValues and maxValues need to be passed in for correct mapping
  private calculateParameterPosition(
    node: NodeData,
    spread: number,
    minValues: { x: number; y: number },
    maxValues: { x: number; y: number }
  ): THREE.Vector2 {
    if (this.config.useParameterPositioning) {
      const xParam = this.config.parameterXAxis ?? "";
      const yParam = this.config.parameterYAxis ?? "";

      // Get parameter values and convert to world coordinates
      const paramXRaw = PrismAPI.getParameterValue(node, xParam);
      const paramYRaw = PrismAPI.getParameterValue(node, yParam);

      // BUGFIX: Convert parameter values to numbers before using them in calculations
      const paramX = this.convertParameterValueToNumber(paramXRaw);
      const paramY = this.convertParameterValueToNumber(paramYRaw);

      // Debug first 5 nodes to see what's happening
      const nodeIndex = this.nodes.indexOf(node);
      if (nodeIndex < 5) {
        console.log(`[calculateParameterPosition] Node ${node.id} (index ${nodeIndex}):`);
        console.log(`  Looking for xParam="${xParam}", yParam="${yParam}"`);
        console.log(`  Found paramXRaw=${paramXRaw} (type=${typeof paramXRaw}) -> paramX=${paramX}`);
        console.log(`  Found paramYRaw=${paramYRaw} (type=${typeof paramYRaw}) -> paramY=${paramY}`);
        console.log(`  minValues: x=${minValues.x} (type=${typeof minValues.x}), y=${minValues.y} (type=${typeof minValues.y})`);
        console.log(`  maxValues: x=${maxValues.x} (type=${typeof maxValues.x}), y=${maxValues.y} (type=${typeof maxValues.y})`);
        console.log(`  spread=${spread}`);
      }

      const x = this.paramToWorld(paramX, minValues.x, maxValues.x, spread);
      const y = this.paramToWorld(paramY, minValues.y, maxValues.y, spread);

      if (node.id === 384 || node.id === 640 || node.id === 642 || node.id === 643) {
        console.log(`  Calculated world position: x=${x}, y=${y}`);
      }

      return new THREE.Vector2(x, y);
    }

    // Fallback to random position
    return new THREE.Vector2((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread);
  }

  private calculateNodePosition(index: number, _count: number, spread: number): THREE.Vector2 {
    let x: number, y: number;

    if (this.currentLayout === 'force') {
      // Force layout starts with a distributed initial position
      const hash = (index * 2654435761) % 2147483647;
      const initAngle = (hash / 2147483647) * Math.PI * 2;
      const initRadius = spread * 0.5 * Math.sqrt((hash % 10000) / 10000);
      x = Math.cos(initAngle) * initRadius;
      y = Math.sin(initAngle) * initRadius;
    } else {
      // Random position for other layouts
      x = (Math.random() - 0.5) * spread;
      y = (Math.random() - 0.5) * spread;
    }

    return new THREE.Vector2(x, y);
  }


  private calculateNodeSize(x: number, y: number, spread: number): number {
    const distanceFromCenter = Math.sqrt(x * x + y * y);
    const normalizedDistance = Math.min(1, distanceFromCenter / spread);
    const baseSize = ((1 - normalizedDistance * 0.3) * 6 + 3) * 1.5; // Increased by 1.5x: 4.5-13.5
    return baseSize;
  }

  private generateRandomEdges(nodeCount: number): void {
    // Generate 0.5x as many edges as nodes (moderate connectivity)
    const edgeCount = Math.min(Math.floor(nodeCount * 0.5), nodeCount * (nodeCount - 1) / 2);
    this.edges = [];

    // Use Sets for O(1) duplicate detection instead of arrays
    const connectionSets: Set<number>[] = Array(nodeCount).fill(null).map(() => new Set());
    const edgeSet = new Set<string>(); // Track edges as "from-to" strings

    let edgesCreated = 0;
    let attempts = 0;
    const maxAttempts = edgeCount * 10; // Avoid infinite loops

    while (edgesCreated < edgeCount && attempts < maxAttempts) {
      attempts++;

      const from = Math.floor(Math.random() * nodeCount);
      const to = Math.floor(Math.random() * nodeCount);

      // Skip self-loops
      if (from === to) continue;

      // Create canonical edge key (smaller index first for undirected)
      const edgeKey = from < to ? `${from}-${to}` : `${to}-${from}`;

      // Skip if edge already exists
      if (edgeSet.has(edgeKey)) continue;

      // Add the edge
      this.edges.push({ from, to});
      edgeSet.add(edgeKey);
      connectionSets[from].add(to);
      connectionSets[to].add(from);
      edgesCreated++;
    }

    if (STATUS) console.log(`[generateRandomEdges] Successfully created ${edgesCreated} edges for ${nodeCount} nodes`);

    // Convert Sets back to arrays for node data
    this.nodes.forEach((node, index) => {
      const connectionsArray = Array.from(connectionSets[index]);
      (node as any).connections = connectionsArray;
      (node as any).degree = connectionsArray.length;
    });
  }

  private applyForceDirectedLayout(_nodeCount: number, positions: Float32Array, spread: number): void {
    const nodeCount = this.nodes.length;

    // Maximum iterations before stopping - increased for large graphs
    const maxIterations = nodeCount > 10000 ? 400 : nodeCount > 1000 ? 500 : 700;

    // Force parameters - optimized for sparse graphs (0.5x edges)
    const repulsionStrength = 500; // Moderate repulsion
    const attractionStrength = 0.2; // Strong attraction to keep connected nodes together
    const targetLinkLength = spread * 0.15; // Moderate desired edge length
    const centeringStrength = 0.005; // Very weak centering
    const damping = 0.85; // Higher damping for stability

    // Convergence threshold - stop when movement is small (relaxed for large graphs)
    const convergenceThreshold = nodeCount > 10000 ? 0.08 : 0.015;

    // For large graphs (>10k nodes), use approximate repulsion with sampling
    const useFullRepulsion = nodeCount < 10000;
    const repulsionSampleSize = 50; // Sample this many random nodes for repulsion calculation

    // Initialize simulation nodes with typed arrays for better performance
    const simX = new Float32Array(nodeCount);
    const simY = new Float32Array(nodeCount);
    const simVX = new Float32Array(nodeCount);
    const simVY = new Float32Array(nodeCount);

    for (let i = 0; i < nodeCount; i++) {
      simX[i] = positions[i * 3] || (Math.random() - 0.5) * spread;
      simY[i] = positions[i * 3 + 1] || (Math.random() - 0.5) * spread;
      simVX[i] = 0;
      simVY[i] = 0;
    }

    // Simulation loop with convergence detection
    for (let iter = 0; iter < maxIterations; iter++) {
      // Reset forces
      simVX.fill(0);
      simVY.fill(0);

      // 1. REPULSION: All nodes repel each other
      if (useFullRepulsion) {
        // Full O(n^2) repulsion for smaller graphs
        for (let i = 0; i < nodeCount; i++) {
          for (let j = i + 1; j < nodeCount; j++) {
            const dx = simX[i] - simX[j];
            const dy = simY[i] - simY[j];
            const distSq = dx * dx + dy * dy + 0.01; // Small epsilon to avoid division by zero
            const dist = Math.sqrt(distSq);

            // Coulomb's law: F = k / r^2
            const repulsionForce = repulsionStrength / distSq;
            const fx = (dx / dist) * repulsionForce;
            const fy = (dy / dist) * repulsionForce;

            simVX[i] += fx;
            simVY[i] += fy;
            simVX[j] -= fx;
            simVY[j] -= fy;
          }
        }
      } else {
        // Approximate repulsion using random sampling for large graphs
        // Each node samples a subset of other nodes to reduce from O(n^2) to O(n*k)
        for (let i = 0; i < nodeCount; i++) {
          // Sample random nodes for repulsion calculation
          for (let s = 0; s < repulsionSampleSize; s++) {
            const j = Math.floor(Math.random() * nodeCount);
            if (i === j) continue; // Skip self

            const dx = simX[i] - simX[j];
            const dy = simY[i] - simY[j];
            const distSq = dx * dx + dy * dy + 0.01;
            const dist = Math.sqrt(distSq);

            // Scale up the force to compensate for sampling
            // We're only seeing ~sampleSize nodes instead of all nodeCount nodes
            const scaleFactor = nodeCount / repulsionSampleSize;
            const repulsionForce = (repulsionStrength * scaleFactor) / distSq;
            const fx = (dx / dist) * repulsionForce;
            const fy = (dy / dist) * repulsionForce;

            simVX[i] += fx;
            simVY[i] += fy;
          }
        }
      }

      // 2. ATTRACTION: Connected nodes attract each other (Hooke's law)
      for (let e = 0; e < this.edges.length; e++) {
        const edge = this.edges[e];
        const i = edge.from;
        const j = edge.to;

        if (i >= nodeCount || j >= nodeCount) continue;

        const dx = simX[j] - simX[i];
        const dy = simY[j] - simY[i];
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.1;

        // Spring force: F = k * (distance - targetLength)
        const displacement = dist - targetLinkLength;
        const attractionForce = attractionStrength * displacement;
        const fx = (dx / dist) * attractionForce;
        const fy = (dy / dist) * attractionForce;

        simVX[i] += fx;
        simVY[i] += fy;
        simVX[j] -= fx;
        simVY[j] -= fy;
      }

      // 3. CENTER FORCE: Gentle pull towards center to keep graph compact
      // Only apply to nodes that are far from center to prevent central clumping
      const centerThreshold = spread * 0.5; // Only pull nodes beyond this distance
      for (let i = 0; i < nodeCount; i++) {
        const distFromCenter = Math.sqrt(simX[i] * simX[i] + simY[i] * simY[i]);

        if (distFromCenter > centerThreshold) {
          // Only apply centering force to outliers
          const excessDist = distFromCenter - centerThreshold;
          const centerForce = centeringStrength * excessDist;
          const dist = distFromCenter + 0.1;
          simVX[i] -= (simX[i] / dist) * centerForce;
          simVY[i] -= (simY[i] / dist) * centerForce;
        }
      }

      // 4. UPDATE POSITIONS: Apply forces with damping
      let maxMovement = 0;
      for (let i = 0; i < nodeCount; i++) {
        // Apply velocity with damping
        simVX[i] *= damping;
        simVY[i] *= damping;

        // Clamp velocities to prevent explosions (increased limit for better spreading)
        const maxVelocity = spread * 0.2;
        simVX[i] = Math.max(-maxVelocity, Math.min(maxVelocity, simVX[i]));
        simVY[i] = Math.max(-maxVelocity, Math.min(maxVelocity, simVY[i]));

        // Update positions
        simX[i] += simVX[i];
        simY[i] += simVY[i];

        // Safety check: ensure positions are valid numbers
        if (!isFinite(simX[i]) || !isFinite(simY[i])) {
          simX[i] = (Math.random() - 0.5) * spread * 0.5;
          simY[i] = (Math.random() - 0.5) * spread * 0.5;
          simVX[i] = 0;
          simVY[i] = 0;
        }

        // Track maximum movement for convergence detection
        const movement = Math.sqrt(simVX[i] * simVX[i] + simVY[i] * simVY[i]);
        maxMovement = Math.max(maxMovement, movement);

        // Update positions array
        positions[i * 3] = simX[i];
        positions[i * 3 + 1] = simY[i];
      }

      // Check for convergence - stop if nodes barely moving
      if (maxMovement < convergenceThreshold) {
        this.ui.updateStatus(`Force simulation converged after ${iter + 1} iterations`);
        break;
      }

    }

    // Update node data with final positions
    for (let i = 0; i < nodeCount; i++) {
      this.nodes[i].x = simX[i];
      this.nodes[i].y = simY[i];
    }
  }

  private createEdgeLines(): void {
    console.log(`[createEdgeLines] Starting with ${this.edges.length} edges, ${this.nodes.length} nodes`);

    if (!this.edges.length || !this.nodes.length) {
      console.log(`[createEdgeLines] Early return - no edges or nodes`);
      return;
    }

    // Filter out invalid edges and calculate extent in a single pass
    const validEdges: typeof this.edges = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    console.log(`[createEdgeLines] Filtering edges...`);
    for (let i = 0; i < this.edges.length; i++) {
      const edge = this.edges[i];

      // Validate edge indices
      if (edge.from < 0 || edge.from >= this.nodes.length ||
          edge.to < 0 || edge.to >= this.nodes.length ||
          !this.nodes[edge.from] || !this.nodes[edge.to]) {
        continue;
      }

      validEdges.push(edge);

      // Calculate extent while we're iterating
      const fromNode = this.nodes[edge.from];
      const toNode = this.nodes[edge.to];
      minX = Math.min(minX, fromNode.x, toNode.x);
      maxX = Math.max(maxX, fromNode.x, toNode.x);
      minY = Math.min(minY, fromNode.y, toNode.y);
      maxY = Math.max(maxY, fromNode.y, toNode.y);
    }

    console.log(`[createEdgeLines] Filtered to ${validEdges.length} valid edges`);

    if (validEdges.length === 0) {
      console.log(`[createEdgeLines] No valid edges, returning`);
      return;
    }

    // Create a group to hold both lines and arrows
    const edgeGroup = new THREE.Group();
    // Note: renderOrder is set individually for lines and arrows below

    // Create line segments for edges
    const lineGeometry = new THREE.BufferGeometry();
    const linePositions = new Float32Array(validEdges.length * 6); // 2 points per edge, 3 coords per point
    const lineColors = new Float32Array(validEdges.length * 6); // 2 points per edge, 3 colors per point

    // Pre-calculate edge color (reuse for all edges)
    const edgeColor = new THREE.Color(0xaaaaaa);

    // Populate line positions and colors in optimized loop
    console.log(`[createEdgeLines] Building line geometry...`);
    let validEdgeCount = 0;
    const edgeData: Array<{fromX: number, fromY: number, toX: number, toY: number, angle: number}> = [];

    for (let i = 0; i < validEdges.length; i++) {
      const edge = validEdges[i];
      const fromNode = this.nodes[edge.from];
      const toNode = this.nodes[edge.to];

      // Calculate direction vector
      const dx = toNode.x - fromNode.x;
      const dy = toNode.y - fromNode.y;
      const lengthSq = dx * dx + dy * dy;

      if (lengthSq < 0.0001) continue; // Skip zero-length edges

      // Line segment goes all the way from source to target node
      const idx = validEdgeCount * 6;
      linePositions[idx] = fromNode.x;
      linePositions[idx + 1] = fromNode.y;
      linePositions[idx + 2] = 0;
      linePositions[idx + 3] = toNode.x;
      linePositions[idx + 4] = toNode.y;
      linePositions[idx + 5] = 0;

      // Reuse edge color (avoid creating Color objects in loop)
      lineColors[idx] = edgeColor.r;
      lineColors[idx + 1] = edgeColor.g;
      lineColors[idx + 2] = edgeColor.b;
      lineColors[idx + 3] = edgeColor.r;
      lineColors[idx + 4] = edgeColor.g;
      lineColors[idx + 5] = edgeColor.b;

      // Store edge data for arrow creation
      edgeData.push({
        fromX: fromNode.x,
        fromY: fromNode.y,
        toX: toNode.x,
        toY: toNode.y,
        angle: Math.atan2(dy, dx)
      });

      validEdgeCount++;
    }

    console.log(`[createEdgeLines] Built ${validEdgeCount} line segments, creating arrows...`);

    // Arrow geometry - create using instanced mesh for better performance
    const viewHeight = this.camera.top - this.camera.bottom;
    const screenHeight = window.innerHeight;
    const worldUnitsPerPixel = viewHeight / screenHeight;
    const arrowPixelSize = 1.3 / 3; // Reduced to 1/3 of original size
    const arrowSize = arrowPixelSize * worldUnitsPerPixel;

    // Create single triangle geometry for all arrows
    const arrowGeometry = new THREE.BufferGeometry();
    const arrowVertices = new Float32Array([
      0, arrowSize * 0.8, 0,           // Tip of arrow
      -arrowSize * 0.5, -arrowSize * 0.4, 0,  // Bottom left
      arrowSize * 0.5, -arrowSize * 0.4, 0    // Bottom right
    ]);
    arrowGeometry.setAttribute('position', new THREE.BufferAttribute(arrowVertices, 3));
    arrowGeometry.setIndex([0, 1, 2]);

    // Use InstancedMesh for arrows (much more efficient than individual meshes)
    const arrowMaterial = new THREE.MeshBasicMaterial({
      color: 0x666666,
      transparent: false,
      opacity: 1.0,
      side: THREE.DoubleSide
    });

    const instancedArrows = new THREE.InstancedMesh(arrowGeometry, arrowMaterial, validEdgeCount);
    instancedArrows.renderOrder = -2; // Render behind nodes
    instancedArrows.raycast = () => {}; // Disable raycasting for arrows

    // Store edge data for dynamic updates
    (instancedArrows as any).userData = {
      edgeData: edgeData,
      baseArrowSize: arrowSize
    };

    // Set up transformation matrix for each arrow instance
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < edgeData.length; i++) {
      const data = edgeData[i];
      matrix.makeRotationZ(data.angle - Math.PI / 2);
      matrix.setPosition(data.toX, data.toY, 0.1);
      instancedArrows.setMatrixAt(i, matrix);
    }
    instancedArrows.instanceMatrix.needsUpdate = true;

    edgeGroup.add(instancedArrows);

    // Trim line buffers to actual valid edge count
    const trimmedPositions = linePositions.slice(0, validEdgeCount * 6);
    const trimmedColors = lineColors.slice(0, validEdgeCount * 6);

    lineGeometry.setAttribute('position', new THREE.BufferAttribute(trimmedPositions, 3));
    lineGeometry.setAttribute('color', new THREE.BufferAttribute(trimmedColors, 3));

    const lineMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      linewidth: 1
    });

    const lineSegments = new THREE.LineSegments(lineGeometry, lineMaterial);
    lineSegments.renderOrder = -3; // Render lines behind arrows and nodes
    lineSegments.raycast = () => {}; // Disable raycasting for edge lines
    edgeGroup.add(lineSegments);

    this.edgeLines = edgeGroup;
    this.scene.add(this.edgeLines);
    console.log(`[createEdgeLines] Complete - added ${validEdgeCount} edges to scene`);
  }

  /**
   * Update arrow scales and positions to maintain constant screen-space size during zoom
   */
  private updateArrowScales(): void {
    if (!this.edgeLines || !(this.edgeLines instanceof THREE.Group)) return;

    // For screen-space sizing, arrows should scale INVERSELY with zoom
    const scale = 1 / this.zoomLevel;

    // Calculate current world units per pixel for positioning
    const viewHeight = this.camera.top - this.camera.bottom;
    const screenHeight = window.innerHeight;
    const worldUnitsPerPixel = viewHeight / screenHeight;

    // Node size in pixels
    const nodePixelSize = 9.0;
    const offsetDistance = (nodePixelSize * 0.5) * worldUnitsPerPixel;

    // Update arrow instances in the edge group
    this.edgeLines.children.forEach(child => {
      if (child instanceof THREE.InstancedMesh) {
        // Handle instanced mesh (optimized path)
        const userData = child.userData as {
          edgeData: Array<{fromX: number, fromY: number, toX: number, toY: number, angle: number}>;
          baseArrowSize: number;
        };

        if (!userData || !userData.edgeData) return;

        const matrix = new THREE.Matrix4();
        const scaledArrowTipOffset = userData.baseArrowSize * 0.8 * scale;

        for (let i = 0; i < userData.edgeData.length; i++) {
          const data = userData.edgeData[i];

          // Calculate direction from angle
          const dirX = Math.cos(data.angle);
          const dirY = Math.sin(data.angle);

          // Position arrow tip offset from target node
          const arrowX = data.toX - dirX * (offsetDistance + scaledArrowTipOffset);
          const arrowY = data.toY - dirY * (offsetDistance + scaledArrowTipOffset);

          // Build transformation matrix with rotation and scale
          matrix.makeRotationZ(data.angle - Math.PI / 2);
          matrix.scale(new THREE.Vector3(scale, scale, scale));
          matrix.setPosition(arrowX, arrowY, 0.1);

          child.setMatrixAt(i, matrix);
        }

        child.instanceMatrix.needsUpdate = true;
      } else if (child instanceof THREE.Mesh && child.geometry.index && child.userData) {
        // Legacy path: individual arrow meshes (for backwards compatibility)
        const userData = child.userData as {
          fromX: number;
          fromY: number;
          toX: number;
          toY: number;
          dirX: number;
          dirY: number;
          baseArrowSize: number;
        };

        child.scale.set(scale, scale, scale);
        const scaledArrowTipOffset = userData.baseArrowSize * 0.8 * scale;
        const arrowX = userData.toX - userData.dirX * (offsetDistance + scaledArrowTipOffset);
        const arrowY = userData.toY - userData.dirY * (offsetDistance + scaledArrowTipOffset);
        child.position.set(arrowX, arrowY, 0.1);
      }
    });
  }

  private clearEdgeLines(): void {
    if (this.edgeLines) {
      this.scene.remove(this.edgeLines);

      // Handle both Group (with arrows) and LineSegments (legacy)
      if (this.edgeLines instanceof THREE.Group) {
        // Dispose all children in the group
        this.edgeLines.traverse((child) => {
          if (child instanceof THREE.InstancedMesh || child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
            if (child.geometry) {
              child.geometry.dispose();
            }
            if (child.material) {
              if (Array.isArray(child.material)) {
                child.material.forEach(mat => mat.dispose());
              } else {
                child.material.dispose();
              }
            }
          }
        });
        this.edgeLines.clear();
      } else if (this.edgeLines instanceof THREE.LineSegments) {
        // Legacy LineSegments disposal
        this.edgeLines.geometry.dispose();
        if (this.edgeLines.material instanceof THREE.Material) {
          this.edgeLines.material.dispose();
        }
      }

      this.edgeLines = null;
      if (STATUS) console.log(`[clearEdgeLines] COMPLETED - edgeLines set to null`);
    } else {
      if (STATUS) console.log(`[clearEdgeLines] Nothing to clear - edgeLines was already null`);
    }
  }

  /**
   * ============================================================================
   * COMPLETE REWRITE: Stack Generation System
   * ============================================================================
   *
   * This method groups nodes that occupy the same position in the coordinate
   * system into "stacks" and creates a single visual geometry point for each stack.
   *
   * Process:
   * 1. Scan all nodes and group by position (within epsilon tolerance)
   * 2. Create one geometry point per unique position
   * 3. Build mapping from geometry index to all nodes at that position
   *
   * This is the core of the stack generation system.
   */
  private async deduplicateStackedNodes(
    positions: Float32Array,
    colors: Float32Array,
    sizes: Float32Array
  ): Promise<{
    positions: Float32Array;
    colors: Float32Array;
    sizes: Float32Array;
    geometryToNodesMap: Map<number, number[]>;
  }> {
    const startTime = performance.now();
    const nodeCount = positions.length / 3;

    console.log(`[StackGeneration] Using cached stack map from layout generation...`);

    // Use the cached stack map created during node placement
    const stacks = this.cachedStackMap!;

    const stackCount = stacks.size;
    // Avoid spread operator for large datasets - use loop instead
    let largestStack = 0;
    for (const nodes of stacks.values()) {
      if (nodes.length > largestStack) {
        largestStack = nodes.length;
      }
    }
    console.log(`[StackGeneration] Using ${stackCount.toLocaleString()} stacks from ${nodeCount.toLocaleString()} nodes`);
    console.log(`[StackGeneration] Largest stack: ${largestStack} nodes`);
    console.log(`[StackGeneration] Reduction: ${((1 - stackCount / nodeCount) * 100).toFixed(1)}%`);

    // ============================================================
    // STEP 2: Create Geometry for Each Stack
    // ============================================================
    const geometryData = await this.createGeometryFromStacksAsync(
      stacks,
      positions,
      colors,
      sizes
    );

    const elapsed = performance.now() - startTime;
    this.lastStackGenTime = elapsed; // Store for final summary
    console.log(`[StackGeneration] Geometry creation completed in ${elapsed.toFixed(0)}ms`);

    return geometryData;
  }

  /**
   * Group nodes by their position in the coordinate system (async version with yielding)
   * Returns a map from position key to array of node indices
   */
  private async groupNodesByPositionAsync(
    positions: Float32Array,
    nodeCount: number
  ): Promise<Map<number, number[]>> {
    // Epsilon defines how close two positions must be to be considered "the same"
    const POSITION_EPSILON = 0.001;

    const positionToNodesMap = new Map<number, number[]>();

    for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex++) {
      const x = positions[nodeIndex * 3];
      const y = positions[nodeIndex * 3 + 1];
      const z = positions[nodeIndex * 3 + 2];

      // Create a position key by rounding to epsilon precision
      const positionKey = this.createPositionKey(x, y, z, POSITION_EPSILON);

      // Add node to the stack at this position
      if (!positionToNodesMap.has(positionKey)) {
        positionToNodesMap.set(positionKey, []);
      }
      positionToNodesMap.get(positionKey)!.push(nodeIndex);

      // Yield to UI periodically for very large datasets
      if (nodeIndex % 500000 === 0 && nodeIndex > 0) {
        console.log(`[StackGeneration] Grouped ${nodeIndex.toLocaleString()} / ${nodeCount.toLocaleString()} nodes...`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    return positionToNodesMap;
  }

  /**
   * Group nodes by their position (sync version - kept for compatibility)
   */
  private groupNodesByPosition(
    positions: Float32Array,
    nodeCount: number
  ): Map<number, number[]> {
    const POSITION_EPSILON = 0.001;
    const positionToNodesMap = new Map<number, number[]>();

    for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex++) {
      const x = positions[nodeIndex * 3];
      const y = positions[nodeIndex * 3 + 1];
      const z = positions[nodeIndex * 3 + 2];

      const positionKey = this.createPositionKey(x, y, z, POSITION_EPSILON);

      if (!positionToNodesMap.has(positionKey)) {
        positionToNodesMap.set(positionKey, []);
      }
      positionToNodesMap.get(positionKey)!.push(nodeIndex);
    }

    return positionToNodesMap;
  }

  /**
   * Create a unique numeric key for a position
   * Positions within epsilon distance will have the same key
   * Uses bit-packing for performance (avoids string concatenation)
   */
  private createPositionKey(
    x: number,
    y: number,
    z: number,
    epsilon: number
  ): number {
    // Round each coordinate to epsilon precision
    const roundedX = Math.round(x / epsilon);
    const roundedY = Math.round(y / epsilon);
    const roundedZ = Math.round(z / epsilon);

    // Pack into a single number using bit shifting (much faster than string concatenation)
    // Assumes coordinates are within reasonable bounds (-1M to 1M)
    // This gives us ~20 bits per coordinate
    const OFFSET = 1000000; // Offset to handle negative numbers
    const BITS_PER_COORD = 21;

    const ux = (roundedX + OFFSET) & 0x1FFFFF; // 21 bits
    const uy = (roundedY + OFFSET) & 0x1FFFFF; // 21 bits
    const uz = (roundedZ + OFFSET) & 0x3FF;    // 10 bits (z is usually 0)

    // Combine into 52-bit number (safe for JavaScript)
    return (ux * 0x200000000) + (uy * 0x400) + uz;
  }

  /**
   * Create deduplicated geometry arrays from stacks (async version with yielding)
   */
  private async createGeometryFromStacksAsync(
    stacks: Map<number, number[]>,
    positions: Float32Array,
    colors: Float32Array,
    sizes: Float32Array
  ): Promise<{
    positions: Float32Array;
    colors: Float32Array;
    sizes: Float32Array;
    geometryToNodesMap: Map<number, number[]>;
  }> {
    const stackCount = stacks.size;

    // Allocate arrays for deduplicated geometry
    const deduplicatedPositions = new Float32Array(stackCount * 3);
    const deduplicatedColors = new Float32Array(stackCount * 3);
    const deduplicatedSizes = new Float32Array(stackCount);
    const geometryToNodesMap = new Map<number, number[]>();

    let geometryIndex = 0;
    const stackValues = Array.from(stacks.values());

    for (let i = 0; i < stackValues.length; i++) {
      const nodeIndices = stackValues[i];
      const representativeNodeIndex = nodeIndices[0];

      // Copy position from representative node
      deduplicatedPositions[geometryIndex * 3]     = positions[representativeNodeIndex * 3];
      deduplicatedPositions[geometryIndex * 3 + 1] = positions[representativeNodeIndex * 3 + 1];
      deduplicatedPositions[geometryIndex * 3 + 2] = positions[representativeNodeIndex * 3 + 2];

      // Copy color from representative node
      deduplicatedColors[geometryIndex * 3]     = colors[representativeNodeIndex * 3];
      deduplicatedColors[geometryIndex * 3 + 1] = colors[representativeNodeIndex * 3 + 1];
      deduplicatedColors[geometryIndex * 3 + 2] = colors[representativeNodeIndex * 3 + 2];

      // Copy size from representative node
      deduplicatedSizes[geometryIndex] = sizes[representativeNodeIndex];

      // Store the mapping: geometry index -> all nodes at this position
      geometryToNodesMap.set(geometryIndex, nodeIndices);

      geometryIndex++;

      // Yield to UI periodically for very large stack sets
      if (i % 100000 === 0 && i > 0) {
        console.log(`[StackGeneration] Created geometry for ${i.toLocaleString()} / ${stackCount.toLocaleString()} stacks...`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    return {
      positions: deduplicatedPositions,
      colors: deduplicatedColors,
      sizes: deduplicatedSizes,
      geometryToNodesMap
    };
  }

  /**
   * Create deduplicated geometry arrays from stacks (sync version - kept for compatibility)
   */
  private createGeometryFromStacks(
    stacks: Map<number, number[]>,
    positions: Float32Array,
    colors: Float32Array,
    sizes: Float32Array
  ): {
    positions: Float32Array;
    colors: Float32Array;
    sizes: Float32Array;
    geometryToNodesMap: Map<number, number[]>;
  } {
    const stackCount = stacks.size;

    const deduplicatedPositions = new Float32Array(stackCount * 3);
    const deduplicatedColors = new Float32Array(stackCount * 3);
    const deduplicatedSizes = new Float32Array(stackCount);
    const geometryToNodesMap = new Map<number, number[]>();

    let geometryIndex = 0;

    for (const nodeIndices of stacks.values()) {
      const representativeNodeIndex = nodeIndices[0];

      deduplicatedPositions[geometryIndex * 3]     = positions[representativeNodeIndex * 3];
      deduplicatedPositions[geometryIndex * 3 + 1] = positions[representativeNodeIndex * 3 + 1];
      deduplicatedPositions[geometryIndex * 3 + 2] = positions[representativeNodeIndex * 3 + 2];

      deduplicatedColors[geometryIndex * 3]     = colors[representativeNodeIndex * 3];
      deduplicatedColors[geometryIndex * 3 + 1] = colors[representativeNodeIndex * 3 + 1];
      deduplicatedColors[geometryIndex * 3 + 2] = colors[representativeNodeIndex * 3 + 2];

      deduplicatedSizes[geometryIndex] = sizes[representativeNodeIndex];

      geometryToNodesMap.set(geometryIndex, nodeIndices);

      geometryIndex++;
    }

    return {
      positions: deduplicatedPositions,
      colors: deduplicatedColors,
      sizes: deduplicatedSizes,
      geometryToNodesMap
    };
  }

  /**
   * ============================================================================
   * Stack Re-Merging After Dynamic Repositioning
   * ============================================================================
   *
   * When nodes are dynamically repositioned (e.g., parameter axis change),
   * multiple stacks that were previously at different positions may now
   * occupy the same position. This method detects and merges such stacks.
   *
   * This is called after parameter positioning to consolidate stacks.
   */
  private redeplicateGeometryByPosition(): void {
    if (!this.pointCloud || !this.geometryToNodesMap) return;

    const positions = this.pointCloud.geometry.getAttribute('position') as THREE.BufferAttribute;
    const alphas = this.pointCloud.geometry.getAttribute('alpha') as THREE.BufferAttribute;
    if (!positions || !alphas) return;

    const startTime = performance.now();
    const POSITION_EPSILON = 0.001;

    if (DEBUG) console.log(`[StackRemerge] Starting re-merge of geometry points`);

    // ============================================================
    // STEP 1: Group Geometry Points by Position
    // ============================================================
    const geometryStacksByPosition = this.groupGeometryPointsByPosition(
      positions,
      POSITION_EPSILON
    );

    // ============================================================
    // STEP 2: Merge Stacks at Same Position
    // ============================================================
    const mergeResult = this.mergeGeometryStacks(
      geometryStacksByPosition,
      positions,
      alphas
    );

    // Update the mapping
    this.geometryToNodesMap = mergeResult.newGeometryToNodesMap;

    // Mark alphas buffer as needing update
    alphas.needsUpdate = true;

    const elapsed = performance.now() - startTime;
    if (PERFORMANCE && elapsed > 50) {
      console.log(`[StackRemerge] Completed in ${elapsed.toFixed(0)}ms, merged ${mergeResult.mergeCount} positions`);
    }

    if (DEBUG) {
      console.log(`[StackRemerge] Merged ${mergeResult.mergeCount} positions`);
    }

    if (mergeResult.skippedDueToLimit) {
      console.warn('[StackRemerge] Merge limit reached - some stacks were not merged to prevent performance issues');
    }
  }

  /**
   * Group existing geometry points by their current position
   * Returns map from position key to array of geometry indices
   */
  private groupGeometryPointsByPosition(
    positions: THREE.BufferAttribute,
    epsilon: number
  ): Map<number, number[]> {
    const positionToGeometryMap = new Map<number, number[]>();

    this.geometryToNodesMap.forEach((_nodeIndices, geometryIndex) => {
      const x = positions.getX(geometryIndex);
      const y = positions.getY(geometryIndex);
      const z = positions.getZ(geometryIndex);

      // Skip hidden nodes (moved off-screen)
      if (x < -999000) return;

      // Create position key
      const positionKey = this.createPositionKey(x, y, z, epsilon);

      // Add geometry index to this position
      if (!positionToGeometryMap.has(positionKey)) {
        positionToGeometryMap.set(positionKey, []);
      }
      positionToGeometryMap.get(positionKey)!.push(geometryIndex);
    });

    return positionToGeometryMap;
  }

  /**
   * Merge geometry stacks that are at the same position
   */
  private mergeGeometryStacks(
    geometryStacksByPosition: Map<number, number[]>,
    _positions: THREE.BufferAttribute,
    alphas: THREE.BufferAttribute
  ): {
    newGeometryToNodesMap: Map<number, number[]>;
    mergeCount: number;
    skippedDueToLimit: boolean;
  } {
    const newGeometryToNodesMap = new Map<number, number[]>();
    const MAX_MERGE_OPERATIONS = 10000;
    let mergeCount = 0;
    let skippedDueToLimit = false;

    for (const geometryIndices of geometryStacksByPosition.values()) {
      if (geometryIndices.length === 1) {
        // Single geometry at this position - no merging needed
        const geometryIndex = geometryIndices[0];
        const nodeIndices = this.geometryToNodesMap.get(geometryIndex)!;
        newGeometryToNodesMap.set(geometryIndex, nodeIndices);
      } else {
        // Multiple geometries at same position - merge them
        if (mergeCount >= MAX_MERGE_OPERATIONS) {
          // Performance limit reached - keep separate
          for (const geoIdx of geometryIndices) {
            const nodeIndices = this.geometryToNodesMap.get(geoIdx)!;
            newGeometryToNodesMap.set(geoIdx, nodeIndices);
          }
          skippedDueToLimit = true;
          continue;
        }

        // Merge all nodes from all geometries at this position
        const primaryGeometryIndex = geometryIndices[0];
        const mergedNodeIndices: number[] = [];

        for (const geoIdx of geometryIndices) {
          const nodeIndices = this.geometryToNodesMap.get(geoIdx)!;
          mergedNodeIndices.push(...nodeIndices);
        }

        // Store merged nodes under primary geometry index
        newGeometryToNodesMap.set(primaryGeometryIndex, mergedNodeIndices);

        // Hide secondary geometry points
        for (let i = 1; i < geometryIndices.length; i++) {
          const geoIdx = geometryIndices[i];
          alphas.setX(geoIdx, 0);
        }

        mergeCount++;
      }
    }

    return {
      newGeometryToNodesMap,
      mergeCount,
      skippedDueToLimit
    };
  }

  private async createPointCloud(
    geometry: THREE.BufferGeometry,
    positions: Float32Array,
    colors: Float32Array,
    sizes: Float32Array
  ): Promise<void> {
    // Deduplicate stacked nodes - only create one geometry point per unique position
    const deduplicatedData = await this.deduplicateStackedNodes(positions, colors, sizes);

    geometry.setAttribute('position', new THREE.BufferAttribute(deduplicatedData.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(deduplicatedData.colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(deduplicatedData.sizes, 1));

    // Add alpha attribute initialized to 1.0 (fully opaque) for all nodes
    const alphas = new Float32Array(deduplicatedData.positions.length / 3);
    alphas.fill(1.0);
    geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));

    // Store the mapping for hover/click detection
    this.geometryToNodesMap = deduplicatedData.geometryToNodesMap;

    // Use ShaderMaterial for per-vertex alpha support
    const material = new THREE.ShaderMaterial({
      uniforms: {
        pointSize: { value: 9.0 }
      },
      vertexShader: `
        attribute float size;
        attribute float alpha;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float pointSize;

        void main() {
          vColor = color;
          vAlpha = alpha;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = pointSize;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          // Create circular points
          vec2 center = gl_PointCoord - vec2(0.5);
          float dist = length(center);
          if (dist > 0.5) discard;

          gl_FragColor = vec4(vColor, vAlpha * 0.9);
        }
      `,
      transparent: true,
      vertexColors: true,
      depthWrite: false
    });

    this.pointCloud = new THREE.Points(geometry, material);
    this.pointCloud.frustumCulled = false; // Prevent nodes from being culled when zooming
    this.pointCloud.renderOrder = 1; // Render nodes on top of edges for both visuals and raycasting
    this.scene.add(this.pointCloud);
  }

  private clearPointCloud(): void {
    if (this.pointCloud) {
      this.scene.remove(this.pointCloud);
      this.pointCloud.geometry.dispose();
      if (this.pointCloud.material instanceof THREE.Material) {
        this.pointCloud.material.dispose();
      }
      this.pointCloud = null;
    }
    this.clearEdgeLines();
  }

  /**
   * Clear the entire graph canvas - removes all visual elements and resets to white background
   * This is called when switching projects to ensure a clean slate
   */
  public clearGraphCanvas(): void {
    console.log('[Graph2D] Clearing canvas and freeing memory...');

    // Clear all graph elements
    this.clearPointCloud();
    this.clearEdgeLines();
    this.clearSelection();
    this.clearAxisVisualization();
    this.clearOverlapLabels();

    // CRITICAL: Clear cached stack map to free memory
    if (this.cachedStackMap) {
      this.cachedStackMap.clear();
      this.cachedStackMap = null;
      console.log('[Graph2D] Cleared cached stack map');
    }

    // Clear geometry mapping
    this.geometryToNodesMap.clear();

    // Reset data arrays - set to empty to allow GC
    this.nodes = [];
    this.edges = [];
    // REMOVED: fullNodes/fullEdges assignments (memory optimization)

    // Clear PCA results cache
    this.pcaResults = null;
    this.currentAxisInfo = null;

    // Reset camera and zoom
    this.panOffset.set(0, 0);
    this.zoomLevel = 1.0;
    this.updateCameraPosition();

    // Clear the renderer (force a white frame)
    if (this.renderer) {
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
    }

    // Force garbage collection hint (non-standard, but Chrome respects it)
    if ((window as any).gc) {
      console.log('[Graph2D] Requesting garbage collection...');
      (window as any).gc();
    }

    console.log('[Graph2D] Canvas cleared - memory freed - ready for new project');
  }

  public applyLayout(layoutType: LayoutType): void {
    // Ignore 'none' layout selection
    if (layoutType === 'none') {
      return;
    }

    this.currentLayout = layoutType;
    this.config.useParameterPositioning = false;
    this.clearAxisVisualization();
    this.ui.onLayoutChange(layoutType);

    // If data is loaded but not yet rendered, render it now
    if (this.nodeCount > 0 && this.nodes.length > 0 && !this.pointCloud) {
      this.ui.updateStatus(`Rendering with ${layoutType} layout...`);
      this.renderLoadedData();
      return;
    }

    // If already rendered, just re-layout
    if (this.nodeCount === 0 || !this.pointCloud) {
      this.ui.updateStatus("Load a project first!");
      return;
    }

    this.ui.updateStatus(`Applying ${layoutType} layout...`);
    this.relayoutExistingNodes();
  }

  /**
   * Re-layout existing nodes without regenerating them (preserves API data)
   */
  private async relayoutExistingNodes(): Promise<void> {
    if (!this.pointCloud || this.nodes.length === 0 || !this.geometryToNodesMap) return;

    const count = this.nodes.length;
    const spread = Math.sqrt(count) * 0.5;
    const positions = this.pointCloud.geometry.attributes.position as THREE.BufferAttribute;
    const colors = this.pointCloud.geometry.attributes.color as THREE.BufferAttribute;
    const sizes = this.pointCloud.geometry.attributes.size as THREE.BufferAttribute;
    const alphas = this.pointCloud.geometry.getAttribute('alpha') as THREE.BufferAttribute;

    // Reposition nodes by iterating through geometry points (after deduplication)
    // Each geometry point represents one or more stacked nodes
    for (const [geometryIndex, nodeIndices] of this.geometryToNodesMap.entries()) {
      if (nodeIndices.length === 0) continue;

      // Use the first node in the stack as representative for positioning
      const firstNodeIndex = nodeIndices[0];
      const position = this.calculateNodePosition(firstNodeIndex, count, spread);

      // Update all nodes in this stack with the same position
      for (const nodeIndex of nodeIndices) {
        const nodeData = this.nodes[nodeIndex];
        nodeData.x = position.x;
        nodeData.y = position.y;
      }

      // Update geometry positions buffer
      positions.setXYZ(geometryIndex, position.x, position.y, 0);

      // Check if this geometry should be visible (respecting filters)
      let hasVisibleNode = false;
      for (const nodeIndex of nodeIndices) {
        const node = this.nodes[nodeIndex];
        // Check filter function
        if (this.currentFilterFn && this.currentFilterFn(node)) {
          continue; // Node is filtered out
        }
        hasVisibleNode = true;
        break;
      }

      // Set alpha based on filter visibility
      if (alphas) {
        alphas.setX(geometryIndex, hasVisibleNode ? 1.0 : 0.0);
      }
    }

    // Apply force-directed layout if selected (both 'force' and 'force_directed' use physics simulation)
    if (this.currentLayout === 'force') {
      this.ui.updateStatus('Computing force-directed layout...');
      await this.applyForceDirectedLayoutToBuffer(positions, spread);
    }

    // Update colors and sizes based on connectivity
    // Iterate through geometry points, not nodes
    const colorCache = new Map<number, { r: number; g: number; b: number }>();
    const getColorForDegree = (degree: number): { r: number; g: number; b: number } => {
      const key = Math.min(degree, 20);
      if (!colorCache.has(key)) {
        const hue = key > 0 ? Math.min(0.3, key * 0.05) : 0.6;
        const color = new THREE.Color().setHSL(hue, 0.8, 0.6);
        colorCache.set(key, { r: color.r, g: color.g, b: color.b });
      }
      return colorCache.get(key)!;
    };

    for (const [geometryIndex, nodeIndices] of this.geometryToNodesMap.entries()) {
      if (nodeIndices.length === 0) continue;

      const x = positions.getX(geometryIndex);
      const y = positions.getY(geometryIndex);
      const size = this.calculateNodeSize(x, y, spread);

      // Use first node's degree as representative
      const degree = (this.nodes[nodeIndices[0]] as any).degree || 0;
      const adjustedSize = size + (degree * 0.2);

      const color = getColorForDegree(degree);
      colors.setXYZ(geometryIndex, color.r, color.g, color.b);
      sizes.setX(geometryIndex, adjustedSize);
    }

    // Mark buffers as needing update
    positions.needsUpdate = true;
    colors.needsUpdate = true;
    sizes.needsUpdate = true;
    if (alphas) {
      alphas.needsUpdate = true;
    }

    // Redraw edges if visible
    if (STATUS) console.log(`[relayoutExistingNodes] Before edge redraw: ${this.edges.length} edges, edgesVisible: ${this.config.edgesVisible}, edgeLines exists: ${!!this.edgeLines}`);
    if (this.config.edgesVisible && this.edges.length > 0) {
      this.clearEdgeLines();
      this.createEdgeLines();
      this.updateArrowScales();
    } else {
      if (STATUS) console.log(`[relayoutExistingNodes] Skipping edge creation (edgesVisible=${this.config.edgesVisible}, edges.length=${this.edges.length})`);
    }

    this.resetView();

    // Update overlap labels after layout
    this.updateOverlapLabels();

    this.ui.updateStatus(`${this.currentLayout} layout applied`);
  }

  /**
   * Apply force-directed layout directly to position buffer
   * Works with deduplicated geometry - operates on geometry points, not individual nodes
   */
  private async applyForceDirectedLayoutToBuffer(positions: THREE.BufferAttribute, spread: number): Promise<void> {
    if (!this.geometryToNodesMap) return;

    const geometryCount = this.geometryToNodesMap.size;
    const positionsArray = positions.array as Float32Array;

    // Create a temporary array sized for the deduplicated geometry
    const tempPositions = new Float32Array(geometryCount * 3);

    // Copy current positions to temp array
    for (let i = 0; i < geometryCount * 3; i++) {
      tempPositions[i] = positionsArray[i];
    }

    // Call force-directed layout on the deduplicated geometry
    this.applyForceDirectedLayout(geometryCount, tempPositions, spread);

    // Copy back to the actual buffer
    for (let i = 0; i < geometryCount * 3; i++) {
      positionsArray[i] = tempPositions[i];
    }

    // Update node data with final positions (iterate through geometry map)
    for (const [geometryIndex, nodeIndices] of this.geometryToNodesMap.entries()) {
      const x = positionsArray[geometryIndex * 3];
      const y = positionsArray[geometryIndex * 3 + 1];

      // Update all nodes in this stack with the same position
      for (const nodeIndex of nodeIndices) {
        this.nodes[nodeIndex].x = x;
        this.nodes[nodeIndex].y = y;
      }
    }
  }

  private startAnimationLoop(): void {
    this.animate();
  }

  private animate(): void {
    requestAnimationFrame(() => this.animate());

    const startTime = performance.now();
    this.animationTime += 0.016;

    // Auto rotation effect
    if (this.autoRotate && this.pointCloud) {
      this.pointCloud.rotation.z += 0.01;
    }

    // Pulse effect
    if (this.pulseEffect && this.pointCloud) {
      const scale = 1 + Math.sin(this.animationTime * 3) * 0.1;
      const material = this.pointCloud.material as THREE.PointsMaterial;
      material.size = scale;
    }

    // Update arrow scales to maintain constant screen-space size
    this.updateArrowScales();

    // Render scene
    if (this.renderer) {
      try {
        this.renderer.render(this.scene, this.camera);
        
        const renderTime = performance.now() - startTime;
        this.lastRenderTime = renderTime;
        
        // Log performance occasionally
        if (Math.random() < 0.001) { // ~0.1% of frames
          this.ui.logPerformance(this.nodeCount, renderTime);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Render error';
        this.ui.updateStatus("Render error: " + message);
      }
    }
  }

  private onMouseMove(event: MouseEvent): void {
    if (!this.renderer || !this.pointCloud || !this.tooltipElement) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();

    // For orthographic camera with screen-space points (sizeAttenuation: false),
    // we need a much smaller threshold since the points are rendered as pixels
    // Calculate threshold based on view size and screen size
    const viewHeight = this.camera.top - this.camera.bottom;
    const screenHeight = window.innerHeight;

    // Each pixel represents this many world units
    const worldUnitsPerPixel = viewHeight / screenHeight;

    // Node visual size is 9 pixels, so we want a threshold of about 4.5 pixels (half)
    const nodeRadiusPixels = 5; // Slightly larger than visual radius for easier hovering
    const threshold = nodeRadiusPixels * worldUnitsPerPixel;

    raycaster.params.Points = { threshold: threshold };
    raycaster.setFromCamera(mouse, this.camera);

    const intersects = raycaster.intersectObject(this.pointCloud);

    if (intersects.length > 0) {
      const geometryIndex = intersects[0].index;
      if (geometryIndex !== undefined && geometryIndex !== this.hoveredNodeIndex) {
        this.hoveredNodeIndex = geometryIndex;

        // Get all node indices at this geometry position (handles stacked nodes)
        const nodeIndices = this.geometryToNodesMap.get(geometryIndex) || [geometryIndex];
        this.showNodeTooltip(nodeIndices, event.clientX, event.clientY);
      } else if (geometryIndex !== undefined) {
        // Update tooltip position
        this.updateTooltipPosition(event.clientX, event.clientY);
      }
    } else {
      this.hideNodeTooltip();
    }
  }

  private showNodeTooltip(stackedNodes: number[], x: number, y: number): void {
    if (!this.tooltipElement || stackedNodes.length === 0) {
      return;
    }

    // Filter to only show visible nodes (matching the logic used in updateOverlapLabels)
    const visibleStackedNodes: number[] = [];

    for (const idx of stackedNodes) {
      if (idx >= this.nodes.length) continue;

      const node = this.nodes[idx];

      // Check filter function
      if (this.currentFilterFn && this.currentFilterFn(node)) {
        continue; // Node is filtered out
      }

      // If using parameter positioning, check if node is visible for current parameters
      if (this.config.useParameterPositioning && this.config.parameterXAxis && this.config.parameterYAxis) {
        if (!this.isNodeVisibleForParameters(node, this.config.parameterXAxis, this.config.parameterYAxis)) {
          continue; // Node doesn't meet visibility criteria
        }
      }

      // Node is visible
      visibleStackedNodes.push(idx);
    }

    if (visibleStackedNodes.length === 0) {
      return; // No visible nodes in this stack
    }

    const firstNodeIndex = visibleStackedNodes[0];
    const node = this.nodes[firstNodeIndex];

    // Get parameter labels from PRISM API
    const paramLabels = this.prismAPI.getAllParameterLabels();

    // Build tooltip content
    let html = '';

    if (visibleStackedNodes.length > 1) {
      // Limit to showing first 5 stacked nodes to avoid huge tooltips
      const nodesToShow = visibleStackedNodes.slice(0, 5);
      const remainingCount = visibleStackedNodes.length - nodesToShow.length;

      html += `<strong>${visibleStackedNodes.length} Stacked Nodes${remainingCount > 0 ? ` (showing ${nodesToShow.length})` : ''}</strong>`;
      html += `<div style="display: flex; gap: 12px; margin-top: 8px; flex-wrap: wrap;">`;

      // Show each stacked node in a column
      nodesToShow.forEach((stackedIndex) => {
        const stackedNode = this.nodes[stackedIndex];
        html += `<div style="flex: 1; min-width: 200px; max-width: 250px; padding: 8px; background: rgba(230, 230, 230, 0.5); border-radius: 3px;">`;
        html += `<strong style="font-size: 11px; border-bottom: 1px solid #bbb;">Node #${stackedNode.id}</strong>`;
        html += `<div class="property">Pos: (${stackedNode.x.toFixed(2)}, ${stackedNode.y.toFixed(2)})</div>`;

        if ((stackedNode as any).degree !== undefined) {
          html += `<div class="property">Connections: ${(stackedNode as any).degree}</div>`;
        }

        html += `<div class="property">Cluster: ${stackedNode.cluster}</div>`;
        html += `<div class="property">Type: ${stackedNode.type}</div>`;

        // Show parameters
        html += `<div style="margin-top: 4px; padding-top: 4px; border-top: 1px solid #bbb;">`;
        Object.keys(stackedNode.parameters).forEach((category: string) => {
          html += `<div class = "property-category">${category}`;
          Object.keys(stackedNode.parameters[category]).forEach((parameter: string) => {
            const value = stackedNode.parameters[category][parameter];
            html += `<div class="property">${parameter}: ${value.toString()}</div>`;
          });
          html += `</div>`;
        });
        html += `</div>`;
        html += `</div>`;
      });

      html += `</div>`;
    } else {
      // Single node tooltip (original format)
      html = `<strong>Node #${node.id}</strong>`;
      html += `<div class="property">Position: (${node.x.toFixed(2)}, ${node.y.toFixed(2)})</div>`;

      if ((node as any).degree !== undefined) {
        html += `<div class="property">Connections: ${(node as any).degree}</div>`;
      }

      html += `<div class="property">Cluster: ${node.cluster}</div>`;
      html += `<div class="property">Type: ${node.type}</div>`;

      // Show parameters
      html += `<div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid #ddd;">`;
      Object.keys(node.parameters).forEach((category: string) => {
        html += `<div class = "property-category">${category}`;
        Object.keys(node.parameters[category]).forEach((parameter: string) => {
          const value = node.parameters[category][parameter];
          html += `<div class="property">${parameter}: ${value.toString()}</div>`;
        });
        html += `</div>`;
      });
      html += `</div>`;
    }

    this.tooltipElement.innerHTML = html;
    this.tooltipElement.classList.remove('hidden');
    this.updateTooltipPosition(x, y);
  }

  private updateTooltipPosition(x: number, y: number): void {
    if (!this.tooltipElement) return;

    // Position tooltip offset from cursor
    const offsetX = 15;
    const offsetY = 15;

    this.tooltipElement.style.left = `${x + offsetX}px`;
    this.tooltipElement.style.top = `${y + offsetY}px`;
  }

  private hideNodeTooltip(): void {
    if (!this.tooltipElement) return;

    this.hoveredNodeIndex = -1;
    this.tooltipElement.classList.add('hidden');
  }

  private onNodeClick(event: MouseEvent): void {
    if (!this.renderer || !this.pointCloud) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.camera);

    const intersects = raycaster.intersectObject(this.pointCloud);
    if (intersects.length > 0) {
      const geometryIndex = intersects[0].index;
      if (geometryIndex !== undefined) {
        // Get all node indices at this geometry position (handles stacked nodes)
        const stackedIndices = this.geometryToNodesMap.get(geometryIndex) || [geometryIndex];

        // Support multi-select with Ctrl/Cmd key
        const multiSelect = event.ctrlKey || event.metaKey;

        // Select all stacked nodes
        this.selectNodes(stackedIndices, multiSelect);
      }
    }
  }

  /**
   * Find all nodes stacked at the same position as the given node
   */
  private findStackedNodes(nodeIndex: number): number[] {
    if (nodeIndex < 0 || nodeIndex >= this.nodes.length) return [];

    const node = this.nodes[nodeIndex];
    const epsilon = 0.001; // Same tolerance as tooltip
    const stackedNodes: number[] = [nodeIndex];

    // Only search through nodes if we have a reasonable number
    const maxNodesToSearch = Math.min(this.nodes.length, 10000);
    for (let i = 0; i < maxNodesToSearch; i++) {
      if (i === nodeIndex) continue;

      const otherNode = this.nodes[i];
      if (!otherNode) continue;

      const dx = Math.abs(otherNode.x - node.x);
      const dy = Math.abs(otherNode.y - node.y);

      if (dx < epsilon && dy < epsilon) {
        stackedNodes.push(i);
      }
    }

    return stackedNodes;
  }

  /**
   * Select multiple nodes at once
   */
  private selectNodes(indices: number[], multiSelect: boolean = false): void {
    if (indices.length === 0) return;

    if (!multiSelect) {
      // Single select - clear previous selections
      this.selectedNodeIndices.clear();
    }

    // Add or toggle all indices
    indices.forEach(index => {
      if (this.selectedNodeIndices.has(index)) {
        this.selectedNodeIndices.delete(index);
      } else {
        this.selectedNodeIndices.add(index);
      }
    });

    // Update UI
    this.updateSelectedNodesUI();

    // Update status bar
    if (this.selectedNodeIndices.size === 0) {
      this.ui.updateStatus('No nodes selected');
    } else if (this.selectedNodeIndices.size === 1) {
      const nodeId = this.nodes[Array.from(this.selectedNodeIndices)[0]].id;
      this.ui.updateStatus(`Selected node #${nodeId}`);
    } else {
      const stackMessage = indices.length > 1 ? ` (${indices.length} stacked)` : '';
      this.ui.updateStatus(`Selected ${this.selectedNodeIndices.size} nodes${stackMessage}`);
    }
  }

  /**
   * Select a node by index
   */
  private selectNode(index: number, multiSelect: boolean = false): void {
    if (index < 0 || index >= this.nodes.length) return;

    if (!multiSelect) {
      // Single select - clear previous selections
      this.selectedNodeIndices.clear();
    }

    // Toggle selection if already selected
    if (this.selectedNodeIndices.has(index)) {
      this.selectedNodeIndices.delete(index);
    } else {
      this.selectedNodeIndices.add(index);
    }

    // Update UI
    this.updateSelectedNodesUI();

    // Update status bar
    if (this.selectedNodeIndices.size === 0) {
      this.ui.updateStatus('No nodes selected');
    } else if (this.selectedNodeIndices.size === 1) {
      const node = this.nodes[index];
      this.ui.updateStatus(`Selected node #${node.id}`);
    } else {
      this.ui.updateStatus(`Selected ${this.selectedNodeIndices.size} nodes`);
    }
  }

  /**
   * Deselect a node by index
   */
  private deselectNode(index: number): void {
    this.selectedNodeIndices.delete(index);
    this.updateSelectedNodesUI();

    if (this.selectedNodeIndices.size === 0) {
      this.ui.updateStatus('No nodes selected');
    } else {
      this.ui.updateStatus(`Selected ${this.selectedNodeIndices.size} nodes`);
    }
  }

  /**
   * Clear all selected nodes
   */
  public clearSelection(): void {
    this.selectedNodeIndices.clear();
    this.updateSelectedNodesUI();
    this.ui.updateStatus('Selection cleared');
  }

  /**
   * Select all visible nodes
   */
  public selectAllNodes(): void {
    // Clear existing selection
    this.selectedNodeIndices.clear();

    // Add all nodes to selection
    for (let i = 0; i < this.nodes.length; i++) {
      this.selectedNodeIndices.add(i);
    }

    // Update UI
    this.updateSelectedNodesUI();
    this.ui.updateStatus(`Selected all ${this.selectedNodeIndices.size} nodes`);
  }

  /**
   * Get all selected nodes
   */
  public getSelectedNodes(): NodeData[] {
    return Array.from(this.selectedNodeIndices).map(index => this.nodes[index]);
  }

  /**
   * Remove all transition (t-type) nodes and create direct edges between connected state (s-type) nodes
   */
  public async removeTransitionNodes(): Promise<void> {
    this.ui.updateStatus('Ignoring transition nodes...');
    this.prismAPI.progressIndicator.show({ title: 'Ignoring Transition Nodes' });
    this.prismAPI.progressIndicator.updateProgress(0);
    this.prismAPI.progressIndicator.setStatus('Building node map...');

    try {
      // Build a map of node IDs to their indices for quick lookup
      const nodeIdToIndex = new Map<number | string, number>();
      for (let i = 0; i < this.nodes.length; i++) {
        nodeIdToIndex.set(this.nodes[i].id, i);
      }

      // Find all t-type nodes and build adjacency information
      const tNodeIndices = new Set<number>();
      const edgesByTNode = new Map<number, { from: number, to: number }[]>();

      for (let i = 0; i < this.nodes.length; i++) {
        if (this.nodes[i].type === 't') {
          tNodeIndices.add(i);
          edgesByTNode.set(i, []);
        }
      }

      this.prismAPI.progressIndicator.updateProgress(20);
      this.prismAPI.progressIndicator.setStatus(`Found ${tNodeIndices.size.toLocaleString()} transition nodes, categorizing edges...`);

      // Categorize edges by t-nodes
      for (const edge of this.edges) {
        const fromNode = this.nodes[edge.from];
        const toNode = this.nodes[edge.to];

        if (fromNode && toNode) {
          if (fromNode.type === 't') {
            edgesByTNode.get(edge.from)?.push({ from: edge.from, to: edge.to });
          } else if (toNode.type === 't') {
            edgesByTNode.get(edge.to)?.push({ from: edge.from, to: edge.to });
          }
        }
      }

      this.prismAPI.progressIndicator.updateProgress(40);
      this.prismAPI.progressIndicator.setStatus('Creating new direct edges between state nodes...');

      // Create new edges connecting s-nodes that were connected via t-nodes
      const newEdges: EdgeData[] = [];
      for (const [tNodeIndex, connectedEdges] of edgesByTNode) {
        // Find all s-nodes connected to this t-node
        const connectedSNodes: number[] = [];
        for (const edge of connectedEdges) {
          const otherNodeIndex = edge.from === tNodeIndex ? edge.to : edge.from;
          const otherNode = this.nodes[otherNodeIndex];
          if (otherNode && otherNode.type === 's') {
            connectedSNodes.push(otherNodeIndex);
          }
        }

        // Create edges between all pairs of connected s-nodes
        for (let i = 0; i < connectedSNodes.length; i++) {
          for (let j = i + 1; j < connectedSNodes.length; j++) {
            newEdges.push({
              from: connectedSNodes[i],
              to: connectedSNodes[j]
            });
          }
        }
      }

      this.prismAPI.progressIndicator.updateProgress(60);
      this.prismAPI.progressIndicator.setStatus(`Filtering nodes and edges (${newEdges.length.toLocaleString()} new edges created)...`);

      // Log warning if generating excessive edges
      if (newEdges.length > 100000) {
        console.warn(`[Ignore Transition Nodes] Creating ${newEdges.length.toLocaleString()} new edges - this may take some time`);
      }

      // Filter out t-nodes and edges involving t-nodes
      const filteredNodes = this.nodes.filter(node => node.type === 's');
      const filteredEdges = this.edges.filter(edge => {
        const fromNode = this.nodes[edge.from];
        const toNode = this.nodes[edge.to];
        return fromNode?.type === 's' && toNode?.type === 's';
      });

      // Add new edges (avoid spread operator for large arrays to prevent stack overflow)
      for (const edge of newEdges) {
        filteredEdges.push(edge);
      }

      // Re-index nodes - use the existing nodeIdToIndex map to avoid O(n²) findIndex calls
      const oldIndexToNewIndex = new Map<number, number>();
      for (let i = 0; i < filteredNodes.length; i++) {
        const oldIndex = nodeIdToIndex.get(filteredNodes[i].id);
        if (oldIndex !== undefined) {
          oldIndexToNewIndex.set(oldIndex, i);
        }
        filteredNodes[i].index = i;
      }

      // Update edge indices to match new node indices
      const reindexedEdges = filteredEdges.map(edge => {
        const result: EdgeData = {
          from: oldIndexToNewIndex.get(edge.from) ?? edge.from,
          to: oldIndexToNewIndex.get(edge.to) ?? edge.to
        };
        if (edge.label !== undefined) {
          result.label = edge.label;
        }
        return result;
      });

      this.prismAPI.progressIndicator.updateProgress(80);
      this.prismAPI.progressIndicator.setStatus('Reloading graph with filtered data...');

      // Clear selection and reload graph with filtered data
      this.clearSelection();
      await this.loadGraph('0', filteredNodes, reindexedEdges);

      this.prismAPI.progressIndicator.updateProgress(100);
      this.prismAPI.progressIndicator.hide();
      this.ui.updateStatus(`Ignored ${tNodeIndices.size.toLocaleString()} transition nodes, added ${newEdges.length.toLocaleString()} new edges`);
    } catch (error) {
      console.error('Error ignoring transition nodes:', error);
      this.prismAPI.progressIndicator.hide();
      this.ui.showError('Failed to ignore transition nodes');
    }
  }

  /**
   * Ignore all state (s-type) nodes and create direct edges between connected transition (t-type) nodes
   */
  public async removeStateNodes(): Promise<void> {
    this.ui.updateStatus('Ignoring state nodes...');
    this.prismAPI.progressIndicator.show({ title: 'Ignoring State Nodes' });
    this.prismAPI.progressIndicator.updateProgress(0);
    this.prismAPI.progressIndicator.setStatus('Building node map...');

    try {
      // Build a map of node IDs to their indices for quick lookup
      const nodeIdToIndex = new Map<number | string, number>();
      for (let i = 0; i < this.nodes.length; i++) {
        nodeIdToIndex.set(this.nodes[i].id, i);
      }

      // Find all s-type nodes and build adjacency information
      const sNodeIndices = new Set<number>();
      const edgesBySNode = new Map<number, { from: number, to: number }[]>();

      for (let i = 0; i < this.nodes.length; i++) {
        if (this.nodes[i].type === 's') {
          sNodeIndices.add(i);
          edgesBySNode.set(i, []);
        }
      }

      this.prismAPI.progressIndicator.updateProgress(20);
      this.prismAPI.progressIndicator.setStatus(`Found ${sNodeIndices.size.toLocaleString()} state nodes, categorizing edges...`);

      // Categorize edges by s-nodes
      for (const edge of this.edges) {
        const fromNode = this.nodes[edge.from];
        const toNode = this.nodes[edge.to];

        if (fromNode && toNode) {
          if (fromNode.type === 's') {
            edgesBySNode.get(edge.from)?.push({ from: edge.from, to: edge.to });
          } else if (toNode.type === 's') {
            edgesBySNode.get(edge.to)?.push({ from: edge.from, to: edge.to });
          }
        }
      }

      this.prismAPI.progressIndicator.updateProgress(40);
      this.prismAPI.progressIndicator.setStatus('Creating new direct edges between transition nodes...');

      // Create new edges connecting t-nodes that were connected via s-nodes
      const newEdges: EdgeData[] = [];
      for (const [sNodeIndex, connectedEdges] of edgesBySNode) {
        // Find all t-nodes connected to this s-node
        const connectedTNodes: number[] = [];
        for (const edge of connectedEdges) {
          const otherNodeIndex = edge.from === sNodeIndex ? edge.to : edge.from;
          const otherNode = this.nodes[otherNodeIndex];
          if (otherNode && otherNode.type === 't') {
            connectedTNodes.push(otherNodeIndex);
          }
        }

        // Create edges between all pairs of connected t-nodes
        for (let i = 0; i < connectedTNodes.length; i++) {
          for (let j = i + 1; j < connectedTNodes.length; j++) {
            newEdges.push({
              from: connectedTNodes[i],
              to: connectedTNodes[j]
            });
          }
        }
      }

      this.prismAPI.progressIndicator.updateProgress(60);
      this.prismAPI.progressIndicator.setStatus(`Filtering nodes and edges (${newEdges.length.toLocaleString()} new edges created)...`);

      // Log warning if generating excessive edges
      if (newEdges.length > 100000) {
        console.warn(`[Ignore State Nodes] Creating ${newEdges.length.toLocaleString()} new edges - this may take some time`);
      }

      // Filter out s-nodes and edges involving s-nodes
      const filteredNodes = this.nodes.filter(node => node.type === 't');
      const filteredEdges = this.edges.filter(edge => {
        const fromNode = this.nodes[edge.from];
        const toNode = this.nodes[edge.to];
        return fromNode?.type === 't' && toNode?.type === 't';
      });

      // Add new edges (avoid spread operator for large arrays to prevent stack overflow)
      for (const edge of newEdges) {
        filteredEdges.push(edge);
      }

      // Re-index nodes - use the existing nodeIdToIndex map to avoid O(n²) findIndex calls
      const oldIndexToNewIndex = new Map<number, number>();
      for (let i = 0; i < filteredNodes.length; i++) {
        const oldIndex = nodeIdToIndex.get(filteredNodes[i].id);
        if (oldIndex !== undefined) {
          oldIndexToNewIndex.set(oldIndex, i);
        }
        filteredNodes[i].index = i;
      }

      // Update edge indices to match new node indices
      const reindexedEdges = filteredEdges.map(edge => {
        const result: EdgeData = {
          from: oldIndexToNewIndex.get(edge.from) ?? edge.from,
          to: oldIndexToNewIndex.get(edge.to) ?? edge.to
        };
        if (edge.label !== undefined) {
          result.label = edge.label;
        }
        return result;
      });

      this.prismAPI.progressIndicator.updateProgress(80);
      this.prismAPI.progressIndicator.setStatus('Reloading graph with filtered data...');

      // Clear selection and reload graph with filtered data
      this.clearSelection();
      await this.loadGraph('0', filteredNodes, reindexedEdges);

      this.prismAPI.progressIndicator.updateProgress(100);
      this.prismAPI.progressIndicator.hide();
      this.ui.updateStatus(`Ignored ${sNodeIndices.size.toLocaleString()} state nodes, added ${newEdges.length.toLocaleString()} new edges`);
    } catch (error) {
      console.error('Error ignoring state nodes:', error);
      this.prismAPI.progressIndicator.hide();
      this.ui.showError('Failed to ignore state nodes');
    }
  }

  /**
   * Update the visible node counter in the navbar
   */
  private updateVisibleNodeCounter(visibleCount: number): void {
    const counterElement = document.getElementById('visible-node-counter');
    if (counterElement) {
      counterElement.textContent = `${visibleCount.toLocaleString()} node${visibleCount !== 1 ? 's' : ''} visible`;
    }
  }

  /**
   * Update the UI to display selected nodes
   * For large selections (>100), this processes nodes progressively in the background
   */
  private updateSelectedNodesUI(): void {
    const listElement = document.getElementById('selected-nodes-list');
    const counterElement = document.getElementById('selected-nodes-counter');

    if (!listElement) return;

    const selectedCount = this.selectedNodeIndices.size;

    // Update counter immediately
    if (counterElement) {
      counterElement.textContent = `${selectedCount} node${selectedCount !== 1 ? 's' : ''} selected`;
    }

    // Clear current content
    listElement.innerHTML = '';

    if (selectedCount === 0) {
      listElement.innerHTML = '<div class="no-selection-message">Click on a node to select it</div>';
      return;
    }

    // For large selections, use progressive rendering
    if (selectedCount > 100) {
      this.updateSelectedNodesUIProgressive(listElement, counterElement);
    } else {
      // For small selections, render immediately
      this.updateSelectedNodesUIImmediate(listElement);
    }
  }

  /**
   * Immediate rendering for small selections
   */
  private updateSelectedNodesUIImmediate(listElement: HTMLElement): void {
    const fragment = document.createDocumentFragment();

    for (const index of this.selectedNodeIndices) {
      const node = this.nodes[index];
      if (!node) continue;

      const nodeDiv = this.createSelectedNodeElement(node, index);
      fragment.appendChild(nodeDiv);
    }

    listElement.appendChild(fragment);
  }

  /**
   * Progressive rendering for large selections (>100 nodes)
   * Updates counter every 100 nodes and yields to browser between batches
   */
  private async updateSelectedNodesUIProgressive(listElement: HTMLElement, counterElement: HTMLElement | null): Promise<void> {
    const indices = Array.from(this.selectedNodeIndices);
    const totalCount = indices.length;
    const BATCH_SIZE = 100;
    let processedCount = 0;

    // Show loading message
    listElement.innerHTML = '<div class="no-selection-message">Loading selected nodes...</div>';

    // Process in batches
    for (let i = 0; i < indices.length; i += BATCH_SIZE) {
      const batch = indices.slice(i, Math.min(i + BATCH_SIZE, indices.length));
      const fragment = document.createDocumentFragment();

      // Process batch
      for (const index of batch) {
        const node = this.nodes[index];
        if (!node) continue;

        const nodeDiv = this.createSelectedNodeElement(node, index);
        fragment.appendChild(nodeDiv);
      }

      // Clear loading message on first batch
      if (i === 0) {
        listElement.innerHTML = '';
      }

      // Append batch
      listElement.appendChild(fragment);

      processedCount += batch.length;

      // Update counter
      if (counterElement) {
        counterElement.textContent = `${totalCount} node${totalCount !== 1 ? 's' : ''} selected (${processedCount} shown)`;
      }

      // Yield to browser to keep UI responsive
      if (i + BATCH_SIZE < indices.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // Final counter update
    if (counterElement) {
      counterElement.textContent = `${totalCount} node${totalCount !== 1 ? 's' : ''} selected`;
    }
  }

  /**
   * Create a DOM element for a selected node
   * Optimized to minimize string concatenation and use efficient DOM methods
   */
  private createSelectedNodeElement(node: NodeData, index: number): HTMLDivElement {
    const nodeDiv = document.createElement('div');
    nodeDiv.className = 'selected-node-item';
    nodeDiv.dataset.index = index.toString();

    // Build HTML using array join for better performance
    const htmlParts: string[] = [
      '<div class="selected-node-header">',
      `Node #${node.id}`,
      `<button class="selected-node-remove" data-index="${index}">×</button>`,
      '</div>',
      `<div class="selected-node-property">Position: (${node.x.toFixed(2)}, ${node.y.toFixed(2)})</div>`,
      `<div class="selected-node-property">Cluster: ${node.cluster}</div>`,
      `<div class="selected-node-property">Type: ${node.type}</div>`
    ];

    // Add parameters by category (optimized)
    for (const category in node.parameters) {
      if (!node.parameters.hasOwnProperty(category)) continue;

      htmlParts.push(`<div class="selected-node-category">${category}</div>`);
      htmlParts.push('<div class="selected-node-params-container">');

      const params = node.parameters[category];
      for (const parameter in params) {
        if (!params.hasOwnProperty(parameter)) continue;
        const value = params[parameter];
        htmlParts.push(`<span class="selected-node-param-tag">${parameter}: ${value.toString()}</span>`);
      }

      htmlParts.push('</div>');
    }

    nodeDiv.innerHTML = htmlParts.join('');

    // Add click handler for remove button
    const removeBtn = nodeDiv.querySelector('.selected-node-remove') as HTMLButtonElement;
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deselectNode(index);
      });
    }

    // Add click handler to focus on node
    nodeDiv.addEventListener('click', () => {
      this.focusOnNode(index);
    });

    return nodeDiv;
  }

  /**
   * Focus camera on a specific node
   */
  private focusOnNode(index: number): void {
    if (index < 0 || index >= this.nodes.length) return;

    const node = this.nodes[index];
    this.panOffset.set(-node.x, -node.y);
    this.updateCameraPosition();
    this.ui.updateStatus(`Focused on node #${node.id}`);
  }

  // Public API methods
  public toggleRotation(): void {
    this.autoRotate = !this.autoRotate;
    this.ui.updateStatus(`Auto-rotation ${this.autoRotate ? 'ON' : 'OFF'}`);
  }

  public togglePulse(): void {
    this.pulseEffect = !this.pulseEffect;
    this.ui.updateStatus(`Pulse effect ${this.pulseEffect ? 'ON' : 'OFF'}`);

    if (!this.pulseEffect && this.pointCloud) {
      const material = this.pointCloud.material as THREE.PointsMaterial;
      material.size = 1.0;
    }
  }

  public toggleLOD(): void {
    this.config.lodEnabled = !this.config.lodEnabled;
    this.ui.updateStatus(`LOD ${this.config.lodEnabled ? 'enabled' : 'disabled'}`);
  }

  public toggleEdges(): void {
    this.config.edgesVisible = !this.config.edgesVisible;

    if (this.config.edgesVisible && this.edges.length > 0) {
      // Clear existing edges first to avoid duplicates
      if (this.edgeLines) {
        this.clearEdgeLines();
      }
      this.createEdgeLines();
      this.updateArrowScales();
      this.ui.updateStatus('Edges visible');
    } else {
      this.clearEdgeLines();
      this.ui.updateStatus('Edges hidden');
    }
  }

  public toggleClusters(): void {
    this.config.clusterMode = !this.config.clusterMode;
    this.ui.updateStatus(`Cluster mode ${this.config.clusterMode ? 'enabled' : 'disabled'}`);
  }

  /**
   * Open table view with given nodes in a new tab
   * This is a reusable function that can be called from anywhere
   */
  public openTableView(nodes: NodeData[]): void {
    if (nodes.length === 0) {
      this.ui.updateStatus('No nodes to display in table view');
      return;
    }

    // Store nodes in localStorage for the new tab to access
    localStorage.setItem('tableViewNodes', JSON.stringify(nodes));

    // Open table view in new tab
    window.open('table-view.html', '_blank');

    this.ui.updateStatus(`Opening table view with ${nodes.length} nodes`);
  }

  /**
   * Update PCA eigenvectors display with color coding and arrows
   */
  private updatePCAEigenvectorsDisplay(): void {
    const displayElement = document.getElementById('pca-eigenvectors-display');
    const contentElement = document.getElementById('pca-eigenvectors-content');

    if (!displayElement || !contentElement) return;

    if (!this.pcaResults) {
      displayElement.classList.add('hidden');
      return;
    }

    // Show the display
    displayElement.classList.remove('hidden');

    // Build HTML for each principal component
    let html = '';

    this.pcaResults.eigenvectors.forEach((pc, pcIndex) => {
      const pcName = `PC${pcIndex + 1}`;
      const variance = (pc.eigenvalue / this.pcaResults!.eigenvectors.reduce((sum, v) => sum + v.eigenvalue, 0) * 100).toFixed(1);

      html += `<div class="pca-component">`;
      html += `<div class="pca-component-title">
        <span>${pcName}</span>
        <span class="pca-variance">${variance}% variance</span>
      </div>`;
      html += `<div class="pca-parameter-list">`;

      // Create array of {name, loading} and sort by absolute loading value
      const loadings = this.pcaResults!.parameterNames.map((name, i) => ({
        name: name,
        loading: pc.eigenvector[i]
      }));

      // Sort by absolute value descending
      loadings.sort((a, b) => Math.abs(b.loading) - Math.abs(a.loading));

      // Show ALL parameters (no threshold filtering)
      loadings.forEach(item => {
        const absLoading = Math.abs(item.loading);
        const isPositive = item.loading > 0;
        const cssClass = isPositive ? 'positive' : 'negative';
        const sign = isPositive ? '+' : '−';

        // Use big plus/minus icons
        const iconSvg = isPositive
          ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3 8h10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>';

        // Extract parameter name only (remove category prefix if present)
        const paramName = item.name.includes('::') ? item.name.split('::')[1] : item.name;

        html += `<div class="pca-parameter-item ${cssClass}">
          <span class="pca-icon">${iconSvg}</span>
          <span class="pca-parameter-name">${paramName}</span>
          <span class="pca-loading-value">${item.loading.toFixed(3)}</span>
        </div>`;
      });

      html += `</div></div>`;
    });

    contentElement.innerHTML = html;

    if (STATUS) console.log('[Graph2D] Updated PCA eigenvectors display');
  }

  public toggleGrid(): void {
    this.gridLinesVisible = !this.gridLinesVisible;

    // Update axis visualization to show/hide grid
    if (this.currentAxisInfo) {
      this.updateAxisVisualization();
    }

    this.ui.updateStatus(`Grid lines ${this.gridLinesVisible ? 'visible' : 'hidden'}`);
  }

  public resetView(): void {
    // If using parameter positioning, reset to fitted view
    if (this.config.useParameterPositioning && this.currentAxisInfo) {
      const { spread } = this.currentAxisInfo;
      this.fitViewToParameterRange(spread);
      this.ui.updateStatus("View reset to fit all nodes");
    } else {
      // Standard reset for non-parameter layouts
      // Calculate the actual extent of nodes to fit them in view
      if (this.nodes.length > 0) {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;

        this.nodes.forEach(node => {
          minX = Math.min(minX, node.x);
          maxX = Math.max(maxX, node.x);
          minY = Math.min(minY, node.y);
          maxY = Math.max(maxY, node.y);
        });

        const rangeX = maxX - minX;
        const rangeY = maxY - minY;
        const maxRange = Math.max(rangeX, rangeY);

        // Calculate zoom to fit all nodes with some padding
        const viewSize = 50; // Base camera size
        const padding = 1.2; // 20% padding
        this.zoomLevel = (viewSize * 2) / (maxRange * padding);

        //if (STATUS) console.log(`[resetView] Node extent: X[${minX.toFixed(1)}, ${maxX.toFixed(1)}], Y[${minY.toFixed(1)}, ${maxY.toFixed(1)}]`);
        //if (STATUS) console.log(`[resetView] Setting zoom to ${this.zoomLevel.toFixed(3)}x to fit range ${maxRange.toFixed(1)}`);
      } else {
        this.zoomLevel = 1.0;
      }

      this.panOffset.set(0, 0);
      this.updateCameraPosition();
      this.ui.updateZoomDisplay(this.zoomLevel);
      this.ui.updateStatus("View reset to fit all nodes");
    }
  }

  // Determine how many decimal places to show based on the interval
  private getDecimalPlaces(interval: number): number {
    if (interval === 0) return 0;

    // For intervals like 2.5, 0.25, 0.025, we need enough decimals
    // Get the power of 10
    const log10 = Math.log10(Math.abs(interval));
    const power = Math.floor(log10);

    // Normalize to [1, 10)
    const normalized = interval / Math.pow(10, power);

    // If normalized is 2.5, we need one decimal place regardless of power
    // Examples:
    // - interval = 2.5 (power=0, normalized=2.5) -> need 1 decimal
    // - interval = 0.25 (power=-1, normalized=2.5) -> need 2 decimals
    // - interval = 25 (power=1, normalized=2.5) -> need 0 decimals
    // - interval = 1 (power=0, normalized=1) -> need 0 decimals
    // - interval = 0.1 (power=-1, normalized=1) -> need 1 decimal

    const hasDecimalMultiplier = Math.abs(normalized - 2.5) < 0.01; // Check if it's 2.5

    if (hasDecimalMultiplier) {
      // For 2.5 multipliers, need one extra decimal
      return Math.max(0, -power + 1);
    } else {
      // For 1 and 5 multipliers
      return Math.max(0, -power);
    }
  }

  // Calculate a single nice world-space interval
  // Only uses 1, 2.5, 5 × 10^n (e.g., 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, etc.)
  private calculateNiceParameterInterval(visibleRange: number): number {
    // Handle edge cases
    if (!isFinite(visibleRange) || visibleRange <= 0) {
      console.error(`[calculateNiceParameterInterval] Invalid visibleRange: ${visibleRange}`);
      return 1; // Return a safe default
    }

    // Target approximately 10-20 grid squares across the visible range
    const targetDivisions = 15;
    const roughInterval = visibleRange / targetDivisions;

    // Handle very small ranges
    if (roughInterval <= 0 || !isFinite(roughInterval)) {
      console.error(`[calculateNiceParameterInterval] Invalid roughInterval: ${roughInterval}`);
      return 1;
    }

    // Find the power of 10
    const log10 = Math.log10(roughInterval);
    const powerOf10 = Math.floor(log10);
    const magnitude = Math.pow(10, powerOf10);

    // Normalize to range [1, 10)
    const normalized = roughInterval / magnitude;

    // Choose from allowed values: 1, 2.5, 5, 10
    let multiplier: number;
    if (normalized <= 1.5) {
      multiplier = 1;
    } else if (normalized <= 3.5) {
      multiplier = 2.5;
    } else if (normalized <= 7.5) {
      multiplier = 5;
    } else {
      // Use 10, which is 1 × 10^(powerOf10 + 1)
      return Math.pow(10, powerOf10 + 1);
    }

    return multiplier * magnitude;
  }

  // Calculate nice round intervals for axis labels
  // Only uses whole and half powers of 10: 0.5, 1, 2.5, 5, 10, 25, 50, 100, etc.
  // Currently unused but kept for potential future use
  // @ts-expect-error - Unused method kept for future use
  private calculateNiceInterval(min: number, max: number, targetDivisions: number = 15): number[] {
    const range = max - min;
    if (range === 0) return [min];

    // Calculate rough interval
    const roughInterval = range / (targetDivisions - 1);

    // Find the base magnitude (power of 10)
    const log10 = Math.log10(roughInterval);
    const baseMagnitude = Math.floor(log10);

    // Allowed multipliers: 0.5, 1, 2.5, 5 (repeating pattern)
    // These correspond to: 0.5×10^n, 1×10^n, 2.5×10^n, 5×10^n, 10×10^n (which is 1×10^(n+1))
    // const allowedMultipliers = [0.5, 1, 2.5, 5];

    // Normalize the rough interval to be between 0.5 and 5
    const normalized = roughInterval / Math.pow(10, baseMagnitude);

    // Find the best multiplier
    let niceNormalized: number;
    if (normalized < 0.75) {
      niceNormalized = 0.5;
    } else if (normalized < 1.75) {
      niceNormalized = 1;
    } else if (normalized < 3.5) {
      niceNormalized = 2.5;
    } else if (normalized < 7.5) {
      niceNormalized = 5;
    } else {
      // Jump to next power of 10
      niceNormalized = 1;
      return this.calculateNiceInterval(min, max, Math.ceil(targetDivisions / 2));
    }

    const magnitude = Math.pow(10, baseMagnitude);
    const niceInterval = niceNormalized * magnitude;

    // Generate nice tick values
    const minTick = Math.ceil(min / niceInterval) * niceInterval;
    const maxTick = Math.floor(max / niceInterval) * niceInterval;

    const ticks: number[] = [];
    for (let tick = minTick; tick <= maxTick; tick += niceInterval) {
      // Handle floating point precision issues
      // Round to avoid floating point errors
      const roundedTick = Math.round(tick / (magnitude * 0.01)) * (magnitude * 0.01);
      ticks.push(roundedTick);
    }

    // Ensure we have at least 2 ticks
    if (ticks.length < 2) {
      return [min, max];
    }

    return ticks;
  }

  /**
   * Detect overlapping nodes and create labels for them
   * Uses the geometryToNodesMap which was created during point cloud deduplication
   */
  private updateOverlapLabels(): void {
    // Clear existing overlap labels
    this.clearOverlapLabels();

    if (!this.nodes.length || !this.geometryToNodesMap || this.geometryToNodesMap.size === 0 || !this.pointCloud) return;

    // Get alpha buffer to check if nodes are visible
    const alphas = this.pointCloud.geometry.getAttribute('alpha') as THREE.BufferAttribute;
    if (!alphas) return;

    // Create labels for positions with multiple nodes
    this.overlapLabelsGroup = new THREE.Group();

    // Performance optimization: Skip overlap labels for very large datasets
    const geometryMapSize = this.geometryToNodesMap.size;
    const MAX_GEOMETRY_FOR_LABELS = 1000000; // Increased from 50k to 1M for better large dataset support

    if (geometryMapSize > MAX_GEOMETRY_FOR_LABELS) {
      console.warn(`[updateOverlapLabels] Skipping overlap labels for performance (${geometryMapSize.toLocaleString()} geometry points > ${MAX_GEOMETRY_FOR_LABELS.toLocaleString()} limit)`);
      return;
    }

    const startTime = performance.now();
    let processedCount = 0;
    const TIMEOUT_MS = 5000; // 5 second timeout to prevent freeze (increased for large datasets)
    let timedOut = false;

    // Use the existing geometryToNodesMap which already has deduplicated positions
    this.geometryToNodesMap.forEach((nodeIndices, geometryIndex) => {
      // Performance check: stop if taking too long (check every 10000 points to reduce overhead)
      if (++processedCount % 10000 === 0) {
        const elapsed = performance.now() - startTime;
        if (elapsed > TIMEOUT_MS) {
          // Only log once when first timing out
          if (!timedOut && PERFORMANCE) {
            console.warn(`[updateOverlapLabels] Timed out after processing ${processedCount}/${geometryMapSize} geometry points (${elapsed.toFixed(0)}ms)`);
          }
          timedOut = true;
          return;
        }
      }

      // Check if this geometry point is visible (alpha > 0)
      if (alphas.getX(geometryIndex) === 0) {
        return; // Skip invisible nodes
      }

      // Count only nodes that are actually visible considering:
      // 1. Filter function (if any)
      // 2. Parameter positioning (if active) - nodes must have valid parameter values and correct type
      let visibleCount = 0;

      // Count all visible nodes
      for (const idx of nodeIndices) {
        const node = this.nodes[idx];

        // Check filter function
        if (this.currentFilterFn && this.currentFilterFn(node)) {
          continue; // Node is filtered out
        }

        // If using parameter positioning, check if node is visible for current parameters
        if (this.config.useParameterPositioning && this.config.parameterXAxis && this.config.parameterYAxis) {
          if (!this.isNodeVisibleForParameters(node, this.config.parameterXAxis, this.config.parameterYAxis)) {
            continue; // Node doesn't meet visibility criteria
          }
        }

        // Node is visible
        visibleCount++;
      }

      if (visibleCount > 1) {
        const displayText = visibleCount.toString();

        // Create label sprite
        const { texture, aspectRatio } = this.createOverlapCountTexture(displayText);
        const spriteMaterial = new THREE.SpriteMaterial({
          map: texture,
          transparent: true,
          opacity: 0.95,
          sizeAttenuation: false, // Use screen-space sizing
          depthTest: false // Always render on top
        });
        const sprite = new THREE.Sprite(spriteMaterial);
        sprite.raycast = () => {}; // Disable raycasting for labels

        // Get current position from geometry buffer (handles both regular and parameter positioning)
        const positions = this.pointCloud?.geometry.attributes.position as THREE.BufferAttribute;
        if (!positions) {
          console.warn('[updateOverlapLabels] Position buffer not found');
          return;
        }
        const posX = positions.getX(geometryIndex);
        const posY = positions.getY(geometryIndex);

        // Calculate screen-space offset: 1vh up, 1vw right
        // Convert viewport units to normalized device coordinates
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        const offsetYViewport = viewportHeight * 0.01; // 1vh
        const offsetXViewport = viewportWidth * 0.01; // 1vw

        // Convert to world space based on current camera view
        const viewHeight = this.camera.top - this.camera.bottom;
        const viewWidth = this.camera.right - this.camera.left;
        const offsetY = (offsetYViewport / viewportHeight) * viewHeight;
        const offsetX = (offsetXViewport / viewportWidth) * viewWidth;

        sprite.position.set(posX + offsetX, posY + offsetY, 1);

        // Scale sprite to constant screen size (independent of zoom)
        // For sizeAttenuation=false with orthographic camera, we need to scale by viewport size
        // to maintain constant screen-space size regardless of zoom
        // Target: 20 pixels high on screen
        const targetPixelHeight = 20;
        const labelHeight = (targetPixelHeight / viewportHeight) * viewHeight;
        const labelWidth = labelHeight * aspectRatio; // Maintain aspect ratio
        sprite.scale.set(labelWidth, labelHeight, 1);

        // Store geometry index and aspect ratio for position updates
        sprite.userData = { geometryIndex: geometryIndex, aspectRatio: aspectRatio };

        if (this.overlapLabelsGroup) {
          this.overlapLabelsGroup.add(sprite);
        }
      }
    });

    const elapsed = performance.now() - startTime;
    if (PERFORMANCE && elapsed > 100) {
      console.log(`[updateOverlapLabels] Processing took ${elapsed.toFixed(0)}ms for ${processedCount}/${geometryMapSize} geometry points`);
    }

    if (this.overlapLabelsGroup && this.overlapLabelsGroup.children.length > 0) {
      this.scene.add(this.overlapLabelsGroup);
      if (STATUS) console.log(`Created ${this.overlapLabelsGroup.children.length} overlap labels${timedOut ? ' (timed out, some labels may be missing)' : ''}`);
    } else {
      if (STATUS) console.log('No overlapping nodes found');
    }

    if (timedOut) {
      console.warn('[updateOverlapLabels] Label creation timed out - too many overlapping nodes. Consider filtering or using different parameters.');
    }
  }

  /**
   * Create a texture for overlap count labels
   * Returns both the texture and its aspect ratio to prevent stretching
   */
  private createOverlapCountTexture(text: string): { texture: THREE.CanvasTexture; aspectRatio: number } {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;

    // Much smaller font for tiny labels
    const fontSize = 80;
    context.font = `bold ${fontSize}px Arial`;
    const metrics = context.measureText(text);
    const textWidth = metrics.width;

    // Set canvas size with minimal padding - no minimum width to avoid squishing
    const padding = 8;
    canvas.width = textWidth + padding * 2;
    canvas.height = 96;

    // Calculate aspect ratio (width / height)
    const aspectRatio = canvas.width / canvas.height;

    // Clear background (transparent)
    context.clearRect(0, 0, canvas.width, canvas.height);

    // Draw text - black, no background
    context.font = `bold ${fontSize}px Arial`;
    context.fillStyle = 'rgba(0, 0, 0, 1.0)'; // Black text
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return { texture, aspectRatio };
  }

  /**
   * Update overlap label positions and scales without recreating them
   */
  private updateOverlapLabelPositions(): void {
    if (!this.overlapLabelsGroup) return;

    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const offsetYViewport = viewportHeight * 0.01; // 1vh
    const offsetXViewport = viewportWidth * 0.01; // 1vw

    // Convert to world space based on current camera view
    const viewHeight = this.camera.top - this.camera.bottom;
    const viewWidth = this.camera.right - this.camera.left;
    const offsetY = (offsetYViewport / viewportHeight) * viewHeight;
    const offsetX = (offsetXViewport / viewportWidth) * viewWidth;

    // Use fixed screen size for labels (matches creation size)
    // Target: 20 pixels high on screen
    const targetPixelHeight = 20;
    const labelHeight = (targetPixelHeight / viewportHeight) * viewHeight;

    // Get position buffer if using parameter positioning
    const positions = this.pointCloud?.geometry.attributes.position as THREE.BufferAttribute;

    // Update each sprite's position and scale
    this.overlapLabelsGroup.children.forEach((sprite) => {
      if (sprite instanceof THREE.Sprite && sprite.userData.geometryIndex !== undefined) {
        const geometryIndex = sprite.userData.geometryIndex as number;

        // Get current position from geometry buffer (works for both regular and parameter positioning)
        let posX: number, posY: number;
        if (positions) {
          posX = positions.getX(geometryIndex);
          posY = positions.getY(geometryIndex);
        } else {
          // Fallback to node position (deprecated path)
          const nodeIndices = this.geometryToNodesMap.get(geometryIndex);
          if (nodeIndices && nodeIndices.length > 0) {
            const node = this.nodes[nodeIndices[0]];
            posX = node.x;
            posY = node.y;
          } else {
            return; // Skip if no position available
          }
        }

        // Update position with viewport offsets
        sprite.position.set(posX + offsetX, posY + offsetY, 1);

        // Use stored aspect ratio to maintain proper proportions
        const aspectRatio = sprite.userData.aspectRatio as number || 1.0;
        const labelWidth = labelHeight * aspectRatio;
        sprite.scale.set(labelWidth, labelHeight, 1);
      }
    });
  }

  /**
   * Clear overlap labels
   */
  private clearOverlapLabels(): void {
    if (this.overlapLabelsGroup) {
      this.overlapLabelsGroup.traverse((child) => {
        if (child instanceof THREE.Sprite) {
          if (child.material instanceof THREE.SpriteMaterial) {
            if (child.material.map) {
              child.material.map.dispose();
            }
            child.material.dispose();
          }
        }
      });
      this.scene.remove(this.overlapLabelsGroup);
      this.overlapLabelsGroup = null;
    }
  }

  // Create a canvas-based texture for text labels
  private createTextTexture(text: string, fontSize: number = 48): { texture: THREE.CanvasTexture; aspectRatio: number } {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;

    // Set font to measure text width
    context.font = `${fontSize}px monospace`;
    const metrics = context.measureText(text);
    const textWidth = metrics.width;

    // Set canvas size with padding
    const padding = 20;
    canvas.width = Math.max(256, textWidth + padding * 2);
    canvas.height = 128;

    // Calculate aspect ratio (width / height)
    const aspectRatio = canvas.width / canvas.height;

    // Configure text rendering (need to set font again after resizing canvas)
    context.fillStyle = 'rgba(0, 0, 0, 0)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = `${fontSize}px monospace`;
    context.fillStyle = 'rgba(0, 0, 0, 0.9)'; // Dark text for light background
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    // Draw text
    context.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return { texture, aspectRatio };
  }

  // Create axis labels in the 3D scene
  private createAxisVisualization(
    xParamIndex: string,
    yParamIndex: string,
    minValues: { x: number; y: number },
    maxValues: { x: number; y: number },
    spread: number
  ): void {
    // Store axis info for dynamic updates
    this.currentAxisInfo = {
      xParamIndex,
      yParamIndex,
      minValues,
      maxValues,
      spread
    };

    // Create the visualization
    this.updateAxisVisualization();
  }

  // Update axis visualization based on current viewport
  private updateAxisVisualization(): void {
    if (!this.currentAxisInfo) return;

    const { xParamIndex, yParamIndex, minValues, maxValues, spread } = this.currentAxisInfo;

    // Remove existing axis group
    this.clearAxisVisualization();

    // Create new group for axis elements
    this.axisGroup = new THREE.Group();

    // Create axis lines with constant screen-space width
    const axisLinesMaterial = new THREE.LineBasicMaterial({
      color: 0x000000,
      opacity: 0.8,
      transparent: true,
      linewidth: 1
    });

    // Get viewport bounds in world coordinates
    const viewLeft = this.camera.left;
    const viewRight = this.camera.right;
    const viewBottom = this.camera.bottom;
    const viewTop = this.camera.top;

    // Calculate label size to position axis with enough space for labels
    const viewHeight = viewTop - viewBottom;
    const labelHeight = viewHeight * 0.08; // 8% of viewport height

    // AXIS POSITIONING: Position axes at minimum parameter values when visible,
    // otherwise snap to screen edges for visibility
    const axisOffset = viewHeight * 0.01;

    // Calculate world positions of minimum parameter values
    const minXWorldPos = this.paramToWorld(minValues.x, minValues.x, maxValues.x, spread);
    const minYWorldPos = this.paramToWorld(minValues.y, minValues.y, maxValues.y, spread);
    const maxXWorldPos = this.paramToWorld(maxValues.x, minValues.x, maxValues.x, spread);
    const maxYWorldPos = this.paramToWorld(maxValues.y, minValues.y, maxValues.y, spread);

    // Y-axis positioning: Use minValues.x position if visible, otherwise snap to viewLeft
    let yAxisX: number;
    if (minXWorldPos >= viewLeft && minXWorldPos <= viewRight) {
      // Minimum X value is visible on screen, position Y-axis there
      yAxisX = minXWorldPos;
    } else {
      // Minimum X value is off-screen, snap Y-axis to left edge
      yAxisX = viewLeft;
    }

    // X-axis positioning: Use minValues.y position if visible, otherwise snap to viewBottom
    let xAxisY: number;
    if (minYWorldPos >= viewBottom && minYWorldPos <= viewTop) {
      // Minimum Y value is visible on screen, position X-axis there
      xAxisY = minYWorldPos;
    } else {
      // Minimum Y value is off-screen, snap X-axis to bottom edge
      xAxisY = viewBottom;
    }
    // X-axis: horizontal line starting from Y-axis position (minValues.x) extending right
    const xAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(yAxisX, xAxisY, 0),  // Start at Y-axis
      new THREE.Vector3(maxXWorldPos, xAxisY, 0)
    ]);
    const xAxisLine = new THREE.Line(xAxisGeometry, axisLinesMaterial);
    this.axisGroup.add(xAxisLine);

    // Y-axis: vertical line starting from X-axis position (minValues.y) extending up
    const yAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(yAxisX, xAxisY, 0),  // Start at X-axis
      new THREE.Vector3(yAxisX, maxYWorldPos, 0)
    ]);
    const yAxisLine = new THREE.Line(yAxisGeometry, axisLinesMaterial);
    this.axisGroup.add(yAxisLine);

    // Create grid lines material (more visible)
    const gridLinesMaterial = new THREE.LineBasicMaterial({
      color: 0x666666,
      opacity: 0.3,
      transparent: true,
      linewidth: 1
    });

    // Create labels along X-axis
    // Calculate label scale based on viewport size to maintain constant screen size
    // viewHeight already calculated above
    const labelScale = labelHeight; // Use the same label height calculated above

    // Calculate visible X range in parameter space
    // Convert viewport bounds to parameter values using helper functions
    const visibleMinX = this.worldToParam(viewLeft, minValues.x, maxValues.x, spread);
    const visibleMaxX = this.worldToParam(viewRight, minValues.x, maxValues.x, spread);
    const visibleMinY = this.worldToParam(viewBottom, minValues.y, maxValues.y, spread);
    const visibleMaxY = this.worldToParam(viewTop, minValues.y, maxValues.y, spread);

    // Calculate INDEPENDENT parameter intervals for X and Y axes
    // Calculate the visible parameter ranges
    const visibleXParamRange = visibleMaxX - visibleMinX;
    const visibleYParamRange = visibleMaxY - visibleMinY;


    // Calculate nice intervals independently for each axis
    // This allows each axis to choose its own optimal step size
    const xParamInterval = this.calculateNiceParameterInterval(visibleXParamRange);
    const yParamInterval = this.calculateNiceParameterInterval(visibleYParamRange);


    // Generate X-axis ticks starting from 0 (or nearest multiple below visible range)
    const xTicks: number[] = [];
    // Find the world position of parameter value 0
    // const zeroWorldX = this.paramToWorld(0, minValues.x, maxValues.x, spread);

    // Safety check: ensure interval is valid
    if (!isFinite(xParamInterval) || xParamInterval <= 0) {
      //console.error(`[Axis Debug] Invalid xParamInterval: ${xParamInterval}`);
      return;
    }

    // Find starting tick that's a multiple of xParamInterval and at or before visible range
    // Start from 0 and go in both directions
    const xStartMultiplier = Math.floor(visibleMinX / xParamInterval);
    const xEndMultiplier = Math.ceil(visibleMaxX / xParamInterval);


    // Safety check: prevent infinite loops
    const maxTicks = 1000;
    if (xEndMultiplier - xStartMultiplier > maxTicks) {
      //console.error(`[Axis Debug] Too many X ticks would be generated: ${xEndMultiplier - xStartMultiplier}`);
      return;
    }

    for (let mult = xStartMultiplier; mult <= xEndMultiplier; mult++) {
      const val = mult * xParamInterval;
      // Only include ticks >= minValues.x (where Y-axis is positioned)
      if (val >= minValues.x && val <= maxValues.x + xParamInterval * 0.01) {
        xTicks.push(val);
      }
    }

    for (const value of xTicks) {
      // Calculate world position based on parameter value using helper function
      const xPos = this.paramToWorld(value, minValues.x, maxValues.x, spread);

      // Only show labels that are within viewport and at/right of Y-axis
      if (xPos < yAxisX || xPos > viewRight) continue;

      // Determine decimal places based on interval size
      // For intervals like 0.25, 2.5, we need appropriate decimal places
      const decimals = this.getDecimalPlaces(xParamInterval);

      // Create text sprite for label
      const { texture, aspectRatio } = this.createTextTexture(value.toFixed(decimals), 64);
      const spriteMaterial = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0.95,
        sizeAttenuation: false
      });
      const sprite = new THREE.Sprite(spriteMaterial);
      // Position label above viewport bottom edge to ensure visibility
      // labelScale * 1.0 positions the label center 8% above bottom edge
      sprite.position.set(xPos, xAxisY + labelScale * 0.3, 0);
      // Scale proportionally to aspect ratio to avoid distortion
      const baseHeight = labelScale * 0.6;
      sprite.scale.set(baseHeight * aspectRatio, baseHeight, 1);
      this.axisGroup.add(sprite);

      // Add tick mark on the x-axis line (taller for better visibility)
      const tickGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(xPos, xAxisY, 0),
        new THREE.Vector3(xPos, xAxisY + labelScale * 0.2, 0)
      ]);
      const tickLine = new THREE.Line(tickGeometry, axisLinesMaterial);
      this.axisGroup.add(tickLine);

      // Add vertical grid line if enabled (from X-axis upward)
      if (this.gridLinesVisible) {
        const gridGeometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(xPos, xAxisY, 0),  // Start at X-axis
          new THREE.Vector3(xPos, viewTop, 0)
        ]);
        const gridLine = new THREE.Line(gridGeometry, gridLinesMaterial);
        this.axisGroup.add(gridLine);
      }
    }

    // Generate Y-axis ticks starting from 0 (or nearest multiple below visible range)
    const yTicks: number[] = [];

    // Safety check: ensure interval is valid
    if (!isFinite(yParamInterval) || yParamInterval <= 0) {
      //console.error(`[Axis Debug] Invalid yParamInterval: ${yParamInterval}`);
      return;
    }

    // Start from 0 and go in both directions
    const yStartMultiplier = Math.floor(visibleMinY / yParamInterval);
    const yEndMultiplier = Math.ceil(visibleMaxY / yParamInterval);


    // Safety check: prevent infinite loops
    if (yEndMultiplier - yStartMultiplier > maxTicks) {
      //console.error(`[Axis Debug] Too many Y ticks would be generated: ${yEndMultiplier - yStartMultiplier}`);
      return;
    }

    for (let mult = yStartMultiplier; mult <= yEndMultiplier; mult++) {
      const val = mult * yParamInterval;
      // Only include ticks >= minValues.y (where X-axis is positioned)
      if (val >= minValues.y && val <= maxValues.y + yParamInterval * 0.01) {
        yTicks.push(val);
      }
    }

    for (const value of yTicks) {
      // Calculate world position based on parameter value using helper function
      const yPos = this.paramToWorld(value, minValues.y, maxValues.y, spread);

      // Only show labels that are within viewport and at/above X-axis
      if (yPos < xAxisY || yPos > viewTop) continue;

      // Determine decimal places based on interval size
      const decimals = this.getDecimalPlaces(yParamInterval);

      // Create text sprite for label
      const { texture, aspectRatio } = this.createTextTexture(value.toFixed(decimals), 64);
      const spriteMaterial = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0.95,
        sizeAttenuation: false
      });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.position.set(yAxisX + labelScale * 0.4, yPos, 0); // Position to the right of the axis line
      // Scale proportionally to aspect ratio to avoid distortion
      const baseHeight = labelScale * 0.6;
      sprite.scale.set(baseHeight * aspectRatio, baseHeight, 1);
      this.axisGroup.add(sprite);

      // Add tick mark on the y-axis line
      const tickGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(yAxisX, yPos, 0),
        new THREE.Vector3(yAxisX + labelScale * 0.2, yPos, 0)
      ]);
      const tickLine = new THREE.Line(tickGeometry, axisLinesMaterial);
      this.axisGroup.add(tickLine);

      // Add horizontal grid line if enabled
      if (this.gridLinesVisible) {
        const gridGeometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(viewLeft, yPos, 0),
          new THREE.Vector3(viewRight, yPos, 0)
        ]);
        const gridLine = new THREE.Line(gridGeometry, gridLinesMaterial);
        this.axisGroup.add(gridLine);
      }
    }

    // Add axis titles positioned at screen edges
    // Get parameter names from API metadata
    const paramLabels = this.prismAPI.getAllParameterLabels();
    const xParamLabel = xParamIndex;
    const yParamLabel = yParamIndex;

    // X-axis title: centered horizontally at bottom of screen
    const { texture: xTitleTexture, aspectRatio: xTitleAspect } = this.createTextTexture(xParamLabel, 64);
    const xTitleMaterial = new THREE.SpriteMaterial({
      map: xTitleTexture,
      transparent: true,
      opacity: 1.0,
      sizeAttenuation: false
    });
    const xTitle = new THREE.Sprite(xTitleMaterial);
    const xTitleX = (yAxisX + maxXWorldPos) / 2; // Center of screen
    xTitle.position.set(xTitleX, xAxisY + labelScale * -0.4, 0);
    // Scale proportionally to aspect ratio
    const xTitleHeight = labelScale * 0.7;
    xTitle.scale.set(xTitleHeight * xTitleAspect, xTitleHeight, 1);
    this.axisGroup.add(xTitle);

    // Y-axis title: centered vertically at left of screen
    const { texture: yTitleTexture, aspectRatio: yTitleAspect } = this.createTextTexture(yParamLabel, 64);
    const yTitleMaterial = new THREE.SpriteMaterial({
      map: yTitleTexture,
      transparent: true,
      opacity: 1.0,
      sizeAttenuation: false
    });
    if (STATUS) console.log(`x: ${xParamLabel}, y: ${yParamLabel}`);
    const yTitle = new THREE.Sprite(yTitleMaterial);
    const yTitleY = (xAxisY + maxYWorldPos) / 2; // Center of screen
    yTitle.position.set(yAxisX + labelScale * -2.0, yTitleY, 0);
    // Scale proportionally to aspect ratio
    const yTitleHeight = labelScale * 0.7;
    yTitle.scale.set(yTitleHeight * yTitleAspect, yTitleHeight, 1);
    this.axisGroup.add(yTitle);

    // Add the axis group to the scene
    this.scene.add(this.axisGroup);
  }

  /**
   * Update parameter view label to show which node types are currently visible
   */
  private updateParameterViewLabel(visibleNodeTypes: Set<'s' | 't'>): void {
    this.ui.updateParameterViewLabel(visibleNodeTypes);
  }

  // Clear axis visualization
  private clearAxisVisualization(): void {
    if (this.axisGroup) {
      // Dispose of all geometries, materials, and textures
      this.axisGroup.traverse((child) => {
        if (child instanceof THREE.Line) {
          child.geometry.dispose();
          if (child.material instanceof THREE.Material) {
            child.material.dispose();
          }
        } else if (child instanceof THREE.Sprite) {
          if (child.material instanceof THREE.SpriteMaterial) {
            if (child.material.map) {
              child.material.map.dispose();
            }
            child.material.dispose();
          }
        }
      });
      this.scene.remove(this.axisGroup);
      this.axisGroup = null;
    }
  }

  /**
   * Apply color parameter to nodes without changing their positions
   */
  public applyColorParameter(colorParamIndex: string): void {
    if (!this.pointCloud || this.nodes.length === 0) return;

    if (colorParamIndex === "" || colorParamIndex === "-1") {
      this.ui.updateStatus('No color parameter selected');
      return;
    }

    this.ui.updateStatus(`Applying color parameter ${colorParamIndex}...`);

    const colors = this.pointCloud.geometry.attributes.color as THREE.BufferAttribute;

    // Handle special "__type__" color option
    if (colorParamIndex === "__type__") {
      // Color by node type: s = blue, t = grey, init = red
      // Use geometryToNodesMap to properly map geometry indices
      for (const [geometryIndex, nodeIndices] of this.geometryToNodesMap.entries()) {
        if (nodeIndices.length === 0) continue;

        // Use the first node in the stack as representative
        const node = this.nodes[nodeIndices[0]];

        // Check if node has init==true in Atomic Propositions
        const initValue = node.parameters?.['Atomic Propositions']?.['init'];
        const isInit = initValue === true || initValue === 'true' || initValue === 1;

        if (isInit) {
          // Red for init nodes
          colors.setXYZ(geometryIndex, 1.0, 0.0, 0.0);
        } else if (node.type === 's') {
          // Blue for state nodes
          colors.setXYZ(geometryIndex, 0.2, 0.4, 1.0);
        } else if (node.type === 't') {
          // Grey for transition nodes
          colors.setXYZ(geometryIndex, 0.5, 0.5, 0.5);
        } else {
          // Default color for unknown types
          colors.setXYZ(geometryIndex, 1.0, 1.0, 1.0);
        }
      }
      colors.needsUpdate = true;
      this.renderer?.render(this.scene, this.camera);
      this.ui.updateStatus(`Colored by node type (s=blue, t=grey, init=red)`);
      return;
    }

    // Find min/max values for color mapping
    let minColor = Infinity, maxColor = -Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const colorValueRaw = PrismAPI.getParameterValue(node, colorParamIndex);
      const colorValue = this.convertParameterValueToNumber(colorValueRaw);
      if (!isNaN(colorValue) && isFinite(colorValue)) {
        minColor = Math.min(minColor, colorValue);
        maxColor = Math.max(maxColor, colorValue);
      }
    }

    // Check if we found valid color values
    if (!isFinite(minColor) || !isFinite(maxColor)) {
      console.warn(`[Graph2D] No valid numeric values found for color parameter: ${colorParamIndex}`);
      // Fall back to grey for all nodes
      for (let i = 0; i < this.nodes.length; i++) {
        colors.setXYZ(i, 0.5, 0.5, 0.5);
      }
      colors.needsUpdate = true;
      this.ui.updateStatus(`No valid values for color parameter ${colorParamIndex}`);
      return;
    }

    // Apply colors
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const colorValueRaw = PrismAPI.getParameterValue(node, colorParamIndex);
      const colorValue = this.convertParameterValueToNumber(colorValueRaw);
      const color = this.getColorFromParameter(colorValue, minColor, maxColor);
      colors.setXYZ(i, color.r, color.g, color.b);
    }

    colors.needsUpdate = true;
    this.ui.updateStatus(`Colored by parameter ${colorParamIndex}`);
  }

  public rearrangeByParameters(xParam: string, yParam: string, colorParamIndex: string = ""): void {
    // Validation
    if (this.nodes.length === 0) {
      this.ui.updateStatus("Load a project first!");
      return;
    }

    if (STATUS) console.log(`[Parameter View] Rebuilding visualization for parameters ${xParam} and ${yParam}...`);
    this.ui.updateStatus(`Rearranging nodes by parameters ${xParam} and ${yParam}...`);

    // Store configuration for rebuild
    this.config.parameterXAxis = xParam;
    this.config.parameterYAxis = yParam;
    this.config.parameterColorAxis = colorParamIndex;
    this.config.useParameterPositioning = true;
    this.currentLayout = 'grid'; // Use grid as base for parameter view

    // BUGFIX: Clear and rebuild point cloud to ensure correct stack assignments
    // The old approach of updating positions in-place caused nodes with different
    // parameter values to be incorrectly grouped in the same stack.
    // By rebuilding from scratch, we ensure geometryToNodesMap is correctly
    // constructed based on the actual parameter-based positions.
    this.clearPointCloud();

    // Re-render with new parameters
    // This will recalculate all positions and rebuild geometryToNodesMap correctly
    this.renderLoadedData();

    // Apply color parameter after rendering if specified
    if (colorParamIndex && colorParamIndex !== "" && colorParamIndex !== "-1") {
      this.applyColorParameter(colorParamIndex);
    }
  }

  /**
   * Adjust camera view to fit the parameter-based node layout
   */
  private fitViewToParameterRange(spread: number): void {
    // Reset pan to center
    this.panOffset.set(0, 0);

    // Calculate zoom level to fit all nodes in view with some padding
    // spread represents half the data range, so we need to show 2*spread in each dimension
    // Add 20% padding
    const dataSize = spread * 2 * 1.2;

    // The default viewSize is 50, so we want to zoom such that dataSize fits in view
    const aspect = window.innerWidth / window.innerHeight;
    const viewHeight = 100; // Base view size (2 * 50)
    const viewWidth = viewHeight * aspect;

    // Choose zoom to fit the larger dimension
    const requiredZoomX = viewWidth / dataSize;
    const requiredZoomY = viewHeight / dataSize;
    this.zoomLevel = Math.min(requiredZoomX, requiredZoomY);

    // Clamp to config limits
    this.zoomLevel = Math.max(
      this.config.minZoom,
      Math.min(this.config.maxZoom, this.zoomLevel)
    );

    this.updateCameraPosition();
    this.ui.updateZoomDisplay(this.zoomLevel);
  }

  public resetToLayoutMode(): void {
    this.config.useParameterPositioning = false;
    this.clearAxisVisualization();
    this.ui.updateStatus("Reset to original layout mode");

    // Hide parameter view label
    const label = document.getElementById('param-view-display-label');
    if (label) {
      label.classList.add('hidden');
    }

    // Update counter to show all nodes are visible again
    this.updateVisibleNodeCounter(this.nodes.length);

    // Optionally regenerate layout
    if (this.nodes.length > 0) {
      this.applyLayout(this.currentLayout);
    }
  }

  public changeColors(): void {
    if (!this.pointCloud) return;

    const colors = this.pointCloud.geometry.attributes.color as THREE.BufferAttribute;
    const count = colors.count;

    this.ui.updateStatus("Randomizing colors...");

    for (let i = 0; i < count; i++) {
      const hue = Math.random();
      const color = new THREE.Color().setHSL(hue, 0.8, 0.6);
      colors.setXYZ(i, color.r, color.g, color.b);
    }

    colors.needsUpdate = true;
    this.ui.updateStatus("Colors randomized");
  }

  public exportImage(): void {
    if (!this.renderer) return;

    try {
      const link = document.createElement('a');
      link.download = `2d-graph-${this.nodeCount}-nodes.png`;
      link.href = this.renderer.domElement.toDataURL();
      link.click();
      this.ui.updateStatus("Image exported");
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Export failed';
      this.ui.showError(message);
    }
  }

  public onWindowResize(): void {
    if (!this.renderer) return;

    const aspect = window.innerWidth / window.innerHeight;
    const viewSize = 50 / this.zoomLevel;

    // For 1:1 aspect ratio, use the same scale for both X and Y
    if (aspect > 1) {
      // Wider than tall - expand horizontally
      this.camera.left = -viewSize * aspect + this.panOffset.x;
      this.camera.right = viewSize * aspect + this.panOffset.x;
      this.camera.top = viewSize + this.panOffset.y;
      this.camera.bottom = -viewSize + this.panOffset.y;
    } else {
      // Taller than wide - expand vertically
      this.camera.left = -viewSize + this.panOffset.x;
      this.camera.right = viewSize + this.panOffset.x;
      this.camera.top = viewSize / aspect + this.panOffset.y;
      this.camera.bottom = -viewSize / aspect + this.panOffset.y;
    }

    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    // Update axes if they exist
    if (this.currentAxisInfo) {
      this.updateAxisVisualization();
    }

    // Update overlap label positions for new window size
    if (this.overlapLabelsGroup) {
      this.updateOverlapLabelPositions();
    }
  }


  // New method for loading PRISM projects
  public async loadPrismProject(projectId: string): Promise<void> {
    this.ui.updateStatus(`Loading PRISM project: ${projectId}...`);
    this.ui.disableButtons();

    try {
      // Clear existing state when switching projects
      this.clearPointCloud();
      this.clearEdgeLines();
      this.clearSelection(); // Clear selected nodes
      this.nodes = [];
      this.edges = [];

      // Fetch PRISM project data
      const graphData = await this.prismAPI.fetchSimpleGraph(projectId);

      this.nodes = graphData.nodes;
      this.edges = graphData.edges;

      // Parameters are now extracted from PRISM API data
      // No need to generate random parameters anymore

      const nodeCount = this.nodes.length;

      // Create geometry arrays
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(nodeCount * 3);
      const colors = new Float32Array(nodeCount * 3);
      const sizes = new Float32Array(nodeCount);

      // Generate layout using existing method
      await this.generateLayout(nodeCount, positions, colors, sizes);

      // Create edge lines if edges are visible
      if (this.config.edgesVisible) {
        this.createEdgeLines();
        this.updateArrowScales();
      }

      // Create point cloud
      await this.createPointCloud(geometry, positions, colors, sizes);

      // Update state
      this.nodeCount = nodeCount;
      this.ui.updateNodeCount(nodeCount);
      this.resetView();

      // Update parameter selection dropdowns with actual parameter names
      const paramLabels = this.prismAPI.getAllParameterLabels();
      this.ui.updateParameterSelections(paramLabels);

      // Apply default type-based coloring
      this.applyColorParameter('__type__');

      // Update overlap labels
      this.updateOverlapLabels();

      // Update model info display
      this.ui.updateModelInfo(projectId, nodeCount, this.edges.length);

      this.ui.updateStatus(`Loaded PRISM project "${projectId}": ${nodeCount.toLocaleString()} nodes, ${this.edges.length.toLocaleString()} edges`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load PRISM project';
      this.ui.showError(message);
      this.ui.clearModelInfo();
    } finally {
      this.ui.enableButtons();
    }
  }

  // Method to update API base URL
  public updatePrismAPIUrl(newUrl: string): void {
    this.prismAPI.updateBaseUrl(newUrl);
    this.ui.updateStatus(`API URL updated to: ${newUrl}`);
  }

  // Method to check API health
  public async checkAPIHealth(): Promise<boolean> {
    return await this.prismAPI.healthCheck();
  }

  // Cleanup method
  public dispose(): void {
    this.clearPointCloud();
    this.clearAxisVisualization();
    this.clearOverlapLabels();

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }

    this.ui.dispose();
    this.projectManager.dispose();
    this.nodes = [];
  }

  // Getters for debugging and monitoring
  public getNodeCount(): number {
    return this.nodeCount;
  }

  public getGeometryPointCount(): number {
    return this.geometryToNodesMap.size;
  }

  /**
   * Debug method to check if geometry points match expectations
   */
  public validateGeometryMapping(): {valid: boolean, details: string} {
    if (!this.pointCloud) {
      return {valid: false, details: 'No point cloud exists'};
    }

    const geometryPoints = this.pointCloud.geometry.attributes.position.count;
    const mapSize = this.geometryToNodesMap.size;
    const totalNodesInMap = Array.from(this.geometryToNodesMap.values())
      .reduce((sum, nodeList) => sum + nodeList.length, 0);

    if (geometryPoints !== mapSize) {
      return {
        valid: false,
        details: `Mismatch: ${geometryPoints} geometry points but ${mapSize} entries in map`
      };
    }

    if (totalNodesInMap !== this.nodes.length) {
      return {
        valid: false,
        details: `Mismatch: ${totalNodesInMap} nodes in map but ${this.nodes.length} actual nodes`
      };
    }

    return {
      valid: true,
      details: `✓ ${geometryPoints} geometry points, ${totalNodesInMap} nodes correctly mapped`
    };
  }

  public getConfig(): Readonly<GraphConfig> {
    return { ...this.config };
  }

  public getLastRenderTime(): number {
    return this.lastRenderTime;
  }

  /**
   * Update the size of node points in the visualization
   * @param size The new point size (1-18)
   */
  public setNodePointSize(size: number): void {
    if (!this.pointCloud) {
      console.warn('[Graph2D] Cannot set node point size: no point cloud exists');
      return;
    }

    const material = this.pointCloud.material as THREE.ShaderMaterial;
    if (material.uniforms && material.uniforms.pointSize) {
      material.uniforms.pointSize.value = size;
      material.needsUpdate = true;
      if (DEBUG) console.log(`[Graph2D] Node point size set to: ${size}`);
    }
  }

  /**
   * Update the font size of stack overlap labels
   * @param fontSize The new font size (20-140)
   */
  public setStackLabelSize(fontSize: number): void {
    if (!this.overlapLabelsGroup || this.overlapLabelsGroup.children.length === 0) {
      console.warn('[Graph2D] Cannot set label size: no overlap labels exist');
      return;
    }

    // Recreate all overlap labels with new font size
    this.recreateOverlapLabelsWithFontSize(fontSize);

    if (DEBUG) console.log(`[Graph2D] Stack label size set to: ${fontSize}`);
  }

  /**
   * Recreate overlap labels with a new font size
   * This method properly extracts the geometryIndex from existing labels,
   * recalculates the visible counts, and recreates labels while maintaining
   * compatibility with updateOverlapLabelPositions()
   * @param fontSize The new font size
   */
  private recreateOverlapLabelsWithFontSize(fontSize: number): void {
    if (!this.overlapLabelsGroup) {
      console.warn('[Graph2D] No overlap labels to recreate');
      return;
    }

    // Extract geometry indices from existing labels
    const geometryIndices = new Set<number>();
    this.overlapLabelsGroup.children.forEach((sprite) => {
      if (sprite instanceof THREE.Sprite && sprite.userData.geometryIndex !== undefined) {
        geometryIndices.add(sprite.userData.geometryIndex as number);
      }
    });

    if (geometryIndices.size === 0) {
      console.warn('[Graph2D] No valid geometry indices found in existing labels');
      return;
    }

    // Clear existing labels (this sets overlapLabelsGroup to null and removes from scene)
    this.clearOverlapLabels();

    // Recreate the overlap labels group
    this.overlapLabelsGroup = new THREE.Group();

    // Get necessary data for label creation
    const positions = this.pointCloud?.geometry.attributes.position as THREE.BufferAttribute;
    const alphas = this.pointCloud?.geometry.getAttribute('alpha') as THREE.BufferAttribute;
    if (!positions || !alphas) {
      console.warn('[Graph2D] Cannot recreate labels: missing position or alpha buffers');
      return;
    }

    // Calculate viewport offsets
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const offsetYViewport = viewportHeight * 0.01; // 1vh
    const offsetXViewport = viewportWidth * 0.01; // 1vw

    const viewHeight = this.camera.top - this.camera.bottom;
    const viewWidth = this.camera.right - this.camera.left;
    const offsetY = (offsetYViewport / viewportHeight) * viewHeight;
    const offsetX = (offsetXViewport / viewportWidth) * viewWidth;

    // Target: 20 pixels high on screen (same as original)
    const targetPixelHeight = 20;
    const labelHeight = (targetPixelHeight / viewportHeight) * viewHeight;

    // Recreate labels for each geometry index
    geometryIndices.forEach((geometryIndex) => {
      // Check if this geometry point is still visible
      if (alphas.getX(geometryIndex) === 0) {
        return; // Skip invisible nodes
      }

      // Recalculate visible count from geometryToNodesMap
      const nodeIndices = this.geometryToNodesMap.get(geometryIndex);
      if (!nodeIndices || nodeIndices.length === 0) {
        return;
      }

      // Count visible nodes (same logic as updateOverlapLabels)
      let visibleCount = 0;
      for (const idx of nodeIndices) {
        const node = this.nodes[idx];

        // Check filter function
        if (this.currentFilterFn && this.currentFilterFn(node)) {
          continue; // Node is filtered out
        }

        // If using parameter positioning, check if node is visible for current parameters
        if (this.config.useParameterPositioning && this.config.parameterXAxis && this.config.parameterYAxis) {
          if (!this.isNodeVisibleForParameters(node, this.config.parameterXAxis, this.config.parameterYAxis)) {
            continue; // Node doesn't meet visibility criteria
          }
        }

        visibleCount++;
      }

      // Only create label if multiple nodes are visible
      if (visibleCount > 1) {
        const posX = positions.getX(geometryIndex);
        const posY = positions.getY(geometryIndex);

        // Create texture with custom font size
        const { texture, aspectRatio } = this.createOverlapCountTextureWithSize(visibleCount.toString(), fontSize);
        const spriteMaterial = new THREE.SpriteMaterial({
          map: texture,
          transparent: true,
          opacity: 0.95,
          sizeAttenuation: false, // Use screen-space sizing
          depthTest: false // Always render on top
        });

        const sprite = new THREE.Sprite(spriteMaterial);
        sprite.raycast = () => {}; // Disable raycasting for labels

        sprite.position.set(posX + offsetX, posY + offsetY, 1);

        const labelWidth = labelHeight * aspectRatio;
        sprite.scale.set(labelWidth, labelHeight, 1);

        // Store userData in the same format as original updateOverlapLabels
        // This ensures compatibility with updateOverlapLabelPositions()
        sprite.userData = { geometryIndex: geometryIndex, aspectRatio: aspectRatio };

        if (this.overlapLabelsGroup) {
          this.overlapLabelsGroup.add(sprite);
        }
      }
    });

    // Add the group back to the scene
    if (this.overlapLabelsGroup && this.overlapLabelsGroup.children.length > 0) {
      this.scene.add(this.overlapLabelsGroup);
      if (DEBUG) console.log(`[Graph2D] Recreated ${this.overlapLabelsGroup.children.length} overlap labels with font size ${fontSize}`);
    } else {
      if (DEBUG) console.log('[Graph2D] No overlap labels needed after recreation');
    }
  }

  /**
   * Create a texture for overlap count labels with a specific font size
   * @param text The text to display
   * @param fontSize The font size to use
   * @returns texture and aspect ratio
   */
  private createOverlapCountTextureWithSize(text: string, fontSize: number): { texture: THREE.CanvasTexture; aspectRatio: number } {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;

    context.font = `bold ${fontSize}px Arial`;
    const metrics = context.measureText(text);
    const textWidth = metrics.width;

    // Use same padding strategy as original
    const padding = 8;
    canvas.width = textWidth + padding * 2;
    canvas.height = (fontSize * 96 / 80) + padding; // Scale height proportionally to original (96 for fontSize 80)

    const aspectRatio = canvas.width / canvas.height;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = `bold ${fontSize}px Arial`;
    context.fillStyle = 'rgba(0, 0, 0, 1.0)'; // Black text like original
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return { texture, aspectRatio };
  }
}