import type { Graph2D } from './Graph2D.ts';

export interface ProgressConfig {
  title?: string;
  showPercentage?: boolean;
  showBytes?: boolean;
  showNodeCount?: boolean;
  showAbortButton?: boolean;
  onAbort?: () => void;
}

export class ProgressIndicator {
  private container: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
  private titleElement: HTMLElement | null = null;
  private statusElement: HTMLElement | null = null;
  private percentageElement: HTMLElement | null = null;
  private abortButton: HTMLElement | null = null;
  private isVisible: boolean = false;
  private startTime: number = 0;
  private timerInterval: number | null = null;
  private abortCallback: (() => void) | null = null;

  constructor() {
    this.createProgressWindow();
  }

  /**
   * Create the progress indicator window
   */
  private createProgressWindow(): void {
    // Create container
    this.container = document.createElement('div');
    this.container.id = 'progress-indicator';
    this.container.className = 'progress-indicator hidden';

    // Create title bar
    const titleBar = document.createElement('div');
    titleBar.className = 'progress-title-bar';

    this.titleElement = document.createElement('span');
    this.titleElement.className = 'progress-title';
    this.titleElement.textContent = 'Loading...';
    titleBar.appendChild(this.titleElement);

    // Create abort button
    this.abortButton = document.createElement('button');
    this.abortButton.className = 'progress-abort-button hidden';
    this.abortButton.textContent = '×';
    this.abortButton.title = 'Cancel operation';
    this.abortButton.addEventListener('click', () => this.handleAbort());
    titleBar.appendChild(this.abortButton);

    this.container.appendChild(titleBar);

    // Create progress bar container
    const progressBarContainer = document.createElement('div');
    progressBarContainer.className = 'progress-bar-container';

    this.progressBar = document.createElement('div');
    this.progressBar.className = 'progress-bar-fill';
    this.progressBar.style.width = '0%';

    progressBarContainer.appendChild(this.progressBar);
    this.container.appendChild(progressBarContainer);

    // Create status text
    this.statusElement = document.createElement('div');
    this.statusElement.className = 'progress-status';
    this.statusElement.textContent = '';
    this.container.appendChild(this.statusElement);

    // Create percentage text
    this.percentageElement = document.createElement('div');
    this.percentageElement.className = 'progress-percentage';
    this.percentageElement.textContent = '0%';
    this.container.appendChild(this.percentageElement);

    // Add to document
    document.body.appendChild(this.container);
  }

  /**
   * Show the progress indicator
   */
  public show(config?: ProgressConfig): void {
    if (!this.container) return;

    this.isVisible = true;
    this.container.classList.remove('hidden');

    if (config?.title) {
      this.setTitle(config.title);
    }

    // Set abort callback and show/hide button
    if (config?.onAbort) {
      this.abortCallback = config.onAbort;
      this.abortButton?.classList.remove('hidden');
    } else {
      this.abortCallback = null;
      this.abortButton?.classList.add('hidden');
    }

    // Reset progress
    this.updateProgress(0);

    // Start timer
    this.startTimer();
  }

  /**
   * Handle abort button click
   */
  private handleAbort(): void {
    if (this.abortCallback) {
      this.abortCallback();
    }
    this.hide();
  }

  /**
   * Hide the progress indicator
   */
  public hide(): void {
    if (!this.container) return;

    this.isVisible = false;
    this.container.classList.add('hidden');

    // Stop timer
    this.stopTimer();

    // Reset to defaults
    this.updateProgress(0);
    this.setStatus('');
  }

  /**
   * Update the progress bar (0-100)
   */
  public updateProgress(percentage: number): void {
    if (!this.progressBar || !this.percentageElement) return;

    const clampedPercentage = Math.min(100, Math.max(0, percentage));
    this.progressBar.style.width = `${clampedPercentage}%`;
    this.percentageElement.textContent = `${Math.round(clampedPercentage)}%`;
  }

  /**
   * Set the title text
   */
  public setTitle(title: string): void {
    if (this.titleElement) {
      this.titleElement.textContent = title;
    }
  }

