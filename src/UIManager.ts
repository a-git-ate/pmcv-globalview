import type { Graph2D } from './Graph2D.ts';
import type { LayoutType } from './types';

export class UIManager {
  private graph: Graph2D;
  private elements: Map<string, HTMLElement>;

  constructor(graph: Graph2D) {
    this.graph = graph;
    this.elements = new Map();
    this.cacheElements();
    this.setupEventListeners();
  }

  private cacheElements(): void {
    const elementIds = [
      'btn-load-api', 'btn-load-prism', 'btn-api-health', 'project-id', 'view-ids',
      'btn-1k', 'btn-10k', 'btn-100k', 'btn-500k', 'btn-1m',
      'btn-force', 'btn-force-directed', 'btn-grid', 'btn-circular',
      'btn-lod', 'btn-edges', 'btn-reset', 'btn-clusters', 'btn-export',
      'param-x-select', 'param-y-select', 'param-color-select', 'btn-apply-params', 'btn-reset-layout',
      'stats', 'progress', 'progress-bar'
    ];

    elementIds.forEach(id => {
      const element = document.getElementById(id);
      if (element) {
        this.elements.set(id, element);
      } else {
        console.warn(`Element with id '${id}' not found`);
      }
    });
  }

  private getElement(id: string): HTMLElement | null {
    return this.elements.get(id) || null;
  }

  private getButtonElement(id: string): HTMLButtonElement | null {
    const element = this.getElement(id);
    return element instanceof HTMLButtonElement ? element : null;
  }

  private setupEventListeners(): void {
    // API load buttons
    this.addClickListener('btn-load-api', () => this.graph.loadGraphFromAPI());
    this.addClickListener('btn-load-prism', () => this.handleLoadPrismProject());
    this.addClickListener('btn-api-health', () => this.handleAPIHealthCheck());
    
    // Node generation buttons
    this.addClickListener('btn-1k', () => this.graph.generateNodes(1000));
    this.addClickListener('btn-10k', () => this.graph.generateNodes(10000));
    this.addClickListener('btn-100k', () => this.graph.generateNodes(100000));
    this.addClickListener('btn-500k', () => this.graph.generateNodes(500000));
    this.addClickListener('btn-1m', () => this.graph.generateNodes(1000000));

    // Layout buttons
    this.addClickListener('btn-force', () => this.graph.applyLayout('force'));
    this.addClickListener('btn-force-directed', () => this.graph.applyLayout('force_directed'));
    this.addClickListener('btn-grid', () => this.graph.applyLayout('grid'));
    this.addClickListener('btn-circular', () => this.graph.applyLayout('circular'));

    // Control buttons
    this.addClickListener('btn-lod', () => this.graph.toggleLOD());
    this.addClickListener('btn-edges', () => this.graph.toggleEdges());
    this.addClickListener('btn-reset', () => this.graph.resetView());
    this.addClickListener('btn-clusters', () => this.graph.toggleClusters());
    this.addClickListener('btn-export', () => this.graph.exportImage());

    // Parameter view controls
    this.addClickListener('btn-apply-params', () => this.handleApplyParameters());
    this.addClickListener('btn-reset-layout', () => this.graph.resetToLayoutMode());
  }

  private addClickListener(elementId: string, handler: () => void): void {
    const button = this.getButtonElement(elementId);
    if (button) {
      button.addEventListener('click', handler);
    } else {
      console.warn(`Button '${elementId}' not found, cannot add click listener`);
    }
  }

  public updateStatus(message: string): void {
    const statusElement = this.getElement('stats');
    if (statusElement) {
      statusElement.textContent = message;
    }
    console.log(`[Graph] ${message}`);
  }

  public updateNodeCount(count: number): void {
    this.updateStatus(`${count.toLocaleString()} nodes`);
  }

  public updateZoomDisplay(zoomLevel: number): void {
    // Could add a dedicated zoom display element in the future
    console.log(`Zoom: ${zoomLevel.toFixed(1)}x`);
  }

  public disableButtons(): void {
    this.setButtonsDisabled(true);
  }

