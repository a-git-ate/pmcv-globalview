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

    // Initialize nodes first
    for (let i = 0; i < count; i++) {
      // Store node data with parameters first
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

      // Calculate position based on parameters or layout
      let position: THREE.Vector2;
      if (this.config.useParameterPositioning) {
        position = this.calculateParameterPosition(nodeData, spread);
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
    
    // Update colors and sizes based on final positions and connectivity
    for (let i = 0; i < count; i++) {
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

  // Gaussian distribution generator using Box-Muller transform
  private generateGaussian(mean: number = 50, stdDev: number = 15): number {
    let u = 0, v = 0;
    while(u === 0) u = Math.random(); // Converting [0,1) to (0,1)
    while(v === 0) v = Math.random();
    
    const normal = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    const value = mean + stdDev * normal;
    
    // Clamp to [0, 100] range
    return Math.max(0, Math.min(100, value));
  }

  // Generate 10 parameters with Gaussian distribution for a node
  private generateNodeParameters(): [number, number, number, number, number, number, number, number, number, number] {
    const parameters: [number, number, number, number, number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    
    for (let i = 0; i < 10; i++) {
      // Each parameter gets a random center for Gaussian distribution
      const randomCenter = Math.random() * 100;
      const stdDev = 15 + Math.random() * 10; // Standard deviation between 15-25
      parameters[i] = this.generateGaussian(randomCenter, stdDev);
    }
    
    return parameters;
  }

  // Calculate position based on parameter values
  private calculateParameterPosition(node: NodeData, spread: number): THREE.Vector2 {
    if (this.config.useParameterPositioning) {
      const xParam = this.config.parameterXAxis ?? 0;
      const yParam = this.config.parameterYAxis ?? 1;
      
      // Map parameter values (0-100) to position coordinates
      const x = ((node.parameters[xParam] - 50) / 50) * spread;
      const y = ((node.parameters[yParam] - 50) / 50) * spread;
      
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
    const baseSize = (1 - normalizedDistance * 0.3) * 12 + 6; // Three times larger: 6-18
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
    const iterations = (this.config as any).iterations || 500;
    const forceStrength = (this.config as any).forceStrength || 0.3;
    const springLength = (this.config as any).springLength || 20;
    
    // Initialize simulation nodes
    const simNodes: ForceSimulationNode[] = this.nodes.map((node, i) => ({
      ...node,
      x: positions[i * 3] || (Math.random() - 0.5) * spread,
      y: positions[i * 3 + 1] || (Math.random() - 0.5) * spread,
      z: 0,
      vx: 0,
      vy: 0
    }));
    
    for (let iter = 0; iter < iterations; iter++) {
      // Reset forces
      simNodes.forEach(node => {
        node.vx = 0;
        node.vy = 0;
      });
      
      // Repulsion between all nodes
      for (let i = 0; i < simNodes.length; i++) {
        for (let j = i + 1; j < simNodes.length; j++) {
          const dx = simNodes[i].x - simNodes[j].x;
          const dy = simNodes[i].y - simNodes[j].y;
          const distance = Math.sqrt(dx * dx + dy * dy) + 0.1;
          
          const force = forceStrength * 500 / (distance * distance);
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          
          simNodes[i].vx += fx;
          simNodes[i].vy += fy;
          simNodes[j].vx -= fx;
          simNodes[j].vy -= fy;
        }
      }
      
      // Spring forces for connected nodes
      this.edges.forEach(edge => {
        const nodeA = simNodes[edge.from];
        const nodeB = simNodes[edge.to];
        if (!nodeA || !nodeB) return;
        
        const dx = nodeB.x - nodeA.x;
        const dy = nodeB.y - nodeA.y;
        const distance = Math.sqrt(dx * dx + dy * dy) + 0.1;
        
        const force = forceStrength * (distance - springLength) / distance;
        const fx = dx * force;
        const fy = dy * force;
        
        nodeA.vx += fx;
        nodeA.vy += fy;
        nodeB.vx -= fx;
        nodeB.vy -= fy;
      });
      
      // Center force to pull nodes toward origin
      const centerForce = 0.01;
      simNodes.forEach(node => {
        const distance = Math.sqrt(node.x * node.x + node.y * node.y) + 0.1;
        const force = centerForce * distance;
        node.vx -= (node.x / distance) * force;
        node.vy -= (node.y / distance) * force;
      });
      
      // Apply forces and update positions
      const damping = 0.9;
      simNodes.forEach((node, i) => {
        node.vx *= damping;
        node.vy *= damping;
        node.x += node.vx;
        node.y += node.vy;
        
        // Update positions array
        positions[i * 3] = node.x;
        positions[i * 3 + 1] = node.y;
      });
    }
    
    // Update node data with final positions
    simNodes.forEach((node, i) => {
      this.nodes[i].x = node.x;
      this.nodes[i].y = node.y;
    });
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
      size: 12.0,
      vertexColors: true,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      alphaTest: 0.1
    });

    this.pointCloud = new THREE.Points(geometry, material);
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

  public rearrangeByParameters(xParamIndex: number, yParamIndex: number): void {
    if (!this.pointCloud || this.nodes.length === 0) return;

    this.ui.updateStatus(`Rearranging nodes by parameters ${xParamIndex} and ${yParamIndex}...`);
    
    // Update configuration
    this.config.parameterXAxis = xParamIndex;
    this.config.parameterYAxis = yParamIndex;
    this.config.useParameterPositioning = true;

    const spread = Math.sqrt(this.nodes.length) * 0.5;
    const positions = this.pointCloud.geometry.attributes.position as THREE.BufferAttribute;

    // Recalculate positions based on parameters
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const newPosition = this.calculateParameterPosition(node, spread);
      
      // Update node data
      node.x = newPosition.x;
      node.y = newPosition.y;
      
      // Update positions buffer
      positions.setXYZ(i, newPosition.x, newPosition.y, 0);
    }

    positions.needsUpdate = true;
    this.ui.updateStatus(`Nodes rearranged by parameters ${xParamIndex} (X) and ${yParamIndex} (Y)`);
  }

  public resetToLayoutMode(): void {
    this.config.useParameterPositioning = false;
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