  /**
   * Set the status text (for showing additional info like bytes, nodes, etc.)
   */
  public setStatus(status: string): void {
    if (this.statusElement) {
      this.statusElement.textContent = status;
    }
  }

  /**
   * Update with bytes loaded information
   */
  public updateBytes(loaded: number, total?: number): void {
    const loadedMB = (loaded / (1024 * 1024)).toFixed(2);

    if (total && total > 0) {
      const totalMB = (total / (1024 * 1024)).toFixed(2);
      const percentage = (loaded / total) * 100;
      this.updateProgress(percentage);
      this.setStatus(`${loadedMB} MB / ${totalMB} MB`);
    } else {
      this.setStatus(`${loadedMB} MB loaded`);
    }
  }

  /**
   * Update with node count information
   */
  public updateNodeCount(count: number, total?: number): void {
    if (total && total > 0) {
      const percentage = (count / total) * 100;
      this.updateProgress(percentage);
      this.setStatus(`${count.toLocaleString()} / ${total.toLocaleString()} nodes`);
    } else {
      this.setStatus(`${count.toLocaleString()} nodes processed`);
    }
  }

  /**
   * Set indeterminate state (when progress is unknown)
   */
  public setIndeterminate(status: string = 'Processing...'): void {
    if (!this.progressBar) return;

    this.progressBar.classList.add('indeterminate');
    this.setStatus(status);

    if (this.percentageElement) {
      this.percentageElement.textContent = '';
    }
  }

  /**
   * Clear indeterminate state
   */
  public clearIndeterminate(): void {
    if (!this.progressBar) return;

    this.progressBar.classList.remove('indeterminate');
  }

  /**
   * Check if the progress indicator is visible
   */
  public isShowing(): boolean {
    return this.isVisible;
  }

  /**
   * Start the elapsed time timer
   */
  private startTimer(): void {
    this.stopTimer(); // Clear any existing timer
    this.startTime = Date.now();

    this.timerInterval = window.setInterval(() => {
      this.updateElapsedTime();
    }, 100); // Update every 100ms
  }

  /**
   * Stop the elapsed time timer
   */
  private stopTimer(): void {
    if (this.timerInterval !== null) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  /**
   * Update the elapsed time display
   */
  private updateElapsedTime(): void {
    const elapsed = Date.now() - this.startTime;
    const seconds = Math.floor(elapsed / 1000);
    const milliseconds = Math.floor((elapsed % 1000) / 100);

    const elapsedText = `${seconds}.${milliseconds}s`;

    // Update percentage element to show elapsed time if in indeterminate mode
    if (this.percentageElement && this.progressBar?.classList.contains('indeterminate')) {
      this.percentageElement.textContent = elapsedText;
    }
  }

  /**
   * Dispose of the progress indicator
   */
  public dispose(): void {
    this.stopTimer();

    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
    this.progressBar = null;
    this.titleElement = null;
    this.statusElement = null;
    this.percentageElement = null;
  }
}

export class UIManager {
  private graph: Graph2D;
  private elements: Map<string, HTMLElement>;
  public progressIndicator: ProgressIndicator;

  constructor(graph: Graph2D) {
    this.graph = graph;
    this.elements = new Map();
    this.progressIndicator = new ProgressIndicator();
    this.cacheElements();
    this.setupEventListeners();
  }

