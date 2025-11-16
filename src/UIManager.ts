import { getRandomValues } from 'crypto';
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
      'btn-1k', 'btn-10k', 'btn-100k', 'btn-500k', 'btn-1m',
      'btn-force-directed',
      'btn-lod', 'btn-edges', 'btn-reset', 'btn-clusters', 'btn-gridlines', 'btn-export',
      'param-x-select', 'param-y-select', 'param-color-select', 'btn-apply-params', 'btn-apply-color', 'btn-reset-layout',
      'progress', 'progress-bar',
      // Debug menu elements
      'btn-toggle-debug', 'debug-menu', 'btn-close-debug',
      'debug-status', 'debug-api-status', 'debug-model-info',
      'debug-node-count', 'debug-edge-count', 'debug-layout',
      'debug-renderer-info', 'debug-memory-info',
      'debug-render-time', 'debug-fps',
      'debug-zoom', 'debug-pan',
      // Parameter status (now in controls)
      'btn-toggle-param-status', 'param-status-content'
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
    // Node generation buttons
    this.addClickListener('btn-1k', () => this.graph.generateNodes(1000));
    this.addClickListener('btn-10k', () => this.graph.generateNodes(10000));
    this.addClickListener('btn-100k', () => this.graph.generateNodes(100000));
    this.addClickListener('btn-500k', () => this.graph.generateNodes(500000));
    this.addClickListener('btn-1m', () => this.graph.generateNodes(1000000));

    // Layout button
    this.addClickListener('btn-force-directed', () => this.graph.applyLayout('force'));

    // Control buttons
    this.addClickListener('btn-lod', () => this.graph.toggleLOD());
    this.addClickListener('btn-edges', () => this.graph.toggleEdges());
    this.addClickListener('btn-reset', () => this.graph.resetView());
    this.addClickListener('btn-clusters', () => this.graph.toggleClusters());
    this.addClickListener('btn-gridlines', () => this.graph.toggleGrid());
    this.addClickListener('btn-export', () => this.graph.exportImage());

    // Parameter view controls
    this.addClickListener('btn-apply-params', () => this.handleApplyParameters());
    this.addClickListener('btn-apply-color', () => this.handleApplyColor());
    this.addClickListener('btn-reset-layout', () => this.graph.resetToLayoutMode());

    // Debug menu controls
    this.addClickListener('btn-toggle-debug', () => this.toggleDebugMenu());
    this.addClickListener('btn-close-debug', () => this.closeDebugMenu());
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
    // Update debug menu status
    const debugStatusElement = this.getElement('debug-status');
    if (debugStatusElement) {
      debugStatusElement.textContent = message;
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

  private handleApplyParameters(): void {
    const xSelect = this.getElement('param-x-select') as HTMLSelectElement;
    const ySelect = this.getElement('param-y-select') as HTMLSelectElement;
    const colorSelect = this.getElement('param-color-select') as HTMLSelectElement;

    if (!xSelect || !ySelect || !colorSelect) {
      console.warn('Parameter selection elements not found');
      return;
    }

    const xParamIndex = xSelect.value;
    const yParamIndex = ySelect.value;
    const colorParamIndex = colorSelect.value;

    this.graph.rearrangeByParameters(xParamIndex, yParamIndex, colorParamIndex);
  }

  private handleApplyColor(): void {
    const colorSelect = this.getElement('param-color-select') as HTMLSelectElement;

    if (!colorSelect) {
      console.warn('Color selection element not found');
      return;
    }

    const colorParamIndex = parseInt(colorSelect.value);

    if (isNaN(colorParamIndex)) {
      console.warn('Invalid color parameter index');
      return;
    }

    if (colorParamIndex < 0) {
      this.updateStatus('Please select a color parameter (not "None")');
      return;
    }

    this.graph.applyColorParameter(colorParamIndex);
  }

  /**
   * Update API status display (in debug menu)
   */
  public updateAPIStatus(message: string, color: string = '#888'): void {
    const apiStatusElement = this.getElement('debug-api-status');
    if (apiStatusElement) {
      apiStatusElement.textContent = `API: ${message}`;
      apiStatusElement.style.color = color;
    }
  }

  /**
   * Update model info display (in debug menu)
   */
  public updateModelInfo(projectId: string, nodeCount: number, edgeCount: number, viewIds?: number[]): void {
    const modelInfoElement = this.getElement('debug-model-info');
    if (modelInfoElement) {
      const viewInfo = viewIds && viewIds.length > 0 ? ` (Views: ${viewIds.join(',')})` : '';
      modelInfoElement.textContent = `Model: ${projectId}${viewInfo} | ${nodeCount.toLocaleString()} nodes, ${edgeCount.toLocaleString()} edges`;
      modelInfoElement.style.color = '#4a4';
    }

    // Also update debug graph info
    const nodeCountElement = this.getElement('debug-node-count');
    if (nodeCountElement) {
      nodeCountElement.textContent = `Nodes: ${nodeCount.toLocaleString()}`;
    }

    const edgeCountElement = this.getElement('debug-edge-count');
    if (edgeCountElement) {
      edgeCountElement.textContent = `Edges: ${edgeCount.toLocaleString()}`;
    }
  }

  /**
   * Clear model info display
   */
  public clearModelInfo(): void {
    const modelInfoElement = this.getElement('debug-model-info');
    if (modelInfoElement) {
      modelInfoElement.textContent = 'Model: None loaded';
      modelInfoElement.style.color = '#888';
    }
  }

  /**
   * Toggle debug menu visibility
   */
  public toggleDebugMenu(): void {
    const debugMenu = this.getElement('debug-menu');
    if (debugMenu) {
      debugMenu.classList.toggle('hidden');

      // Update debug info when opening
      if (!debugMenu.classList.contains('hidden')) {
        this.updateDebugInfo();
      }
    }
  }

  /**
   * Close debug menu
   */
  public closeDebugMenu(): void {
    const debugMenu = this.getElement('debug-menu');
    if (debugMenu) {
      debugMenu.classList.add('hidden');
    }
  }

  /**
   * Update all debug information
   */
  public updateDebugInfo(): void {
    // Update renderer info
    const renderer = (this.graph as any).renderer;
    if (renderer) {
      const info = renderer.info;
      const rendererInfoElement = this.getElement('debug-renderer-info');
      if (rendererInfoElement && info) {
        rendererInfoElement.textContent = `Geometries: ${info.memory?.geometries || 0}, Textures: ${info.memory?.textures || 0}`;
      }

      const memoryInfoElement = this.getElement('debug-memory-info');
      if (memoryInfoElement && info) {
        memoryInfoElement.textContent = `Calls: ${info.render?.calls || 0}, Triangles: ${info.render?.triangles || 0}, Points: ${info.render?.points || 0}`;
      }
    }

    // Update performance info
    const renderTimeElement = this.getElement('debug-render-time');
    if (renderTimeElement) {
      const renderTime = this.graph.getLastRenderTime();
      renderTimeElement.textContent = `Render Time: ${renderTime.toFixed(2)}ms`;
    }

    // Update zoom and pan
    const zoomElement = this.getElement('debug-zoom');
    const panElement = this.getElement('debug-pan');
    if (zoomElement) {
      const zoom = (this.graph as any).zoomLevel || 1.0;
      zoomElement.textContent = `Zoom: ${zoom.toFixed(2)}x`;
    }
    if (panElement) {
      const pan = (this.graph as any).panOffset || { x: 0, y: 0 };
      panElement.textContent = `Pan: (${pan.x.toFixed(2)}, ${pan.y.toFixed(2)})`;
    }

    // Update layout info
    const layoutElement = this.getElement('debug-layout');
    if (layoutElement) {
      const layout = (this.graph as any).currentLayout || 'none';
      layoutElement.textContent = `Layout: ${layout}`;
    }
  }

  /**
   * Update parameter selection dropdowns with actual parameter names
   */
  public updateParameterSelections(paramLabels: Record<string, string[]>): void {
    const xSelect = this.getElement('param-x-select') as HTMLSelectElement;
    const ySelect = this.getElement('param-y-select') as HTMLSelectElement;
    const colorSelect = this.getElement('param-color-select') as HTMLSelectElement;

    if (!xSelect || !ySelect || !colorSelect) {
      console.warn('Parameter selection elements not found');
      return;
    }

    // Store current selections
    const currentX = xSelect.value;
    const currentY = ySelect.value;
    const currentColor = colorSelect.value;

    // Update X-axis dropdown
    this.populateParameterDropdown(xSelect, paramLabels);
    xSelect.value = currentX;

    // Update Y-axis dropdown
    this.populateParameterDropdown(ySelect, paramLabels);
    ySelect.value = currentY;

    // Update Color dropdown (includes "None" option)
    colorSelect.innerHTML = '<option value="-1">None</option>';
    Object.values(paramLabels).forEach(value => {
      value.forEach(param => {
        const option = document.createElement('option');
        option.value = param;
        option.textContent = param;
        option.title = param;
        colorSelect.appendChild(option);
      });
    });
    colorSelect.value = currentColor;

    console.log(`[UI] Parameter dropdowns updated with ${paramLabels.length} parameters`);
  }

  /**
   * Populate a parameter dropdown with options
   */
  private populateParameterDropdown(
    select: HTMLSelectElement,
    paramLabels: Record<string, string[]>
  ): void {
    select.innerHTML = '';
    Object.values(paramLabels).forEach(value => {
      value.forEach(param => {
        const option = document.createElement('option');
        option.value = param;
        option.textContent = param;
        option.title = param;
        select.appendChild(option);
      });
    });
  }

  // Cleanup method for proper disposal
  public dispose(): void {
    // Remove event listeners if needed
    // Clear element cache
    this.elements.clear();
  }
}