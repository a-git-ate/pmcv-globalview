import * as THREE from 'three';
import { UIManager } from './UIManager';
import { PrismAPI } from './PrismAPI';
import { ProjectManager } from './ProjectManager';
import type {
  NodeData,
  EdgeData,
  GraphConfig,
  LayoutType,
  NodeClickEvent
} from './types';

export class Graph2D {
  // Three.js core
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private renderer: THREE.WebGLRenderer | null = null;
  private pointCloud: THREE.Points | null = null;

  // Graph data
  private nodes: NodeData[] = [];
  private edges: EdgeData[] = [];
  private nodeCount: number = 0;
  private currentLayout: LayoutType = 'random';
  private edgeLines: THREE.LineSegments | null = null;

  // Axis visualization
  private axisGroup: THREE.Group | null = null;
  private gridLinesVisible: boolean = false;

  // Overlap labels
  private overlapLabelsGroup: THREE.Group | null = null;

  // Tooltip
  private tooltipElement: HTMLElement | null = null;
  private hoveredNodeIndex: number = -1;

  // Store current parameter axes info for dynamic updates
  private currentAxisInfo: {
    xParamIndex: number;
    yParamIndex: number;
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
  private prismAPI: PrismAPI;

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
      maxZoom: 100.0, // Increased max zoom as well (was 50.0)
      lodEnabled: true,
      edgesVisible: false,
      clusterMode: false,
      edgeCount: 2000,
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

    // Initialize PRISM API
    this.prismAPI = new PrismAPI('http://localhost:8080');

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
      console.log(`[Generate Nodes] Created ${this.edges.length} random edges for ${count} nodes`);
      
      // Generate layout based on connectivity
      await this.generateLayout(count, positions, colors, sizes);

      // Create edge lines if edges are visible
      // Note: edges default to hidden for better performance
      if (this.config.edgesVisible) {
        this.createEdgeLines();
      } else {
        console.log(`[Generate Nodes] ${this.edges.length} edges created but hidden (use Toggle Edges to show)`);
      }

      // Create point cloud
      this.createPointCloud(geometry, positions, colors, sizes);

      // Update state
      this.nodeCount = count;
      this.ui.updateNodeCount(count);
      this.resetView();

      this.ui.updateStatus(`${count.toLocaleString()} 2D nodes ready`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate nodes';
      this.ui.showError(message);
    } finally {
      this.ui.enableButtons();
    }
  }

  public async loadGraphFromAPI(graphId: string = '0'): Promise<void> {
    this.ui.updateStatus('Fetching graph data from API...');
    this.ui.disableButtons();

    try {
      // Clear existing nodes and edges
      this.clearPointCloud();
      this.clearEdgeLines();
      this.nodes = [];
      this.edges = [];

      // Fetch graph data using PrismAPI
      const graphData = await this.prismAPI.fetchSimpleGraph(graphId);

      this.nodes = graphData.nodes;
      this.edges = graphData.edges;

      // Parameters are now extracted from PRISM API data in PrismAPI.convertNewFormatToInternal
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
      }

      // Create point cloud
      this.createPointCloud(geometry, positions, colors, sizes);

      // Update state
      this.nodeCount = nodeCount;
      this.ui.updateNodeCount(nodeCount);
      this.resetView();

      // Update parameter selection dropdowns with actual parameter names
      const paramLabels = this.prismAPI.getParameterLabels('s');
      this.ui.updateParameterSelections(paramLabels);

      // Update overlap labels
      this.updateOverlapLabels();

      // Update model info display
      this.ui.updateModelInfo(graphId, nodeCount, this.edges.length);

      this.ui.updateStatus(`Loaded ${nodeCount.toLocaleString()} nodes and ${this.edges.length.toLocaleString()} edges from API`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load graph from API';
      this.ui.showError(message);
      this.ui.clearModelInfo();
      throw error; // Re-throw to allow fallback in main.ts
    } finally {
      this.ui.enableButtons();
    }
  }

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
          z: 0,
          radius: 0,
          cluster: Math.floor(i / Math.max(1, count / 10)) % 10,
          value: Math.random(),
          type: Math.random() > 0.95 ? 'important' : 'normal',
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
      const xParamIndex = this.config.parameterXAxis ?? 0;
      const yParamIndex = this.config.parameterYAxis ?? 1;

      minX = Infinity;
      maxX = -Infinity;
      minY = Infinity;
      maxY = -Infinity;

      for (let i = 0; i < count; i++) {
        const node = this.nodes[i];
        minX = Math.min(minX, node.parameters[xParamIndex]);
        maxX = Math.max(maxX, node.parameters[xParamIndex]);
        minY = Math.min(minY, node.parameters[yParamIndex]);
        maxY = Math.max(maxY, node.parameters[yParamIndex]);
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
    if (this.currentLayout === 'force_directed') {
      this.ui.updateStatus('Computing force-directed layout...');
      this.applyForceDirectedLayout(count, positions, spread);
    }
    
    // Pre-calculate color table for common degree values to avoid creating Color objects
    const colorCache = new Map<number, { r: number; g: number; b: number }>();
    const getColorForDegree = (degree: number): { r: number; g: number; b: number } => {
      const key = Math.min(degree, 20); // Cap at 20 for cache efficiency
      if (!colorCache.has(key)) {
        const hue = key > 0 ? Math.min(0.3, key * 0.05) : 0.6;
        const color = new THREE.Color().setHSL(hue, 0.8, 0.6);
        colorCache.set(key, { r: color.r, g: color.g, b: color.b });
      }
      return colorCache.get(key)!;
    };

    // Update colors and sizes based on final positions and connectivity
    for (let i = 0; i < count; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];

      const size = this.calculateNodeSize(x, y, spread);

      // Adjust size based on node degree (connectivity)
      const degree = (this.nodes[i] as any).degree || 0;
      const adjustedSize = size + (degree * 0.2);

      this.nodes[i].radius = adjustedSize;

      // Set colors array - color based on connectivity (using cache)
      const color = getColorForDegree(degree);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;

      // Set sizes array
      sizes[i] = adjustedSize;
    }
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
  private parameterCenters: [number, number, number, number, number, number, number, number, number, number] | null = null;

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