  private cacheElements(): void {
    const elementIds = [
      'btn-lod', 'btn-edges', 'btn-reset', 'btn-gridlines', 'btn-export',
      'param-x-select', 'param-y-select', 'param-color-select', 'btn-apply-params', 'btn-apply-color', 'btn-reset-layout',
      'progress', 'progress-bar',
      // Debug menu elements
      'btn-toggle-debug', 'debug-menu', 'btn-close-debug',
      'debug-status', 'debug-api-status', 'debug-model-info',
      'debug-node-count', 'debug-geometry-count', 'debug-edge-count', 'debug-layout',
      'debug-renderer-info', 'debug-memory-info',
      'debug-render-time', 'debug-fps',
      'debug-zoom', 'debug-pan',
      // PCA menu elements
      'btn-toggle-pca', 'pca-menu', 'btn-close-pca',
      // Parameter status (now in controls)
      'btn-toggle-param-status', 'param-status-content',
      // Selected nodes
      'btn-clear-selection', 'btn-show-all-nodes', 'btn-table-view', 'selected-nodes-list', 'selected-nodes-counter',
      'btn-select-all-list', 'btn-deselect-all-list', 'btn-open-local-view', 'selected-nodes-checked-counter',
      // Node filtering buttons
      'btn-remove-t-nodes', 'btn-remove-s-nodes'
    ];

    elementIds.forEach(id => {
      const element = document.getElementById(id);
      if (element) {
        this.elements.set(id, element);
      } else {
        console.warn(`Element with id '${id}' not found`);
      }
    });

    // Cache slider elements
    const nodeSizeSlider = document.getElementById('node-size-slider');
    const labelSizeSlider = document.getElementById('label-size-slider');
    if (nodeSizeSlider) this.elements.set('node-size-slider', nodeSizeSlider);
    if (labelSizeSlider) this.elements.set('label-size-slider', labelSizeSlider);
  }

  private getElement(id: string): HTMLElement | null {
    return this.elements.get(id) || null;
  }

  private getButtonElement(id: string): HTMLButtonElement | null {
    const element = this.getElement(id);
    return element instanceof HTMLButtonElement ? element : null;
  }

  private setupEventListeners(): void {
    // View control buttons
    this.addClickListener('btn-edges', () => this.graph.toggleEdges());
    this.addClickListener('btn-reset', () => this.graph.resetView());
    this.addClickListener('btn-gridlines', () => this.graph.toggleGrid());
    this.addClickListener('btn-export', () => this.graph.exportImage());

    // Parameter view controls
    this.addClickListener('btn-apply-params', () => this.handleApplyParameters());
    this.addClickListener('btn-apply-color', () => this.handleApplyColor());
    this.addClickListener('btn-reset-layout', () => this.graph.resetToLayoutMode());

    // Debug menu controls
    this.addClickListener('btn-toggle-debug', () => this.toggleDebugMenu());
    this.addClickListener('btn-close-debug', () => this.closeDebugMenu());

    // PCA menu controls
    this.addClickListener('btn-toggle-pca', () => this.togglePCAMenu());
    this.addClickListener('btn-close-pca', () => this.closePCAMenu());

    // Selection controls
    this.addClickListener('btn-clear-selection', () => this.graph.clearSelection());
    this.addClickListener('btn-show-all-nodes', () => this.graph.selectAllNodes());
    this.addClickListener('btn-table-view', () => {
      const selectedNodes = this.graph.getSelectedNodes();
      this.graph.openTableView(selectedNodes);
    });
    this.addClickListener('btn-select-all-list', () => this.graph.selectAllInList());
    this.addClickListener('btn-deselect-all-list', () => this.graph.deselectAllInList());
    this.addClickListener('btn-open-local-view', () => this.graph.openLocalView());

    // Node filtering controls
    this.addClickListener('btn-remove-t-nodes', () => this.graph.removeTransitionNodes());
    this.addClickListener('btn-remove-s-nodes', () => this.graph.removeStateNodes());

    // Slider controls
    this.setupSliders();

    // Setup collapsible sections
    this.setupCollapsibleSections();
  }

  private setupCollapsibleSections(): void {
    const toggleButtons = document.querySelectorAll('.section-toggle');

    toggleButtons.forEach(button => {
      button.addEventListener('click', () => {
        const target = (button as HTMLElement).getAttribute('data-target');
        if (!target) return;

        const content = document.getElementById(target);
        if (!content) return;

        // Toggle visibility
        const isHidden = content.classList.contains('hidden');
        content.classList.toggle('hidden');

        // Update arrow indicator
        const strong = button.querySelector('strong');
        if (strong) {
          const text = strong.textContent || '';
          if (isHidden) {
            strong.textContent = text.replace('►', '▼');
          } else {
            strong.textContent = text.replace('▼', '►');
          }
        }
      });
    });
  }