  public enableButtons(): void {
    this.setButtonsDisabled(false);
  }

  private setButtonsDisabled(disabled: boolean): void {
    const buttons = document.querySelectorAll('button');
    buttons.forEach((button: HTMLButtonElement) => {
      button.disabled = disabled;
    });
  }

  public updateProgress(percent: number): void {
    const progressBar = this.getElement('progress-bar') as HTMLElement | null;
    const progressContainer = this.getElement('progress') as HTMLElement | null;

    if (progressBar && progressContainer) {
      progressBar.style.width = `${percent}%`;

      if (percent >= 100) {
        setTimeout(() => {
          progressContainer.classList.add('hidden');
        }, 1000);
      } else {
        progressContainer.classList.remove('hidden');
      }
    }
  }

  public showError(message: string): void {
    this.updateStatus(`Error: ${message}`);
    console.error(`[Graph Error] ${message}`);
    
    // Could implement a proper error modal here
    alert(`Graph Error: ${message}`);
  }

  public logPerformance(nodeCount: number, renderTime: number): void {
    console.log(`[Performance] ${nodeCount.toLocaleString()} nodes rendered in ${renderTime.toFixed(2)}ms`);
  }

  // Event handlers for future extensibility
  public onLayoutChange(layoutType: LayoutType): void {
    console.log(`Layout changed to: ${layoutType}`);
  }

  public onNodeCountChange(count: number): void {
    this.updateNodeCount(count);
  }

  public onZoomChange(zoom: number): void {
    this.updateZoomDisplay(zoom);
  }

  private async handleLoadPrismProject(): Promise<void> {
    const projectIdInput = this.getElement('project-id') as HTMLInputElement;
    const viewIdsInput = this.getElement('view-ids') as HTMLInputElement;
    
    if (!projectIdInput) {
      this.showError('Project ID input not found');
      return;
    }
    
    const projectId = projectIdInput.value.trim();
    if (!projectId) {
      this.showError('Please enter a PRISM project ID');
      return;
    }
    
    let viewIds: number[] | undefined;
    if (viewIdsInput && viewIdsInput.value.trim()) {
      const viewIdsStr = viewIdsInput.value.trim();
      viewIds = viewIdsStr
        .split(',')
        .map(id => parseInt(id.trim()))
        .filter(id => !isNaN(id));
        
      if (viewIds.length === 0) {
        this.showError('Invalid view IDs format. Use comma-separated numbers (e.g., 1,2,3)');
        return;
      }
    }
    
    try {
      await this.graph.loadPrismProject(projectId, viewIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load PRISM project';
      this.showError(message);
    }
  }
  
  private handleApplyParameters(): void {
    const xSelect = this.getElement('param-x-select') as HTMLSelectElement;
    const ySelect = this.getElement('param-y-select') as HTMLSelectElement;
    const colorSelect = this.getElement('param-color-select') as HTMLSelectElement;

    if (!xSelect || !ySelect || !colorSelect) {
      console.warn('Parameter selection elements not found');
      return;
    }

    const xParamIndex = parseInt(xSelect.value);
    const yParamIndex = parseInt(ySelect.value);
    const colorParamIndex = parseInt(colorSelect.value);

    if (isNaN(xParamIndex) || isNaN(yParamIndex) || isNaN(colorParamIndex)) {
      console.warn('Invalid parameter indices');
      return;
    }

    this.graph.rearrangeByParameters(xParamIndex, yParamIndex, colorParamIndex);
  }

  private async handleAPIHealthCheck(): Promise<void> {
    this.updateStatus('Checking API health...');
    
    try {
      const isHealthy = await this.graph.checkAPIHealth();
      this.updateStatus(isHealthy ? 'API is healthy ✓' : 'API is not responding ✗');
    } catch (error) {
      this.updateStatus('API health check failed ✗');
    }
  }

  // Cleanup method for proper disposal
  public dispose(): void {
    // Remove event listeners if needed
    // Clear element cache
    this.elements.clear();
  }
}