    return {
      r: colorLower.r + (colorUpper.r - colorLower.r) * t,
      g: colorLower.g + (colorUpper.g - colorLower.g) * t,
      b: colorLower.b + (colorUpper.b - colorLower.b) * t
    };
  }

  // Generate 10 parameters with Gaussian distribution for a node
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

  // Calculate position based on parameter values
  // Note: minValues and maxValues need to be passed in for correct mapping
  private calculateParameterPosition(
    node: NodeData,
    spread: number,
    minValues: { x: number; y: number },
    maxValues: { x: number; y: number }
  ): THREE.Vector2 {
    if (this.config.useParameterPositioning) {
      const xParam = this.config.parameterXAxis ?? 0;
      const yParam = this.config.parameterYAxis ?? 1;

      // Map parameter values to position coordinates based on actual data range
      const xRange = maxValues.x - minValues.x;
      const yRange = maxValues.y - minValues.y;

      const xNormalized = xRange > 0 ? (node.parameters[xParam] - minValues.x) / xRange : 0.5;
      const yNormalized = yRange > 0 ? (node.parameters[yParam] - minValues.y) / yRange : 0.5;

      // Map from [0, 1] to [-spread, spread]
      const x = (xNormalized - 0.5) * 2 * spread;
      const y = (yNormalized - 0.5) * 2 * spread;

      return new THREE.Vector2(x, y);
    }

    // Fallback to random position
    return new THREE.Vector2((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread);
  }

  private calculateNodePosition(index: number, _count: number, spread: number): THREE.Vector2 {
    let x: number, y: number;

    if (this.currentLayout === 'force_directed') {
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
      this.edges.push({ from, to, weight: Math.random() });
      edgeSet.add(edgeKey);
      connectionSets[from].add(to);
      connectionSets[to].add(from);
      edgesCreated++;
    }

    console.log(`[generateRandomEdges] Successfully created ${edgesCreated} edges for ${nodeCount} nodes`);

    // Convert Sets back to arrays for node data
    this.nodes.forEach((node, index) => {
      const connectionsArray = Array.from(connectionSets[index]);
      (node as any).connections = connectionsArray;
      (node as any).degree = connectionsArray.length;
    });
  }

  // Currently unused but kept for potential future use
  // @ts-expect-error - Unused method kept for future use
  private _calculateForceDirectedPosition(index: number, spread: number): THREE.Vector2 {
    if (this.nodes.length === 0) {
      return new THREE.Vector2((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread);
    }
    
    const node = this.nodes[index];
    if (!node || !(node as any).connections) {
      return new THREE.Vector2((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread);
    }
    
    // Use existing position if available, otherwise random
    return new THREE.Vector2(node.x || (Math.random() - 0.5) * spread, node.y || (Math.random() - 0.5) * spread);
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
          console.warn(`Invalid position at node ${i}, resetting`);
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
        console.log(`Force simulation converged after ${iter + 1} iterations`);
        this.ui.updateStatus(`Force simulation converged after ${iter + 1} iterations`);
        break;
      }

      // Progress update every 50 iterations
      if (iter % 50 === 0 && iter > 0) {
        console.log(`Force simulation: iteration ${iter}, max movement: ${maxMovement.toFixed(4)}`);
      }
    }

    // Update node data with final positions
    for (let i = 0; i < nodeCount; i++) {
      this.nodes[i].x = simX[i];
      this.nodes[i].y = simY[i];
    }
  }

  private createEdgeLines(): void {
    if (!this.edges.length || !this.nodes.length) return;

    // Filter out invalid edges (edges pointing to non-existent nodes)
    const validEdges = this.edges.filter(edge => {
      return edge.from >= 0 && edge.from < this.nodes.length &&
             edge.to >= 0 && edge.to < this.nodes.length &&
             this.nodes[edge.from] && this.nodes[edge.to];
    });

    if (validEdges.length === 0) {
      console.warn('[createEdgeLines] No valid edges to render');
      return;
    }

    if (validEdges.length < this.edges.length) {
      console.warn(`[createEdgeLines] Filtered out ${this.edges.length - validEdges.length} invalid edges`);
    }

    console.log(`[createEdgeLines] Rendering ${validEdges.length} valid edges out of ${this.edges.length} total`);

    // Calculate edge extent for debugging
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    validEdges.forEach(edge => {
      const fromNode = this.nodes[edge.from];
      const toNode = this.nodes[edge.to];
      minX = Math.min(minX, fromNode.x, toNode.x);
      maxX = Math.max(maxX, fromNode.x, toNode.x);
      minY = Math.min(minY, fromNode.y, toNode.y);
      maxY = Math.max(maxY, fromNode.y, toNode.y);
    });
    console.log(`[createEdgeLines] Edge extent: X[${minX.toFixed(1)}, ${maxX.toFixed(1)}], Y[${minY.toFixed(1)}, ${maxY.toFixed(1)}]`);
    console.log(`[createEdgeLines] Camera bounds: X[${this.camera.left.toFixed(1)}, ${this.camera.right.toFixed(1)}], Y[${this.camera.bottom.toFixed(1)}, ${this.camera.top.toFixed(1)}]`);

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(validEdges.length * 6); // 2 points per edge, 3 coords per point
    const colors = new Float32Array(validEdges.length * 6); // 2 points per edge, 3 colors per point

    validEdges.forEach((edge, i) => {
      const fromNode = this.nodes[edge.from];
      const toNode = this.nodes[edge.to];

      // Start point
      positions[i * 6] = fromNode.x;
      positions[i * 6 + 1] = fromNode.y;
      positions[i * 6 + 2] = 0;

      // End point
      positions[i * 6 + 3] = toNode.x;
      positions[i * 6 + 4] = toNode.y;
      positions[i * 6 + 5] = 0;

      // Edge color (brighter white for better visibility)
      const color = new THREE.Color(0xaaaaaa);
      colors[i * 6] = color.r;
      colors[i * 6 + 1] = color.g;
      colors[i * 6 + 2] = color.b;
      colors[i * 6 + 3] = color.r;
      colors[i * 6 + 4] = color.g;
      colors[i * 6 + 5] = color.b;
    });

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      linewidth: 2
    });

    this.edgeLines = new THREE.LineSegments(geometry, material);
    // Ensure edges render behind nodes by setting renderOrder
    this.edgeLines.renderOrder = -1;
    this.scene.add(this.edgeLines);
    console.log('[createEdgeLines] Edge lines added to scene with renderOrder = -1');
  }

  private clearEdgeLines(): void {
    if (this.edgeLines) {
      this.scene.remove(this.edgeLines);
      this.edgeLines.geometry.dispose();
      if (this.edgeLines.material instanceof THREE.Material) {
        this.edgeLines.material.dispose();
      }
      this.edgeLines = null;
    }
  }

  // Note: This method is currently unused but kept for potential future use
  // private updateNodeConnectivity(): void {
  //   // Initialize connections array for all nodes
  //   const connections: number[][] = Array(this.nodes.length).fill(null).map(() => []);
  //
  //   // Build connections from edges
  //   this.edges.forEach(edge => {
  //     if (edge.from < this.nodes.length && edge.to < this.nodes.length) {
  //       connections[edge.from].push(edge.to);
  //       connections[edge.to].push(edge.from); // Undirected graph
  //     }
  //   });
  //
  //   // Update node data with connections
  //   this.nodes.forEach((node, index) => {
  //     (node as any).connections = connections[index];
  //     (node as any).degree = connections[index].length;
  //   });
  // }

  // Note: This method is currently unused but kept for potential future use
  // private async generateLayoutFromNodes(
  //   positions: Float32Array,
  //   colors: Float32Array,
  //   sizes: Float32Array
  // ): Promise<void> {
  //   const nodeCount = this.nodes.length;
  //   const spread = Math.sqrt(nodeCount) * 0.5;
  //
  //   // Initialize positions from node data or random
  //   for (let i = 0; i < nodeCount; i++) {
  //     const node = this.nodes[i];
  //     let x = node.x;
  //     let y = node.y;
  //
  //     // If no position provided, use random or layout algorithm
  //     if (x === 0 && y === 0) {
  //       const position = this.calculateNodePosition(i, nodeCount, spread);
  //       x = position.x;
  //       y = position.y;
  //
  //       // Update node data
  //       this.nodes[i].x = x;
  //       this.nodes[i].y = y;
  //     }
  //
  //     // Set initial positions array
  //     positions[i * 3] = x;
  //     positions[i * 3 + 1] = y;
  //     positions[i * 3 + 2] = 0;
  //   }
  //
  //   // Apply force-directed layout if selected
  //   if (this.currentLayout === ('force_directed' as any)) {
  //     this.ui.updateStatus('Computing force-directed layout...');
  //     this.applyForceDirectedLayout(nodeCount, positions, spread);
  //   }
  //
  //   // Update colors and sizes based on final positions and connectivity
  //   for (let i = 0; i < nodeCount; i++) {
  //     const x = positions[i * 3];
  //     const y = positions[i * 3 + 1];
  //
  //     const size = this.calculateNodeSize(x, y, spread);
  //
  //     // Adjust size based on node degree (connectivity)
  //     const degree = (this.nodes[i] as any).degree || 0;
  //     const adjustedSize = size + (degree * 0.2); // Nodes with more connections are larger
  //
  //     this.nodes[i].radius = adjustedSize;
  //
  //     // Set colors array - color based on connectivity
  //     const connectivityHue = degree > 0 ? Math.min(0.3, degree * 0.05) : 0.6; // Connected = warmer, isolated = cooler
  //     const connectivityColor = new THREE.Color().setHSL(connectivityHue, 0.8, 0.6);
  //     colors[i * 3] = connectivityColor.r;
  //     colors[i * 3 + 1] = connectivityColor.g;
  //     colors[i * 3 + 2] = connectivityColor.b;
  //
  //     // Set sizes array
  //     sizes[i] = adjustedSize;
  //
  //     // Yield control occasionally
  //     if (i % 10000 === 0 && i > 0) {
  //       this.ui.updateNodeCount(i);
  //       await new Promise<void>(resolve => setTimeout(resolve, 1));
  //     }
  //   }
  // }

  private createPointCloud(
    geometry: THREE.BufferGeometry,
    positions: Float32Array,
    colors: Float32Array,
    sizes: Float32Array
  ): void {
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.PointsMaterial({
      size: 9.0, // Increased from 6.0 to 9.0 (1.5x)
      vertexColors: true,
      sizeAttenuation: false, // Disable size attenuation so nodes don't disappear when zooming
      transparent: true,
      opacity: 0.9,
      alphaTest: 0.1
    });

    this.pointCloud = new THREE.Points(geometry, material);
    this.pointCloud.frustumCulled = false; // Prevent nodes from being culled when zooming
    this.pointCloud.renderOrder = 0; // Render nodes on top of edges (edges are at -1)
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

  public applyLayout(layoutType: LayoutType): void {
    this.currentLayout = layoutType;
    this.config.useParameterPositioning = false;
    this.clearAxisVisualization();
    this.ui.onLayoutChange(layoutType);

    if (this.nodeCount === 0 || !this.pointCloud) {
      this.ui.updateStatus("Generate nodes first!");
      return;
    }

    this.ui.updateStatus(`Applying ${layoutType} layout...`);
    this.relayoutExistingNodes();
  }

  /**
   * Re-layout existing nodes without regenerating them (preserves API data)
   */
  private async relayoutExistingNodes(): Promise<void> {
    if (!this.pointCloud || this.nodes.length === 0) return;

    const count = this.nodes.length;
    const spread = Math.sqrt(count) * 0.5;
    const positions = this.pointCloud.geometry.attributes.position as THREE.BufferAttribute;
    const colors = this.pointCloud.geometry.attributes.color as THREE.BufferAttribute;
    const sizes = this.pointCloud.geometry.attributes.size as THREE.BufferAttribute;

    // Reposition all nodes based on current layout
    for (let i = 0; i < count; i++) {
      const nodeData = this.nodes[i];
      const position = this.calculateNodePosition(i, count, spread);

      // Update node data
      nodeData.x = position.x;
      nodeData.y = position.y;

      // Update positions buffer
      positions.setXYZ(i, position.x, position.y, 0);
    }

    // Apply force-directed layout if selected (both 'force' and 'force_directed' use physics simulation)
    if (this.currentLayout === 'force_directed' || this.currentLayout === 'force') {
      this.ui.updateStatus('Computing force-directed layout...');
      await this.applyForceDirectedLayoutToBuffer(positions, spread);
    }

    // Update colors based on connectivity
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

    for (let i = 0; i < count; i++) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const size = this.calculateNodeSize(x, y, spread);
      const degree = (this.nodes[i] as any).degree || 0;
      const adjustedSize = size + (degree * 0.2);

      this.nodes[i].radius = adjustedSize;

      const color = getColorForDegree(degree);
      colors.setXYZ(i, color.r, color.g, color.b);
      sizes.setX(i, adjustedSize);
    }

    // Mark buffers as needing update
    positions.needsUpdate = true;
    colors.needsUpdate = true;
    sizes.needsUpdate = true;

    // Redraw edges if visible
    console.log(`[relayoutExistingNodes] Before edge redraw: ${this.edges.length} edges, edgesVisible: ${this.config.edgesVisible}, edgeLines exists: ${!!this.edgeLines}`);
    if (this.config.edgesVisible && this.edges.length > 0) {
      this.clearEdgeLines();
      this.createEdgeLines();
    } else {
      console.log(`[relayoutExistingNodes] Skipping edge creation (edgesVisible=${this.config.edgesVisible}, edges.length=${this.edges.length})`);
    }

    this.resetView();

    // Update overlap labels after layout
    this.updateOverlapLabels();

    this.ui.updateStatus(`${this.currentLayout} layout applied`);
  }

  /**
   * Apply force-directed layout directly to position buffer
   */
  private async applyForceDirectedLayoutToBuffer(positions: THREE.BufferAttribute, spread: number): Promise<void> {
    const nodeCount = this.nodes.length;
    const positionsArray = positions.array as Float32Array;

    // Call existing force-directed method
    this.applyForceDirectedLayout(nodeCount, positionsArray, spread);

    // Update node data with final positions
    for (let i = 0; i < nodeCount; i++) {
      this.nodes[i].x = positionsArray[i * 3];
      this.nodes[i].y = positionsArray[i * 3 + 1];
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
      const index = intersects[0].index;
      if (index !== undefined && index !== this.hoveredNodeIndex) {
        this.hoveredNodeIndex = index;
        this.showNodeTooltip(index, event.clientX, event.clientY);
      } else if (index !== undefined) {
        // Update tooltip position
        this.updateTooltipPosition(event.clientX, event.clientY);
      }
    } else {
      this.hideNodeTooltip();
    }
  }

  private showNodeTooltip(nodeIndex: number, x: number, y: number): void {
    if (!this.tooltipElement || nodeIndex >= this.nodes.length) {
      return;
    }

    const node = this.nodes[nodeIndex];

    // Find all nodes at the same position (stacked nodes)
    // Use a more generous epsilon for matching positions
    const epsilon = 0.1; // Increased tolerance for position matching
    const stackedNodes: number[] = [nodeIndex]; // Always include the hovered node

    // Only search through nodes if we have a reasonable number
    const maxNodesToSearch = Math.min(this.nodes.length, 10000);
    for (let i = 0; i < maxNodesToSearch; i++) {
      if (i === nodeIndex) continue; // Skip the node we already added

      const otherNode = this.nodes[i];
      if (!otherNode) continue; // Skip if node doesn't exist

      const dx = Math.abs(otherNode.x - node.x);
      const dy = Math.abs(otherNode.y - node.y);

      if (dx < epsilon && dy < epsilon) {
        stackedNodes.push(i);
      }
    }

    // Get parameter labels from PRISM API
    const paramLabels = this.prismAPI.getParameterLabels('s');

    // Build tooltip content
    let html = '';

    if (stackedNodes.length > 1) {
      // Limit to showing first 5 stacked nodes to avoid huge tooltips
      const nodesToShow = stackedNodes.slice(0, 5);
      const remainingCount = stackedNodes.length - nodesToShow.length;

      html += `<strong>${stackedNodes.length} Stacked Nodes${remainingCount > 0 ? ` (showing ${nodesToShow.length})` : ''}</strong>`;
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
        stackedNode.parameters.forEach((value, index) => {
          const label = paramLabels[index]?.label || `P${index}`;
          html += `<div class="property">${label}: ${value.toFixed(3)}</div>`;
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
      node.parameters.forEach((value, index) => {
        const label = paramLabels[index]?.label || `P${index}`;
        html += `<div class="property">${label}: ${value.toFixed(3)}</div>`;
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
      const point = intersects[0].point;
      const clickEvent: NodeClickEvent = {
        type: 'nodeClick',
        data: {
          position: point,
          screenPosition: mouse
        }
      };

      this.handleNodeClick(clickEvent);
    }
  }

  private handleNodeClick(event: NodeClickEvent): void {
    const position = event.data.position;
    this.ui.updateStatus(
      `Selected node at (${position.x.toFixed(1)}, ${position.y.toFixed(1)})`
    );
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
      this.createEdgeLines();
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

        console.log(`[resetView] Node extent: X[${minX.toFixed(1)}, ${maxX.toFixed(1)}], Y[${minY.toFixed(1)}, ${maxY.toFixed(1)}]`);
        console.log(`[resetView] Setting zoom to ${this.zoomLevel.toFixed(3)}x to fit range ${maxRange.toFixed(1)}`);
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
  private calculateNiceWorldInterval(visibleRange: number): number {
    // Target approximately 10-20 grid squares across the visible range
    const targetDivisions = 15;
    const roughInterval = visibleRange / targetDivisions;

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
   */
  private updateOverlapLabels(): void {
    // Clear existing overlap labels
    this.clearOverlapLabels();

    if (!this.nodes.length) return;

    // Create a map of positions to node indices
    const positionMap = new Map<string, number[]>();
    const epsilon = 0.001; // Tolerance for considering positions "equal"

    // Group nodes by position
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      // Round to avoid floating point precision issues
      const posKey = `${Math.round(node.x / epsilon) * epsilon},${Math.round(node.y / epsilon) * epsilon}`;

      if (!positionMap.has(posKey)) {
        positionMap.set(posKey, []);
      }
      positionMap.get(posKey)!.push(i);
    }

    // Create labels for positions with multiple nodes
    this.overlapLabelsGroup = new THREE.Group();

    positionMap.forEach((nodeIndices) => {
      if (nodeIndices.length > 1) {
        // Get position from first node
        const firstNode = this.nodes[nodeIndices[0]];
        const count = nodeIndices.length;

        // Create label sprite
        const texture = this.createOverlapCountTexture(count.toString());
        const spriteMaterial = new THREE.SpriteMaterial({
          map: texture,
          transparent: true,
          opacity: 0.95,
          sizeAttenuation: false, // Use screen-space sizing
          depthTest: false // Always render on top
        });
        const sprite = new THREE.Sprite(spriteMaterial);

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

        sprite.position.set(firstNode.x + offsetX, firstNode.y + offsetY, 1);

        // Font size: 0.5vh in screen space
        // Convert viewport height percentage to world space
        const labelScale = viewHeight * 0.02; // 2% of view height for visibility
        sprite.scale.set(labelScale, labelScale, 1);

        // Store node reference for position updates
        sprite.userData = { nodeIndex: nodeIndices[0] };

        if (this.overlapLabelsGroup) {
          this.overlapLabelsGroup.add(sprite);
        }
      }
    });

    if (this.overlapLabelsGroup && this.overlapLabelsGroup.children.length > 0) {
      this.scene.add(this.overlapLabelsGroup);
      console.log(`Created ${this.overlapLabelsGroup.children.length} overlap labels`);
    } else {
      console.log('No overlapping nodes found');
    }
  }

  /**
   * Create a texture for overlap count labels
   */
  private createOverlapCountTexture(text: string): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;

    // Much smaller font for tiny labels
    const fontSize = 80;
    context.font = `bold ${fontSize}px Arial`;
    const metrics = context.measureText(text);
    const textWidth = metrics.width;

    // Set canvas size with minimal padding
    const padding = 8;
    canvas.width = Math.max(96, textWidth + padding * 2);
    canvas.height = 96;

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
    return texture;
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

    // Font size: 0.5vh in screen space
    // Convert viewport height percentage to world space
    const labelScale = viewHeight * 0.02; // 2% of view height for visibility

    // Update each sprite's position and scale
    this.overlapLabelsGroup.children.forEach((sprite) => {
      if (sprite instanceof THREE.Sprite && sprite.userData.nodeIndex !== undefined) {
        const nodeIndex = sprite.userData.nodeIndex as number;
        const node = this.nodes[nodeIndex];
        if (node) {
          // Update position based on current node position and viewport offsets
          sprite.position.set(node.x + offsetX, node.y + offsetY, 1);
          sprite.scale.set(labelScale, labelScale, 1);
        }
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
  private createTextTexture(text: string, fontSize: number = 48): THREE.CanvasTexture {
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
    return texture;
  }

  // Create axis labels in the 3D scene
  private createAxisVisualization(
    xParamIndex: number,
    yParamIndex: number,
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

    // SCREEN-EDGE-FIXED AXES: Always at the edges of the viewport
    const xAxisY = viewBottom; // X-axis fixed to bottom of screen
    const yAxisX = viewLeft;   // Y-axis fixed to left of screen

    // X-axis: horizontal line spanning the entire screen width
    const xAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(viewLeft, xAxisY, 0),
      new THREE.Vector3(viewRight, xAxisY, 0)
    ]);
    const xAxisLine = new THREE.Line(xAxisGeometry, axisLinesMaterial);
    this.axisGroup.add(xAxisLine);

    // Y-axis: vertical line spanning the entire screen height
    const yAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(yAxisX, viewBottom, 0),
      new THREE.Vector3(yAxisX, viewTop, 0)
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
    const viewHeight = viewTop - viewBottom;
    // const viewWidth = viewRight - viewLeft;
    const labelScale = viewHeight * 0.08; // 8% of viewport height for larger labels

    // Calculate visible X range in parameter space
    // Map viewport coordinates to parameter values
    const xRange = maxValues.x - minValues.x;
    const yRange = maxValues.y - minValues.y;

    // Convert viewport left/right to parameter values
    const visibleMinX = xRange > 0 ? minValues.x + ((viewLeft + spread) / (2 * spread)) * xRange : minValues.x;
    const visibleMaxX = xRange > 0 ? minValues.x + ((viewRight + spread) / (2 * spread)) * xRange : maxValues.x;
    const visibleMinY = yRange > 0 ? minValues.y + ((viewBottom + spread) / (2 * spread)) * yRange : minValues.y;
    const visibleMaxY = yRange > 0 ? minValues.y + ((viewTop + spread) / (2 * spread)) * yRange : maxValues.y;

    // To make square grids, we need the same WORLD-SPACE interval on both axes
    // Calculate visible world space ranges
    const visibleWorldWidth = viewRight - viewLeft;
    const visibleWorldHeight = viewTop - viewBottom;

    // Use the larger dimension to determine a nice world-space interval
    const maxWorldDimension = Math.max(visibleWorldWidth, visibleWorldHeight);

    // Calculate nice world-space interval using only 1, 2.5, 5 × 10^n
    const worldInterval = this.calculateNiceWorldInterval(maxWorldDimension);

    // Now convert world interval to parameter intervals (different for X and Y if ranges differ)
    // worldInterval units in world space = how many parameter units?
    // World space spans 2*spread = entire parameter range
    const xParamPerWorld = xRange / (2 * spread);
    const yParamPerWorld = yRange / (2 * spread);

    const xParamInterval = worldInterval * xParamPerWorld;
    const yParamInterval = worldInterval * yParamPerWorld;

    // Generate X-axis ticks starting from 0 (or nearest multiple below visible range)
    const xTicks: number[] = [];
    // Find the world position of parameter value 0
    // const zeroWorldX = -spread + (xRange > 0 ? (0 - minValues.x) / xRange : 0.5) * (2 * spread);

    // Find starting tick that's a multiple of xParamInterval and at or before visible range
    // Start from 0 and go in both directions
    const xStartMultiplier = Math.floor(visibleMinX / xParamInterval);
    const xEndMultiplier = Math.ceil(visibleMaxX / xParamInterval);

    for (let mult = xStartMultiplier; mult <= xEndMultiplier; mult++) {
      const val = mult * xParamInterval;
      if (val >= visibleMinX - xParamInterval * 0.01 && val <= visibleMaxX + xParamInterval * 0.01) {
        xTicks.push(val);
      }
    }

    for (const value of xTicks) {
      // Calculate world position based on parameter value
      const normalizedX = xRange > 0 ? (value - minValues.x) / xRange : 0.5;
      const xPos = -spread + normalizedX * (spread * 2);

      // Only show labels that are within viewport
      if (xPos < viewLeft || xPos > viewRight) continue;

      // Determine decimal places based on interval size
      // For intervals like 0.25, 2.5, we need appropriate decimal places
      const decimals = this.getDecimalPlaces(xParamInterval);

      // Create text sprite for label
      const texture = this.createTextTexture(value.toFixed(decimals), 64);
      const spriteMaterial = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0.95,
        sizeAttenuation: false
      });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.position.set(xPos, xAxisY + labelScale * 0.6, 0); // Position above the axis line
      sprite.scale.set(labelScale * 1.2, labelScale * 0.6, 1);
      this.axisGroup.add(sprite);

      // Add tick mark on the x-axis line
      const tickGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(xPos, xAxisY, 0),
        new THREE.Vector3(xPos, xAxisY + labelScale * 0.3, 0)
      ]);
      const tickLine = new THREE.Line(tickGeometry, axisLinesMaterial);
      this.axisGroup.add(tickLine);

      // Add vertical grid line if enabled
      if (this.gridLinesVisible) {
        const gridGeometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(xPos, viewBottom, 0),
          new THREE.Vector3(xPos, viewTop, 0)
        ]);
        const gridLine = new THREE.Line(gridGeometry, gridLinesMaterial);
        this.axisGroup.add(gridLine);
      }
    }

    // Generate Y-axis ticks starting from 0 (or nearest multiple below visible range)
    const yTicks: number[] = [];
    // Start from 0 and go in both directions
    const yStartMultiplier = Math.floor(visibleMinY / yParamInterval);
    const yEndMultiplier = Math.ceil(visibleMaxY / yParamInterval);

    for (let mult = yStartMultiplier; mult <= yEndMultiplier; mult++) {
      const val = mult * yParamInterval;
      if (val >= visibleMinY - yParamInterval * 0.01 && val <= visibleMaxY + yParamInterval * 0.01) {
        yTicks.push(val);
      }
    }

    for (const value of yTicks) {
      // Calculate world position based on parameter value
      const normalizedY = yRange > 0 ? (value - minValues.y) / yRange : 0.5;
      const yPos = -spread + normalizedY * (spread * 2);

      // Only show labels that are within viewport
      if (yPos < viewBottom || yPos > viewTop) continue;

      // Determine decimal places based on interval size
      const decimals = this.getDecimalPlaces(yParamInterval);

      // Create text sprite for label
      const texture = this.createTextTexture(value.toFixed(decimals), 64);
      const spriteMaterial = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0.95,
        sizeAttenuation: false
      });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.position.set(yAxisX + labelScale * 0.8, yPos, 0); // Position to the right of the axis line
      sprite.scale.set(labelScale * 1.2, labelScale * 0.6, 1);
      this.axisGroup.add(sprite);

      // Add tick mark on the y-axis line
      const tickGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(yAxisX, yPos, 0),
        new THREE.Vector3(yAxisX + labelScale * 0.3, yPos, 0)
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
    const paramLabels = this.prismAPI.getParameterLabels('s');
    const xParamLabel = paramLabels[xParamIndex]?.label || `P${xParamIndex}`;
    const yParamLabel = paramLabels[yParamIndex]?.label || `P${yParamIndex}`;

    // X-axis title: centered horizontally at bottom of screen
    const xTitleTexture = this.createTextTexture(xParamLabel, 64);
    const xTitleMaterial = new THREE.SpriteMaterial({
      map: xTitleTexture,
      transparent: true,
      opacity: 1.0,
      sizeAttenuation: false
    });
    const xTitle = new THREE.Sprite(xTitleMaterial);
    const xTitleX = (viewLeft + viewRight) / 2; // Center of screen
    xTitle.position.set(xTitleX, xAxisY + labelScale * 1.5, 0);
    xTitle.scale.set(labelScale * 2.0, labelScale * 0.7, 1);
    this.axisGroup.add(xTitle);

    // Y-axis title: centered vertically at left of screen
    const yTitleTexture = this.createTextTexture(yParamLabel, 64);
    const yTitleMaterial = new THREE.SpriteMaterial({
      map: yTitleTexture,
      transparent: true,
      opacity: 1.0,
      sizeAttenuation: false
    });
    const yTitle = new THREE.Sprite(yTitleMaterial);
    const yTitleY = (viewBottom + viewTop) / 2; // Center of screen
    yTitle.position.set(yAxisX + labelScale * 2.0, yTitleY, 0);
    yTitle.scale.set(labelScale * 2.0, labelScale * 0.7, 1);
    this.axisGroup.add(yTitle);

    // Add the axis group to the scene
    this.scene.add(this.axisGroup);
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
  public applyColorParameter(colorParamIndex: number): void {
    if (!this.pointCloud || this.nodes.length === 0) return;

    if (colorParamIndex < 0 || colorParamIndex >= 10) {
      this.ui.updateStatus('Invalid color parameter index');
      return;
    }

    this.ui.updateStatus(`Applying color parameter ${colorParamIndex}...`);

    const colors = this.pointCloud.geometry.attributes.color as THREE.BufferAttribute;

    // Find min/max values for color mapping
    let minColor = Infinity, maxColor = -Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      minColor = Math.min(minColor, node.parameters[colorParamIndex]);
      maxColor = Math.max(maxColor, node.parameters[colorParamIndex]);
    }

    // Apply colors
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const colorValue = node.parameters[colorParamIndex];
      const color = this.getColorFromParameter(colorValue, minColor, maxColor);
      colors.setXYZ(i, color.r, color.g, color.b);
    }

    colors.needsUpdate = true;
    this.ui.updateStatus(`Colored by parameter ${colorParamIndex}`);
  }

  public rearrangeByParameters(xParamIndex: number, yParamIndex: number, colorParamIndex: number = -1): void {
    if (!this.pointCloud || this.nodes.length === 0) return;

    console.log(`[Parameter View] Starting with ${this.edges.length} edges, edgesVisible: ${this.config.edgesVisible}`);
    this.ui.updateStatus(`Rearranging nodes by parameters ${xParamIndex} and ${yParamIndex}...`);

    // Update configuration
    this.config.parameterXAxis = xParamIndex;
    this.config.parameterYAxis = yParamIndex;
    this.config.useParameterPositioning = true;

    const positions = this.pointCloud.geometry.attributes.position as THREE.BufferAttribute;
    const colors = this.pointCloud.geometry.attributes.color as THREE.BufferAttribute;

    // Track min and max parameter values for axis labels and color mapping
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minColor = Infinity, maxColor = -Infinity;

    // First pass: find min/max values for all parameters
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      minX = Math.min(minX, node.parameters[xParamIndex]);
      maxX = Math.max(maxX, node.parameters[xParamIndex]);
      minY = Math.min(minY, node.parameters[yParamIndex]);
      maxY = Math.max(maxY, node.parameters[yParamIndex]);

      if (colorParamIndex >= 0 && colorParamIndex < 10) {
        minColor = Math.min(minColor, node.parameters[colorParamIndex]);
        maxColor = Math.max(maxColor, node.parameters[colorParamIndex]);
      }
    }

    // Calculate spread independently for X and Y to maintain 1:1 aspect ratio
    const xRange = maxX - minX;
    const yRange = maxY - minY;

    // Each spread maps to world coordinates with 1:1 ratio
    // Use the actual ranges to preserve aspect ratio
    const spreadX = xRange > 0 ? xRange * 0.5 : 50;
    const spreadY = yRange > 0 ? yRange * 0.5 : 50;

    // For compatibility with existing code, use max spread
    const spread = Math.max(spreadX, spreadY);

    // Second pass: update positions and colors using actual min/max values
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const newPosition = this.calculateParameterPosition(
        node,
        spread,
        { x: minX, y: minY },
        { x: maxX, y: maxY }
      );

      // Update node data
      node.x = newPosition.x;
      node.y = newPosition.y;

      // Update positions buffer
      positions.setXYZ(i, newPosition.x, newPosition.y, 0);

      // Update colors if color parameter is specified
      if (colorParamIndex >= 0 && colorParamIndex < 10) {
        const colorValue = node.parameters[colorParamIndex];
        const color = this.getColorFromParameter(colorValue, minColor, maxColor);
        colors.setXYZ(i, color.r, color.g, color.b);
      }
    }

    positions.needsUpdate = true;
    if (colorParamIndex >= 0) {
      colors.needsUpdate = true;
    }

    // Redraw edge lines if they are visible
    console.log(`[Parameter View] Finished - ${this.edges.length} edges, edgesVisible: ${this.config.edgesVisible}`);
    if (this.config.edgesVisible && this.edges.length > 0) {
      console.log(`[Parameter View] Redrawing ${this.edges.length} edge lines`);
      this.clearEdgeLines();
      this.createEdgeLines();
    }

    // Create axis visualization in Three.js scene
    this.createAxisVisualization(
      xParamIndex,
      yParamIndex,
      { x: minX, y: minY },
      { x: maxX, y: maxY },
      spread
    );

    // Adjust camera view to fit all nodes with some padding
    this.fitViewToParameterRange(spread);

    // Update overlap labels after rearrangement
    this.updateOverlapLabels();

    const colorMsg = colorParamIndex >= 0 ? `, colored by P${colorParamIndex}` : '';
    this.ui.updateStatus(`Nodes rearranged by parameters ${xParamIndex} (X) and ${yParamIndex} (Y)${colorMsg}`);
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
  public async loadPrismProject(projectId: string, viewIds?: number[]): Promise<void> {
    this.ui.updateStatus(`Loading PRISM project: ${projectId}...`);
    this.ui.disableButtons();

    try {
      // Clear existing nodes and edges
      this.clearPointCloud();
      this.clearEdgeLines();
      this.nodes = [];
      this.edges = [];

      // Fetch PRISM project data
      const prismData = await this.prismAPI.fetchProject(projectId, viewIds);
      const graphData = this.prismAPI.convertPrismToInternal(prismData);

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
      }

      // Create point cloud
      this.createPointCloud(geometry, positions, colors, sizes);

      // Update state
      this.nodeCount = nodeCount;
      this.ui.updateNodeCount(nodeCount);
      this.resetView();

      // Update parameter selection dropdowns with actual parameter names
      const paramLabels = this.prismAPI.getParameterLabels('s');
      this.ui.updateParameterSelections(paramLabels);

      // Update overlap labels
      this.updateOverlapLabels();

      // Update model info display
      this.ui.updateModelInfo(projectId, nodeCount, this.edges.length, viewIds);

      const viewInfo = viewIds ? ` (views: ${viewIds.join(', ')})` : '';
      this.ui.updateStatus(`Loaded PRISM project "${projectId}"${viewInfo}: ${nodeCount.toLocaleString()} nodes, ${this.edges.length.toLocaleString()} edges`);
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

    this.prismAPI.clearCache();
    this.ui.dispose();
    this.projectManager.dispose();
    this.nodes = [];
  }

  // Getters for debugging and monitoring
  public getNodeCount(): number {
    return this.nodeCount;
  }

  public getConfig(): Readonly<GraphConfig> {
    return { ...this.config };
  }

  public getLastRenderTime(): number {
    return this.lastRenderTime;
  }
}