  private setupSliders(): void {
    // Node size slider
    const nodeSizeSlider = document.getElementById('node-size-slider') as HTMLInputElement;
    const nodeSizeValue = document.getElementById('node-size-value');

    if (nodeSizeSlider && nodeSizeValue) {
      nodeSizeSlider.addEventListener('input', () => {
        const size = parseFloat(nodeSizeSlider.value);
        nodeSizeValue.textContent = size.toFixed(1);
        this.graph.setNodePointSize(size);
      });
    }

    // Label size slider
    const labelSizeSlider = document.getElementById('label-size-slider') as HTMLInputElement;
    const labelSizeValue = document.getElementById('label-size-value');

    if (labelSizeSlider && labelSizeValue) {
      labelSizeSlider.addEventListener('input', () => {
        const size = parseInt(labelSizeSlider.value);
        labelSizeValue.textContent = size.toString();
        this.graph.setStackLabelSize(size);
      });
    }
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

  public setEdgesButtonEnabled(enabled: boolean): void {
    const edgesButton = this.getElement('btn-edges') as HTMLButtonElement | null;
    if (edgesButton) {
      edgesButton.disabled = !enabled;
      if (!enabled) {
        edgesButton.style.opacity = '0.5';
        edgesButton.style.cursor = 'not-allowed';
      } else {
        edgesButton.style.opacity = '1';
        edgesButton.style.cursor = 'pointer';
      }
    }
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
    //console.log(`[Performance] ${nodeCount.toLocaleString()} nodes rendered in ${renderTime.toFixed(2)}ms`);
  }

  // Event handlers for future extensibility
  public onNodeCountChange(count: number): void {
    this.updateNodeCount(count);
  }

  public onZoomChange(zoom: number): void {
    this.updateZoomDisplay(zoom);
  }

  private async handleApplyParameters(): Promise<void> {
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

    await this.graph.rearrangeByParameters(xParamIndex, yParamIndex, colorParamIndex);
  }

  private handleApplyColor(): void {
    const colorSelect = this.getElement('param-color-select') as HTMLSelectElement;

    if (!colorSelect) {
      console.warn('Color selection element not found');
      return;
    }

    const colorParamIndex = colorSelect.value;

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
   * Toggle PCA menu visibility
   */
  public togglePCAMenu(): void {
    const pcaMenu = this.getElement('pca-menu');
    if (pcaMenu) {
      pcaMenu.classList.toggle('hidden');
    }
  }

  /**
   * Close PCA menu
   */
  public closePCAMenu(): void {
    const pcaMenu = this.getElement('pca-menu');
    if (pcaMenu) {
      pcaMenu.classList.add('hidden');
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

    // Update geometry points count
    const geometryCountElement = this.getElement('debug-geometry-count');
    if (geometryCountElement) {
      const geometryCount = this.graph.getGeometryPointCount();
      const nodeCount = this.graph.getNodeCount();
      const validation = this.graph.validateGeometryMapping();

      if (validation.valid) {
        geometryCountElement.textContent = `Geometry: ${geometryCount} points (${nodeCount} nodes)`;
        geometryCountElement.style.color = '#4CAF50'; // Green for valid
      } else {
        geometryCountElement.textContent = `Geometry: ${geometryCount} ⚠️ ${validation.details}`;
        geometryCountElement.style.color = '#FF5722'; // Red for error
      }
    }
  }

  /**
   * Update parameter selection dropdowns with actual parameter names
   * @param paramLabels Parameter labels to populate dropdowns
   * @param selections Optional selections to apply {x, y, color}
   */
  public updateParameterSelections(
    paramLabels: Record<string, string[]>,
    selections?: { x?: string; y?: string; color?: string }
  ): void {
    const xSelect = this.getElement('param-x-select') as HTMLSelectElement;
    const ySelect = this.getElement('param-y-select') as HTMLSelectElement;
    const colorSelect = this.getElement('param-color-select') as HTMLSelectElement;

    if (!xSelect || !ySelect || !colorSelect) {
      console.warn('Parameter selection elements not found');
      return;
    }

    // Store current selections or use provided selections
    // Default to "__type__" for color if no selection provided and no current value
    const currentX = selections?.x ?? xSelect.value;
    const currentY = selections?.y ?? ySelect.value;
    const currentColor = selections?.color ?? (colorSelect.value || '__type__');

    // Update X-axis dropdown
    this.populateParameterDropdown(xSelect, paramLabels);
    xSelect.value = currentX;

    // Update Y-axis dropdown
    this.populateParameterDropdown(ySelect, paramLabels);
    ySelect.value = currentY;

    // Update Color dropdown (includes "None" and "Type" options)
    colorSelect.innerHTML = '<option value="-1">None</option><option value="__type__">Type (s=blue, t=grey, init=red)</option>';
    // Filter out Action Parameter category from color dropdown
    Object.entries(paramLabels).forEach(([category, params]) => {
      if (category === 'Action Parameter') {
        return; // Skip Action Parameter category
      }
      params.forEach(param => {
        // Use full "category::param" format for option value (internal use)
        const fullParamName = `${category}::${param}`;

        // Get which node types have this parameter
        const nodeTypes = this.graph.prismAPI.getParameterNodeTypes(fullParamName);
        let prefix = '';
        if (nodeTypes === 'st') prefix = '[s,t] ';
        else if (nodeTypes === 's') prefix = '[s] ';
        else if (nodeTypes === 't') prefix = '[t] ';

        const option = document.createElement('option');
        option.value = fullParamName; // Internal value includes category
        option.textContent = prefix + param; // Display only shows param name
        option.title = fullParamName; // Tooltip shows full name
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
    // Filter out Action Parameter category from plotting dropdowns
    Object.entries(paramLabels).forEach(([category, params]) => {
      if (category === 'Action Parameter') {
        return; // Skip Action Parameter category
      }
      params.forEach(param => {
        // Use full "category::param" format for option value (internal use)
        const fullParamName = `${category}::${param}`;

        // Get which node types have this parameter
        const nodeTypes = this.graph.prismAPI.getParameterNodeTypes(fullParamName);
        let prefix = '';
        if (nodeTypes === 'st') prefix = '[s,t] ';
        else if (nodeTypes === 's') prefix = '[s] ';
        else if (nodeTypes === 't') prefix = '[t] ';

        const option = document.createElement('option');
        option.value = fullParamName; // Internal value includes category
        option.textContent = prefix + param; // Display only shows param name
        option.title = fullParamName; // Tooltip shows full name
        select.appendChild(option);
      });
    });
  }

  /**
   * Update parameter view label to show which node types are currently visible
   */
  public updateParameterViewLabel(visibleNodeTypes: Set<'s' | 't'>): void {
    const label = document.getElementById('param-view-display-label');
    if (!label) return;

    if (visibleNodeTypes.size === 0) {
      // No nodes visible
      label.textContent = 'No nodes match the selected parameters';
      label.className = 'param-view-label';
      label.classList.remove('hidden');
    } else if (visibleNodeTypes.size === 1) {
      // Only one type visible
      const type = Array.from(visibleNodeTypes)[0];
      const typeName = type === 's' ? 'State nodes' : 'Transition nodes';
      label.textContent = `Visible: ${typeName} only`;
      label.className = 'param-view-label';
      label.classList.remove('hidden');
    } else {
      // Both types visible
      label.textContent = 'Visible: State and Transition nodes';
      label.className = 'param-view-label';
      label.classList.remove('hidden');
    }
  }

  // Cleanup method for proper disposal
  public dispose(): void {
    // Dispose progress indicator
    this.progressIndicator.dispose();

    // Remove event listeners if needed
    // Clear element cache
    this.elements.clear();
  }
}