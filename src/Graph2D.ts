import * as THREE from 'three';
import { UIManager } from './UIManager';
import { PrismAPI } from './PrismAPI';
import type { 
  NodeData, 
  EdgeData,
  GraphConfig, 
  LayoutType, 
  NodeClickEvent,
  ForceSimulationNode
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

  // Performance tracking
  private lastRenderTime: number = 0;

  constructor(config?: Partial<GraphConfig>) {
    // Initialize configuration with defaults
    this.config = {
      maxVisibleNodes: 10000,
      renderDistance: 500,
      minZoom: 0.1,
      maxZoom: 50.0,
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

    this.init();
  }

  private init(): void {
    this.ui.updateStatus("Initializing 2D graph...");

    try {
      this.setupRenderer();
      this.setupCamera();
      this.setupControls();
      this.startAnimationLoop();

      this.ui.updateStatus("2D system ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.ui.showError(message);
      return;
    }
  }

  private setupRenderer(): void {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false
    });

    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x0a0a0a, 1.0);

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

      const zoomSpeed = 0.1;
      const zoomDelta = event.deltaY > 0 ? -zoomSpeed : zoomSpeed;

      this.zoomLevel = Math.max(
        this.config.minZoom,
        Math.min(this.config.maxZoom, this.zoomLevel + zoomDelta)
      );

      this.updateCameraPosition();
      this.ui.updateZoomDisplay(this.zoomLevel);
    });

    // Click (node selection)
    canvas.addEventListener('click', (event: MouseEvent) => {
      this.onNodeClick(event);
    });

    // Window resize
    window.addEventListener('resize', () => this.onWindowResize());
  }

  private updateCameraPosition(): void {
    const aspect = window.innerWidth / window.innerHeight;
    const viewSize = 50 / this.zoomLevel;

    this.camera.left = -viewSize * aspect + this.panOffset.x;
    this.camera.right = viewSize * aspect + this.panOffset.x;
    this.camera.top = viewSize + this.panOffset.y;
    this.camera.bottom = -viewSize + this.panOffset.y;

    this.camera.updateProjectionMatrix();

    // Update axes if they exist
    if (this.currentAxisInfo) {
      this.updateAxisVisualization();
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
      
      // Generate layout based on connectivity
      await this.generateLayout(count, positions, colors, sizes);
      
      // Create edge lines if edges are visible
      if (this.config.edgesVisible) {
        this.createEdgeLines();
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
      
      // Ensure all nodes have parameters (generate if missing)
      this.nodes.forEach(node => {
        if (!node.parameters) {
          node.parameters = this.generateNodeParameters();
        }
      });
      
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

      this.ui.updateStatus(`Loaded ${nodeCount.toLocaleString()} nodes and ${this.edges.length.toLocaleString()} edges from API`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load graph from API';
      this.ui.showError(message);
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

    // Initialize nodes with parameters first
    for (let i = 0; i < count; i++) {
      const nodeData: NodeData = {
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
      this.nodes.push(nodeData);
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

  private calculateNodePosition(index: number, count: number, spread: number): THREE.Vector2 {
    let x: number, y: number;

    switch (this.currentLayout) {
      case 'grid':
        const cols = Math.ceil(Math.sqrt(count));
        x = (index % cols - cols / 2) * (spread / cols) * 2;
        y = (Math.floor(index / cols) - cols / 2) * (spread / cols) * 2;
        break;

      case 'circular':
        const radius = spread * 0.8;
        const angle = (index / count) * Math.PI * 2;
        x = Math.cos(angle) * radius * (0.5 + Math.random() * 0.5);
        y = Math.sin(angle) * radius * (0.5 + Math.random() * 0.5);
        break;

      case 'force':
        const clusterCount = Math.min(50, Math.sqrt(count / 100));
        const clusterId = Math.floor(Math.random() * clusterCount);
        const clusterAngle = (clusterId / clusterCount) * Math.PI * 2;
        const clusterRadius = spread * 0.3;

        const clusterX = Math.cos(clusterAngle) * clusterRadius;
        const clusterY = Math.sin(clusterAngle) * clusterRadius;

        x = clusterX + (Math.random() - 0.5) * spread * 0.2;
        y = clusterY + (Math.random() - 0.5) * spread * 0.2;
        break;

      case 'force_directed' as LayoutType:
        const position = this.calculateForceDirectedPosition(index, spread);
        x = position.x;
        y = position.y;
        break;

      default: // random
        x = (Math.random() - 0.5) * spread;
        y = (Math.random() - 0.5) * spread;
    }

    return new THREE.Vector2(x, y);
  }


  private calculateNodeSize(x: number, y: number, spread: number): number {
    const distanceFromCenter = Math.sqrt(x * x + y * y);
    const normalizedDistance = Math.min(1, distanceFromCenter / spread);
    const baseSize = (1 - normalizedDistance * 0.3) * 6 + 3; // Half size: 3-9
    return baseSize;
  }

  private generateRandomEdges(nodeCount: number): void {
    const edgeCount = Math.min((this.config as any).edgeCount || 400, nodeCount);
    this.edges = [];
    
    // Track node connections for degree calculation
    const connections: number[][] = Array(nodeCount).fill(null).map(() => []);
    
    for (let i = 0; i < edgeCount; i++) {
      const from = Math.floor(Math.random() * nodeCount);
      let to = Math.floor(Math.random() * nodeCount);
      
      // Ensure no self-loops and no duplicate edges
      while (to === from || connections[from].includes(to)) {
        to = Math.floor(Math.random() * nodeCount);
      }
      
      this.edges.push({ from, to, weight: Math.random() });
      connections[from].push(to);
      connections[to].push(from); // Undirected graph
    }
    
    // Update node data with connections
    this.nodes.forEach((node, index) => {
      (node as any).connections = connections[index];
      (node as any).degree = connections[index].length;
    });
  }

  private calculateForceDirectedPosition(index: number, spread: number): THREE.Vector2 {
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

    // Scale down iterations for large graphs
    let iterations = (this.config as any).iterations || 500;
    if (nodeCount > 10000) {
      iterations = Math.min(100, iterations);
    } else if (nodeCount > 1000) {
      iterations = Math.min(200, iterations);
    }

    const forceStrength = (this.config as any).forceStrength || 0.3;
    const springLength = (this.config as any).springLength || 20;

    // For large graphs (>10k nodes), skip expensive all-pairs repulsion
    const useFullRepulsion = nodeCount < 10000;

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

    const damping = 0.9;
    const centerForce = 0.01;

    for (let iter = 0; iter < iterations; iter++) {
      // Reset forces
      simVX.fill(0);
      simVY.fill(0);

      // Only apply full repulsion for smaller graphs
      if (useFullRepulsion) {
        // Repulsion between all nodes
        for (let i = 0; i < nodeCount; i++) {
          for (let j = i + 1; j < nodeCount; j++) {
            const dx = simX[i] - simX[j];
            const dy = simY[i] - simY[j];
            const distSq = dx * dx + dy * dy + 0.01;
            const dist = Math.sqrt(distSq);

            const force = forceStrength * 500 / distSq;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;

            simVX[i] += fx;
            simVY[i] += fy;
            simVX[j] -= fx;
            simVY[j] -= fy;
          }
        }
      }

      // Spring forces for connected nodes (always applied)
      for (let e = 0; e < this.edges.length; e++) {
        const edge = this.edges[e];
        const i = edge.from;
        const j = edge.to;

        if (i >= nodeCount || j >= nodeCount) continue;

        const dx = simX[j] - simX[i];
        const dy = simY[j] - simY[i];
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.1;

        const force = forceStrength * (dist - springLength) / dist;
        const fx = dx * force;
        const fy = dy * force;

        simVX[i] += fx;
        simVY[i] += fy;
        simVX[j] -= fx;
        simVY[j] -= fy;
      }

      // Apply forces and update positions
      for (let i = 0; i < nodeCount; i++) {
        // Center force
        const dist = Math.sqrt(simX[i] * simX[i] + simY[i] * simY[i]) + 0.1;
        const cForce = centerForce * dist;
        simVX[i] -= (simX[i] / dist) * cForce;
        simVY[i] -= (simY[i] / dist) * cForce;

        // Apply velocity with damping
        simVX[i] *= damping;
        simVY[i] *= damping;
        simX[i] += simVX[i];
        simY[i] += simVY[i];

        // Update positions array
        positions[i * 3] = simX[i];
        positions[i * 3 + 1] = simY[i];
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
    
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(this.edges.length * 6); // 2 points per edge, 3 coords per point
    const colors = new Float32Array(this.edges.length * 6); // 2 points per edge, 3 colors per point
    
    this.edges.forEach((edge, i) => {
      const fromNode = this.nodes[edge.from];
      const toNode = this.nodes[edge.to];
      
      if (!fromNode || !toNode) return;
      
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
    this.scene.add(this.edgeLines);
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

  private updateNodeConnectivity(): void {
    // Initialize connections array for all nodes
    const connections: number[][] = Array(this.nodes.length).fill(null).map(() => []);
    
    // Build connections from edges
    this.edges.forEach(edge => {
      if (edge.from < this.nodes.length && edge.to < this.nodes.length) {
        connections[edge.from].push(edge.to);
        connections[edge.to].push(edge.from); // Undirected graph
      }
    });
    
    // Update node data with connections
    this.nodes.forEach((node, index) => {
      (node as any).connections = connections[index];
      (node as any).degree = connections[index].length;
    });
  }

  private async generateLayoutFromNodes(
    positions: Float32Array, 
    colors: Float32Array, 
    sizes: Float32Array
  ): Promise<void> {
    const nodeCount = this.nodes.length;
    const spread = Math.sqrt(nodeCount) * 0.5;

    // Initialize positions from node data or random
    for (let i = 0; i < nodeCount; i++) {
      const node = this.nodes[i];
      let x = node.x;
      let y = node.y;
      
      // If no position provided, use random or layout algorithm
      if (x === 0 && y === 0) {
        const position = this.calculateNodePosition(i, nodeCount, spread);
        x = position.x;
        y = position.y;
        
        // Update node data
        this.nodes[i].x = x;
        this.nodes[i].y = y;
      }
      
      // Set initial positions array
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = 0;
    }
    
    // Apply force-directed layout if selected
    if (this.currentLayout === ('force_directed' as any)) {
      this.ui.updateStatus('Computing force-directed layout...');
      this.applyForceDirectedLayout(nodeCount, positions, spread);
    }
    
    // Update colors and sizes based on final positions and connectivity
    for (let i = 0; i < nodeCount; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      
      const size = this.calculateNodeSize(x, y, spread);
      
      // Adjust size based on node degree (connectivity)
      const degree = (this.nodes[i] as any).degree || 0;
      const adjustedSize = size + (degree * 0.2); // Nodes with more connections are larger
      
      this.nodes[i].radius = adjustedSize;
      
      // Set colors array - color based on connectivity
      const connectivityHue = degree > 0 ? Math.min(0.3, degree * 0.05) : 0.6; // Connected = warmer, isolated = cooler
      const connectivityColor = new THREE.Color().setHSL(connectivityHue, 0.8, 0.6);
      colors[i * 3] = connectivityColor.r;
      colors[i * 3 + 1] = connectivityColor.g;
      colors[i * 3 + 2] = connectivityColor.b;

      // Set sizes array
      sizes[i] = adjustedSize;

      // Yield control occasionally
      if (i % 10000 === 0 && i > 0) {
        this.ui.updateNodeCount(i);
        await new Promise<void>(resolve => setTimeout(resolve, 1));
      }
    }
  }

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
      size: 6.0,
      vertexColors: true,
      sizeAttenuation: false, // Disable size attenuation so nodes don't disappear when zooming
      transparent: true,
      opacity: 0.9,
      alphaTest: 0.1
    });

    this.pointCloud = new THREE.Points(geometry, material);
    this.pointCloud.frustumCulled = false; // Prevent nodes from being culled when zooming
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

    if (this.nodeCount === 0) {
      this.ui.updateStatus("Generate nodes first!");
      return;
    }

    this.ui.updateStatus(`Applying ${layoutType} layout...`);
    this.generateNodes(this.nodeCount);
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

  public resetView(): void {
    this.panOffset.set(0, 0);
    this.zoomLevel = 1.0;
    this.updateCameraPosition();
    this.ui.updateZoomDisplay(this.zoomLevel);
    this.ui.updateStatus("View reset to center");
  }

  // Calculate nice round intervals for axis labels
  private calculateNiceInterval(min: number, max: number, targetDivisions: number = 5): number[] {
    const range = max - min;
    if (range === 0) return [min];

    // Calculate rough interval
    const roughInterval = range / (targetDivisions - 1);

    // Find the magnitude (power of 10)
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughInterval)));

    // Normalize the rough interval to be between 1 and 10
    const normalized = roughInterval / magnitude;

    // Choose a nice interval (1, 2, 5, or 10)
    let niceNormalized: number;
    if (normalized < 1.5) {
      niceNormalized = 1;
    } else if (normalized < 3) {
      niceNormalized = 2;
    } else if (normalized < 7) {
      niceNormalized = 5;
    } else {
      niceNormalized = 10;
    }

    const niceInterval = niceNormalized * magnitude;

    // Generate nice tick values
    const minTick = Math.ceil(min / niceInterval) * niceInterval;
    const maxTick = Math.floor(max / niceInterval) * niceInterval;

    const ticks: number[] = [];
    for (let tick = minTick; tick <= maxTick; tick += niceInterval) {
      // Handle floating point precision issues
      const roundedTick = Math.round(tick / magnitude) * magnitude;
      ticks.push(roundedTick);
    }

    // Ensure we have at least 2 ticks
    if (ticks.length < 2) {
      return [min, max];
    }

    return ticks;
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
    context.fillStyle = 'rgba(255, 255, 255, 0.9)';
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
      color: 0xffffff,
      opacity: 0.5,
      transparent: true,
      linewidth: 1 // Note: linewidth > 1 only works with WebGLRenderer, defaults to 1 on most platforms
    });

    // Get viewport bounds in world coordinates
    const viewLeft = this.camera.left;
    const viewRight = this.camera.right;
    const viewBottom = this.camera.bottom;
    const viewTop = this.camera.top;

    // Calculate where the data min positions are
    const dataMinX = -spread;
    const dataMinY = -spread;
    const dataMaxX = spread;
    const dataMaxY = spread;

    // Snap X-axis to bottom of screen if data min Y is out of view
    const xAxisY = Math.max(viewBottom, Math.min(viewTop, dataMinY));

    // Snap Y-axis to left of screen if data min X is out of view
    const yAxisX = Math.max(viewLeft, Math.min(viewRight, dataMinX));

    // X-axis: horizontal line, clamped to visible X range
    const xAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(Math.max(viewLeft, dataMinX), xAxisY, 0),
      new THREE.Vector3(Math.min(viewRight, dataMaxX), xAxisY, 0)
    ]);
    const xAxisLine = new THREE.Line(xAxisGeometry, axisLinesMaterial);
    this.axisGroup.add(xAxisLine);

    // Y-axis: vertical line, clamped to visible Y range
    const yAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(yAxisX, Math.max(viewBottom, dataMinY), 0),
      new THREE.Vector3(yAxisX, Math.min(viewTop, dataMaxY), 0)
    ]);
    const yAxisLine = new THREE.Line(yAxisGeometry, axisLinesMaterial);
    this.axisGroup.add(yAxisLine);

    // Create labels along X-axis
    // Calculate label scale based on viewport size to maintain constant screen size
    const viewHeight = viewTop - viewBottom;
    const labelScale = viewHeight * 0.075; // 7.5% of viewport height (2.5x larger)

    // Calculate visible X range in parameter space
    const visibleMinXWorld = Math.max(viewLeft, dataMinX);
    const visibleMaxXWorld = Math.min(viewRight, dataMaxX);
    const xRange = maxValues.x - minValues.x;
    const visibleMinX = xRange > 0 ? minValues.x + ((visibleMinXWorld + spread) / (2 * spread)) * xRange : minValues.x;
    const visibleMaxX = xRange > 0 ? minValues.x + ((visibleMaxXWorld + spread) / (2 * spread)) * xRange : maxValues.x;

    // Calculate nice tick values for visible X-axis range
    const xTicks = this.calculateNiceInterval(visibleMinX, visibleMaxX);

    for (const value of xTicks) {
      // Calculate position based on actual value
      const normalizedX = xRange > 0 ? (value - minValues.x) / xRange : 0.5;
      const xPos = -spread + normalizedX * (spread * 2);

      // Only show labels that are within visible range
      if (xPos < visibleMinXWorld || xPos > visibleMaxXWorld) continue;

      // Determine decimal places based on magnitude
      const magnitude = Math.abs(value);
      let decimals = 0;
      if (magnitude < 1 && magnitude > 0) {
        decimals = Math.max(0, -Math.floor(Math.log10(magnitude)) + 1);
      } else if (magnitude >= 10) {
        decimals = 0;
      } else {
        decimals = 1;
      }

      // Create text sprite
      const texture = this.createTextTexture(value.toFixed(decimals), 64);
      const spriteMaterial = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0.95,
        sizeAttenuation: false // Keep labels same size regardless of zoom
      });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.position.set(xPos, xAxisY - labelScale * 0.8, 0);
      sprite.scale.set(labelScale * 1.2, labelScale * 0.6, 1);
      this.axisGroup.add(sprite);

      // Add tick mark on the x-axis line
      const tickGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(xPos, xAxisY, 0),
        new THREE.Vector3(xPos, xAxisY - labelScale * 0.2, 0)
      ]);
      const tickLine = new THREE.Line(tickGeometry, axisLinesMaterial);
      this.axisGroup.add(tickLine);
    }

    // Calculate visible Y range in parameter space
    const visibleMinYWorld = Math.max(viewBottom, dataMinY);
    const visibleMaxYWorld = Math.min(viewTop, dataMaxY);
    const yRange = maxValues.y - minValues.y;
    const visibleMinY = yRange > 0 ? minValues.y + ((visibleMinYWorld + spread) / (2 * spread)) * yRange : minValues.y;
    const visibleMaxY = yRange > 0 ? minValues.y + ((visibleMaxYWorld + spread) / (2 * spread)) * yRange : maxValues.y;

    // Calculate nice tick values for visible Y-axis range
    const yTicks = this.calculateNiceInterval(visibleMinY, visibleMaxY);

    for (const value of yTicks) {
      // Calculate position based on actual value
      const normalizedY = yRange > 0 ? (value - minValues.y) / yRange : 0.5;
      const yPos = -spread + normalizedY * (spread * 2);

      // Only show labels that are within visible range
      if (yPos < visibleMinYWorld || yPos > visibleMaxYWorld) continue;

      // Determine decimal places based on magnitude
      const magnitude = Math.abs(value);
      let decimals = 0;
      if (magnitude < 1 && magnitude > 0) {
        decimals = Math.max(0, -Math.floor(Math.log10(magnitude)) + 1);
      } else if (magnitude >= 10) {
        decimals = 0;
      } else {
        decimals = 1;
      }

      // Create text sprite
      const texture = this.createTextTexture(value.toFixed(decimals), 64);
      const spriteMaterial = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0.95,
        sizeAttenuation: false // Keep labels same size regardless of zoom
      });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.position.set(yAxisX - labelScale * 1.2, yPos, 0);
      sprite.scale.set(labelScale * 1.2, labelScale * 0.6, 1);
      this.axisGroup.add(sprite);

      // Add tick mark on the y-axis line
      const tickGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(yAxisX, yPos, 0),
        new THREE.Vector3(yAxisX - labelScale * 0.2, yPos, 0)
      ]);
      const tickLine = new THREE.Line(tickGeometry, axisLinesMaterial);
      this.axisGroup.add(tickLine);
    }

    // Add axis titles positioned near the center of visible axis
    const xTitleTexture = this.createTextTexture(`Parameter ${xParamIndex}`, 72);
    const xTitleMaterial = new THREE.SpriteMaterial({
      map: xTitleTexture,
      transparent: true,
      opacity: 1.0,
      sizeAttenuation: false
    });
    const xTitle = new THREE.Sprite(xTitleMaterial);
    const xTitleX = (visibleMinXWorld + visibleMaxXWorld) / 2;
    xTitle.position.set(xTitleX, xAxisY - labelScale * 2, 0);
    xTitle.scale.set(labelScale * 2.5, labelScale * 0.8, 1);
    this.axisGroup.add(xTitle);

    const yTitleTexture = this.createTextTexture(`Parameter ${yParamIndex}`, 72);
    const yTitleMaterial = new THREE.SpriteMaterial({
      map: yTitleTexture,
      transparent: true,
      opacity: 1.0,
      sizeAttenuation: false
    });
    const yTitle = new THREE.Sprite(yTitleMaterial);
    const yTitleY = (visibleMinYWorld + visibleMaxYWorld) / 2;
    yTitle.position.set(yAxisX - labelScale * 3, yTitleY, 0);
    yTitle.scale.set(labelScale * 2.5, labelScale * 0.8, 1);
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

  public rearrangeByParameters(xParamIndex: number, yParamIndex: number, colorParamIndex: number = -1): void {
    if (!this.pointCloud || this.nodes.length === 0) return;

    this.ui.updateStatus(`Rearranging nodes by parameters ${xParamIndex} and ${yParamIndex}...`);

    // Update configuration
    this.config.parameterXAxis = xParamIndex;
    this.config.parameterYAxis = yParamIndex;
    this.config.useParameterPositioning = true;

    const spread = Math.sqrt(this.nodes.length) * 0.5;
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

    // Create axis visualization in Three.js scene
    this.createAxisVisualization(
      xParamIndex,
      yParamIndex,
      { x: minX, y: minY },
      { x: maxX, y: maxY },
      spread
    );

    const colorMsg = colorParamIndex >= 0 ? `, colored by P${colorParamIndex}` : '';
    this.ui.updateStatus(`Nodes rearranged by parameters ${xParamIndex} (X) and ${yParamIndex} (Y)${colorMsg}`);
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

    this.camera.left = -viewSize * aspect + this.panOffset.x;
    this.camera.right = viewSize * aspect + this.panOffset.x;
    this.camera.top = viewSize + this.panOffset.y;
    this.camera.bottom = -viewSize + this.panOffset.y;

    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
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
      
      // Ensure all nodes have parameters (generate if missing)
      this.nodes.forEach(node => {
        if (!node.parameters) {
          node.parameters = this.generateNodeParameters();
        }
      });
      
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

      const viewInfo = viewIds ? ` (views: ${viewIds.join(', ')})` : '';
      this.ui.updateStatus(`Loaded PRISM project "${projectId}"${viewInfo}: ${nodeCount.toLocaleString()} nodes, ${this.edges.length.toLocaleString()} edges`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load PRISM project';
      this.ui.showError(message);
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

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }

    this.prismAPI.clearCache();
    this.ui.dispose();
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