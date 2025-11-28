import { appendFile } from 'fs';
import type { Graph2D } from './Graph2D';
import type { NodeData } from './types';
import type { PrismAPI, ParameterMetadata } from './PrismAPI';

export class ProjectManager {
  private graph: Graph2D;
  private prismAPI: PrismAPI;
  private currentProjectId: string | null = null;
  private availableProjects: string[] = [];
  private statusPollInterval: number | null = null;
  private readonly POLL_INTERVAL_MS = 2000; // Poll every 2 seconds
  private cachedParameterStructure: any = null; // Cache the initial parameter structure
  private cachedStatus: any = null;
  // DOM Elements
  private projectTabsContainer: HTMLElement | null = null;
  private checkButton: HTMLButtonElement | null = null;
  private resetButton: HTMLButtonElement | null = null;
  private toggleParamStatusButton: HTMLButtonElement | null = null;
  private paramStatusContent: HTMLElement | null = null;

  constructor(graph: Graph2D, prismAPI: PrismAPI) {
    this.graph = graph;
    this.prismAPI = prismAPI;
    this.cacheElements();
    this.setupEventListeners();
    this.initialize();
  }

  private cacheElements(): void {
    this.projectTabsContainer = document.getElementById('project-tabs');
    this.checkButton = document.getElementById('btn-check-model') as HTMLButtonElement;
    this.resetButton = document.getElementById('btn-reset-model') as HTMLButtonElement;
    this.toggleParamStatusButton = document.getElementById('btn-toggle-param-status') as HTMLButtonElement;
    this.paramStatusContent = document.getElementById('param-status-content');
  }

  private setupEventListeners(): void {
    // Check model button
    this.checkButton?.addEventListener('click', () => this.handleCheckModel());

    // Reset model button
    this.resetButton?.addEventListener('click', () => this.handleResetModel());

    // Toggle parameter status button
    this.toggleParamStatusButton?.addEventListener('click', () => this.toggleParameterStatus());
  }

  private async initialize(): Promise<void> {
    try {
      // Load available projects
      await this.loadAvailableProjects();
    } catch (error) {
      console.error('[ProjectManager] Failed to initialize:', error);
    }
  }

  /**
   * Load and display available projects
   */
  public async loadAvailableProjects(): Promise<void> {
    try {
      this.availableProjects = await this.prismAPI.fetchProjects();
      this.renderProjectTabs();

      // Select first project by default if available
      if (this.availableProjects.length > 0 && !this.currentProjectId) {
        this.selectProject(this.availableProjects[0]);
      }
    } catch (error) {
      console.error('[ProjectManager] Failed to load projects:', error);
      this.graph.ui.showError('Failed to load available projects');
    }
  }

  /**
   * Render project tabs in the taskbar
   */
  private renderProjectTabs(): void {
    if (!this.projectTabsContainer) return;

    this.projectTabsContainer.innerHTML = '';

    this.availableProjects.forEach(projectId => {
      const tab = document.createElement('button');
      tab.className = 'project-tab';
      tab.textContent = projectId;
      tab.dataset.projectId = projectId;

      if (projectId === this.currentProjectId) {
        tab.classList.add('active');
      }

      tab.addEventListener('click', () => this.selectProject(projectId));

      this.projectTabsContainer!.appendChild(tab);
    });
  }

  /**
   * Select a project and update UI
   */
  public async selectProject(projectId: string): Promise<void> {
    this.currentProjectId = projectId;

    // Clear cached parameter structure and metadata from previous model
    this.cachedParameterStructure = null;
    this.prismAPI.clearParameterMetadata();

    // Update active tab
    const tabs = this.projectTabsContainer?.querySelectorAll('.project-tab');
    tabs?.forEach(tab => {
      if ((tab as HTMLElement).dataset.projectId === projectId) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });

    // Enable check and reset buttons
    if (this.checkButton) {
      this.checkButton.disabled = false;
    }
    if (this.resetButton) {
      this.resetButton.disabled = false;
    }

    // Load the graph data for the selected project
    await this.graph.loadGraph(projectId);

    // Fetch and display project status
    await this.updateProjectStatus();
  }

  /**
   * Update project status and display in panel
   */
  private async updateProjectStatus(): Promise<void> {
    if (!this.currentProjectId) return;

    try {
      // Get parameter labels before fetching new status
      const previousParamLabels = this.prismAPI.getParameterLabels('s');

      // Fetch new status (this will update parameterMetadata in PrismAPI)
      const status = await this.prismAPI.fetchProjectStatus(this.currentProjectId);

      // Cache the parameter structure on first load (to preserve it after reset)
      if (!this.cachedParameterStructure && status?.info) {
        this.cachedParameterStructure = this.deepCloneParameterStructure(status.info);
      }

      // Merge cached structure with current status to ensure all parameters are shown
      let mergedStatus = this.mergeParameterStructure(status);

      //mergedStatus = addNonStringParams(mergedStatus);

      this.cachedStatus = mergedStatus;

      this.displayParameterStatus(mergedStatus);

      // Show parameter status section when selecting a project
      this.showParameterStatus();

      // Check if parameters have changed and update dropdowns if needed
      const currentParamLabels = this.prismAPI.getParameterLabels('s');
      if (this.hasParameterDelta(previousParamLabels, currentParamLabels)) {
        console.log('[ProjectManager] Parameter delta detected, updating dropdowns');
        this.graph.ui.updateParameterSelections(currentParamLabels);
      }

      // Start polling if there are missing parameters
      if (this.prismAPI.hasMissingParameters(mergedStatus)) {
        this.startStatusPolling();
      } else {
        this.stopStatusPolling();
      }
    } catch (error) {
      console.error('[ProjectManager] Failed to fetch project status:', error);
    }
  }



  /**
   * Deep clone the parameter structure to preserve it
   */
  private deepCloneParameterStructure(info: any): any {
    return JSON.parse(JSON.stringify(info));
  }

  /**
   * Merge cached parameter structure with current status
   * This ensures all parameters are shown even after reset
   */
  private mergeParameterStructure(status: any): any {
    if (!this.cachedParameterStructure) {
      return status;
    }

    // If status has no info, create one from cached structure
    if (!status?.info) {
      const mergedStatus = {
        ...status,
        info: this.deepCloneParameterStructure(this.cachedParameterStructure)
      };
      // Mark all as missing since there's no info in the status
      for (const key of ['s', 't', 'scheduler']) {
        if (mergedStatus.info[key]) {
          this.markAllAsMissing(mergedStatus.info[key], key === 'scheduler');
        }
      }
      return mergedStatus;
    }

    const mergedStatus = { ...status, info: { ...status.info } };

    // Merge each node type (s, t) and scheduler
    for (const key of ['s', 't', 'scheduler']) {
      if (this.cachedParameterStructure[key]) {
        if (!mergedStatus.info[key]) {
          // If the key is completely missing in status, use cached structure
          mergedStatus.info[key] = this.deepCloneParameterStructure(this.cachedParameterStructure[key]);

          // Mark all parameters as missing
          this.markAllAsMissing(mergedStatus.info[key], key === 'scheduler');
        } else {
          // Merge categories within node types
          if (key !== 'scheduler') {
            for (const category of Object.keys(this.cachedParameterStructure[key])) {
              if (!mergedStatus.info[key][category]) {
                // Category missing in status, add from cache with missing status
                mergedStatus.info[key][category] = this.deepCloneParameterStructure(
                  this.cachedParameterStructure[key][category]
                );
                this.markAllAsMissing(mergedStatus.info[key][category], false);
              } else {
                // Merge individual parameters within category
                for (const paramName of Object.keys(this.cachedParameterStructure[key][category])) {
                  if (!mergedStatus.info[key][category][paramName]) {
                    // Parameter missing, add from cache with missing status
                    mergedStatus.info[key][category][paramName] = {
                      ...this.cachedParameterStructure[key][category][paramName],
                      status: 'missing'
                    };
                  }
                }
              }
            }
          }
        }
      }
    }

    return mergedStatus;
  }

  /**
   * Mark all parameters in an object as missing
   */
  private markAllAsMissing(obj: any, isSimple: boolean): void {
    if (isSimple) {
      // For scheduler, values are direct
      for (const key of Object.keys(obj)) {
        obj[key] = 'missing';
      }
    } else {
      // For node types, values are objects with status
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'object' && obj[key] !== null) {
          obj[key].status = 'missing';
        }
      }
    }
  }

  /**
   * Display parameter status in the panel
   */
  private displayParameterStatus(status: any): void {
    if (!this.paramStatusContent || !status?.info) return;

    this.paramStatusContent.innerHTML = '';

    var resetFilterButton = document.createElement('button');
    resetFilterButton.textContent = 'X';
    resetFilterButton.className = 'param-reset-filter-button';
    resetFilterButton.addEventListener('click', () => {
      if(this.cachedParameterStructure) this.displayParameterStatus(status);
      this.displayParameterRange();
    });
    this.paramStatusContent.appendChild(resetFilterButton);

    var mcrDone = false;
    // Display state node parameters
    if (status.info.s) {

      this.renderNodeTypeParameters('Model Checking Results', status.info.s);
      mcrDone = true;
    
      this.renderNodeTypeParameters('State Nodes (s)', status.info.s);
    }

    // Display transition node parameters
    if (status.info.t) {
      if (!mcrDone) {
        this.renderNodeTypeParameters('Model Checking Results', status.info.t);
      }
      this.renderNodeTypeParameters('Transition Nodes (t)', status.info.t);
    }

    // Display messages if available
    if (status.messages && status.messages.length > 0) {
      const messagesDiv = document.createElement('div');
      messagesDiv.className = 'param-category';
      messagesDiv.innerHTML = `
        <div class="param-category-title">Messages</div>
        ${status.messages.map((msg: string) => `
          <div class="param-item">
            <span class="param-name">${msg}</span>
          </div>
        `).join('')}
      `;
      this.paramStatusContent.appendChild(messagesDiv);
    }
  }


  /**
   * Render node type parameters (s or t)
   */
  private renderNodeTypeParameters(title: string, nodeTypeInfo: Record<string, Record<string, ParameterMetadata>>): void {
    if (!this.paramStatusContent) return;

    const categoryDiv = document.createElement('div');
    categoryDiv.className = 'param-category';

    const titleDiv: HTMLDivElement = document.createElement('div');
    titleDiv.className = 'param-category-title';
    titleDiv.textContent = title;
    categoryDiv.appendChild(titleDiv);

    // Iterate through parameter categories
    for (const [categoryName, categoryParams] of Object.entries(nodeTypeInfo)) {
      if (typeof categoryParams !== 'object') continue;
      if (!title.includes("Model Checking Results")){
        if (categoryName == "Model Checking Results") continue;
          // Add subcategory title
          const subcategoryDiv = document.createElement('div');
          subcategoryDiv.style.marginTop = '8px';
          subcategoryDiv.style.marginBottom = '4px';
          subcategoryDiv.style.fontSize = '11px';
          subcategoryDiv.style.fontWeight = 'bold';
          subcategoryDiv.style.color = '#7f8c8d';
          subcategoryDiv.textContent = categoryName;
          categoryDiv.appendChild(subcategoryDiv);
      }else{
        if (categoryName != "Model Checking Results") continue;
      }




      // Add parameters
      for (const [paramName, paramInfo] of Object.entries(categoryParams) as [string, ParameterMetadata][]) {
        if (!paramInfo || typeof paramInfo !== 'object') continue;
        const outerItemDiv = document.createElement('div');
        outerItemDiv.className = 'param-item'; // evtl extra klasse nötig

        const itemDiv = document.createElement('div');
        itemDiv.className = 'param-item';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'param-name';
        nameSpan.textContent = paramName;
        itemDiv.appendChild(nameSpan);

        const statusSpan = document.createElement('span');
        statusSpan.className = 'param-status-icon';

        const status = paramInfo.status || paramInfo.type;

        if (status === 'missing') {
          statusSpan.textContent = '✗';
          statusSpan.classList.add('missing');
        } else if (status === 'ready' || status === 'number' || status === 'boolean' || status === 'nominal') {
          statusSpan.textContent = '✓';
          statusSpan.classList.add('ready');



        } else {
          statusSpan.textContent = '?';
          statusSpan.classList.add('loading');
        }

        itemDiv.appendChild(statusSpan);
        const rangeDiv = document.createElement('div');
        rangeDiv.className = 'param-item'; //evtl extra klasse nötig

        switch (paramInfo.type){
          case 'number':
            const minSpan = document.createElement('span');
            minSpan.className = 'param-range-label';
            minSpan.textContent = "Min:";
            const minDisplayInput = document.createElement('input');
            minDisplayInput.type = 'text';
            minDisplayInput.className = 'param-min-input';
            // todo: default werte sind aktuelle min/max werte der parameter
            minDisplayInput.value = (paramInfo.min !== undefined && paramInfo.max !== "Infinity") ? String(paramInfo.min) : '';
            minDisplayInput.dataset.paramName = paramName;
            minDisplayInput.dataset.category = categoryName;
            minDisplayInput.dataset.rangeType = 'min';
            minDisplayInput.addEventListener('keypress', (e) => {
              if (e.key === 'Enter') {
                this.displayParameterRange();
              }
            });
            rangeDiv.appendChild(minSpan);
            rangeDiv.appendChild(minDisplayInput);
            // same thing for maxSpan and maxDisplayInput
            const maxSpan = document.createElement('span');
            maxSpan.className = 'param-range-label';
            maxSpan.textContent = " Max:";
            const maxDisplayInput = document.createElement('input');
            maxDisplayInput.type = 'text';
            maxDisplayInput.className = 'param-max-input';
            maxDisplayInput.value = (paramInfo.max !== undefined && paramInfo.max !== "Infinity") ? String(paramInfo.max) : '';
            maxDisplayInput.dataset.paramName = paramName;
            maxDisplayInput.dataset.category = categoryName;
            maxDisplayInput.dataset.rangeType = 'max';
            maxDisplayInput.addEventListener('keypress', (e) => {
              if (e.key === 'Enter') {
                this.displayParameterRange();
              }
            });        

            rangeDiv.appendChild(maxSpan);
            rangeDiv.appendChild(maxDisplayInput);
            break;
          case 'boolean':
            const falseButton = document.createElement('button');
            falseButton.textContent = 'False';
            falseButton.className = 'param-nominal-button';            
            const paramNameClass = paramName.replace(/\s+/g, '-').toLowerCase();
            const categoryNameClass = categoryName.replace(/\s+/g, '-').toLowerCase();
            falseButton.classList.add(categoryNameClass);
            falseButton.classList.add(paramNameClass);

            falseButton.dataset.paramName = paramName;
            falseButton.dataset.category = categoryName;
            falseButton.dataset.nominalValue = 'false';
            falseButton.addEventListener('click', () => {
              this.toggleFilterOptions(categoryNameClass, paramNameClass, 'false');
            });
            const trueButton = document.createElement('button');
            trueButton.textContent = 'True';
            trueButton.className = 'param-nominal-button';
            trueButton.dataset.paramName = paramName;
            trueButton.dataset.category = categoryName;
            trueButton.dataset.nominalValue = 'true';

            trueButton.classList.add(categoryNameClass);
            trueButton.classList.add(paramNameClass);
            trueButton.addEventListener('click', () => {
              this.toggleFilterOptions(categoryNameClass, paramNameClass, 'true');
            });
            rangeDiv.appendChild(falseButton);
            rangeDiv.appendChild(trueButton);
            break;
          case 'nominal':
            const possibleValues = this.prismAPI.getPossibleValuesForParameter(categoryName, paramName);
            console.log(`Possible values for ${paramName}:`, possibleValues);
            possibleValues.forEach(value => {
              const valueButton = document.createElement('button');
              valueButton.textContent = value;
              valueButton.className = 'param-nominal-button';
              valueButton.dataset.paramName = paramName;
              valueButton.dataset.category = categoryName;
              valueButton.dataset.nominalValue = value;
              const paramNameClass = paramName.replace(/\s+/g, '-').toLowerCase();
              const categoryNameClass = categoryName.replace(/\s+/g, '-').toLowerCase();
              valueButton.addEventListener('click', () => {
                this.toggleFilterOptions(categoryNameClass, paramNameClass, value);
              });
              rangeDiv.appendChild(valueButton);

              valueButton.classList.add(categoryNameClass);
              valueButton.classList.add(paramNameClass);
            });
            break;
          default:
            // No range input for other types
            break;
        }

        
        outerItemDiv.appendChild(itemDiv);
        outerItemDiv.appendChild(rangeDiv);
        categoryDiv.appendChild(outerItemDiv);
      }
    }

    this.paramStatusContent.appendChild(categoryDiv);
  }

  private toggleFilterOptions(category: string, paramName: string, valueToChange: string): void {
    const buttons = document.querySelectorAll(`.param-nominal-button.${category}.${paramName}`) as NodeListOf<HTMLElement>;
    console.log("Toggle: button count of " + buttons.length);
    console.log(`.param-nominal-button.${category}.${paramName}`)
    const button = Array.from(buttons).find(btn => btn.dataset.nominalValue === valueToChange);
    if (!button) return;

    const isActive = button.classList.contains('filtered');

    if (isActive) {
      button.classList.remove('filtered');
    } else {
      button.classList.add('filtered');
    }

    this.graph.filterNodes(this.nodeFilterFn.bind(this));
  }
  /**
   * Display parameter range set by user
   */
  private displayParameterRange(): void {
    console.log("[ProjectManager] Applying filters");
    // Apply the filter function to all nodes in the graph
    // The nodeFilterFn will check all the input values and button states
    this.graph.filterNodes(this.nodeFilterFn.bind(this));
  }

  public nodeFilterFn(node: NodeData): boolean{
    const minInputs = document.querySelectorAll('.param-min-input') as NodeListOf<HTMLInputElement>;
    const maxInputs = document.querySelectorAll('.param-max-input') as NodeListOf<HTMLInputElement>;

    // Process min inputs - hide if value is LESS than min
    for (const input of Array.from(minInputs)) {
      const paramName = input.dataset.paramName;
      const category = input.dataset.category;
      const minValue = input.value ? parseFloat(input.value) : null;

      if (paramName && category && minValue !== null) {
        const paramValue = node.parameters?.[category]?.[paramName];
        if (paramValue === undefined || paramValue === null) continue;
        if (paramName == "edges") console.log(`minValue: ${minValue}, paramValue: ${paramValue}, result: ${paramValue > minValue}`);
        if (paramValue < minValue) return true; // Hide if less than minimum
      }
    }

    // Process max inputs - hide if value is GREATER than max
    for (const input of Array.from(maxInputs)) {
      const paramName = input.dataset.paramName;
      const category = input.dataset.category;
      const maxValue = input.value ? parseFloat(input.value) : null;

      if (paramName && category && maxValue !== null) {
        const paramValue = node.parameters?.[category]?.[paramName];
        if (paramValue === undefined || paramValue === null) continue;
        if (paramValue > maxValue) return true; // Hide if greater than maximum
      }
    }

    // Nominal and Bool buttons - hide if value does NOT match the filtered values
    const nominalButtons = document.querySelectorAll('.param-nominal-button.filtered') as NodeListOf<HTMLElement>;

    if (nominalButtons.length > 0) {
      // Group buttons by parameter
      const filtersByParam = new Map<string, Set<string>>();

      nominalButtons.forEach(button => {
        const paramName = button.dataset.paramName;
        const category = button.dataset.category;
        const nominalValue = button.dataset.nominalValue;

        if (paramName && category && nominalValue) {
          const key = `${category}::${paramName}`;
          if (!filtersByParam.has(key)) {
            filtersByParam.set(key, new Set());
          }
          filtersByParam.get(key)!.add(nominalValue);
        }
      });

      // Check if node matches any of the selected values for each parameter
      for (const [key, valuesToFilter] of filtersByParam.entries()) {
        const [category, paramName] = key.split('::');
        const paramValue = node.parameters?.[category]?.[paramName];
        //log result and node value
        //console.log(`[Filter Nodes] Checking node ${node.id} parameter ${category}::${paramName} with value: ${paramValue}`);
        //console.log("Result: " + allowedValues.has(String(paramValue)));
        if (paramValue === undefined || paramValue === null) return false;
        if (!valuesToFilter.has(String(paramValue))) return true;
      }
    }

    return false;
  }

  /**
   * Start polling for status updates
   */
  private startStatusPolling(): void {
    // Clear existing interval
    this.stopStatusPolling();

    console.log('[ProjectManager] Starting status polling...');

    this.statusPollInterval = window.setInterval(async () => {
      if (!this.currentProjectId) {
        this.stopStatusPolling();
        return;
      }

      try {
        const status = await this.prismAPI.fetchProjectStatus(this.currentProjectId);
        this.displayParameterStatus(status);

        // Stop polling if no more missing parameters
        if (!this.prismAPI.hasMissingParameters(status)) {
          console.log('[ProjectManager] All parameters ready, stopping poll');
          this.stopStatusPolling();
        }
      } catch (error) {
        console.error('[ProjectManager] Status poll failed:', error);
      }
    }, this.POLL_INTERVAL_MS);
  }

  /**
   * Stop polling for status updates
   */
  private stopStatusPolling(): void {
    if (this.statusPollInterval !== null) {
      clearInterval(this.statusPollInterval);
      this.statusPollInterval = null;
      console.log('[ProjectManager] Stopped status polling');
    }
  }

  /**
   * Handle check model button click
   */
  private async handleCheckModel(): Promise<void> {
    if (!this.currentProjectId) return;

    if (this.checkButton) {
      this.checkButton.disabled = true;
      this.checkButton.textContent = 'Checking...';
    }

    try {
      this.graph.ui.updateStatus(`Running model check for project: ${this.currentProjectId}...`);

      await this.prismAPI.checkModel(this.currentProjectId);

      this.graph.ui.updateStatus(`Model check initiated for: ${this.currentProjectId}`);

      // Start polling to monitor progress
      this.startStatusPolling();

      // Immediately update status
      await this.updateProjectStatus();

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Model check failed';
      this.graph.ui.showError(message);
    } finally {
      if (this.checkButton) {
        this.checkButton.disabled = false;
        this.checkButton.textContent = 'Check Model';
      }
    }
  }

  /**
   * Handle reset model button click
   */
  private async handleResetModel(): Promise<void> {
    if (!this.currentProjectId) return;

    if (this.resetButton) {
      this.resetButton.disabled = true;
      this.resetButton.textContent = 'Resetting...';
    }

    try {
      this.graph.ui.updateStatus(`Resetting model for project: ${this.currentProjectId}...`);

      await this.prismAPI.resetModel(this.currentProjectId);

      this.graph.ui.updateStatus(`Model reset for: ${this.currentProjectId}`);

      // Immediately update status after reset
      await this.selectProject(this.currentProjectId);

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Model reset failed';
      this.graph.ui.showError(message);
    } finally {
      if (this.resetButton) {
        this.resetButton.disabled = false;
        this.resetButton.textContent = 'Reset Model';
      }
    }
  }

  /**
   * Toggle parameter status visibility (collapsible section in controls)
   */
  private toggleParameterStatus(): void {
    if (this.paramStatusContent && this.toggleParamStatusButton) {
      const isHidden = this.paramStatusContent.classList.toggle('hidden');

      // Update button text
      if (isHidden) {
        this.toggleParamStatusButton.innerHTML = '<strong>▶ Parameter Status</strong>';
      } else {
        this.toggleParamStatusButton.innerHTML = '<strong>▼ Parameter Status</strong>';
      }
    }
  }

  /**
   * Show parameter status section (used when status is updated)
   */
  private showParameterStatus(): void {
    if (this.paramStatusContent && this.toggleParamStatusButton) {
      this.paramStatusContent.classList.remove('hidden');
      this.toggleParamStatusButton.innerHTML = '<strong>▼ Parameter Status</strong>';
    }
  }

  /**
   * Get currently selected project ID
   */
  public getCurrentProjectId(): string | null {
    return this.currentProjectId;
  }

  /**
   * Check if there's a delta between two parameter label objects
   */
  private hasParameterDelta(
    previous: Record<string, string[]>,
    current: Record<string, string[]>
  ): boolean {
    // Check if lengths differ
    if (Object.keys(previous).length !== Object.keys(current).length) {
      return true;
    }

    // Check if any labels have changed
    for (const key of Object.keys(previous)) {
      const prevLabels = previous[key] || [];
      const currLabels = current[key] || [];
      if (prevLabels.length !== currLabels.length || currLabels.length != prevLabels.length) {
        return true;
      }
      for (let i = 0; i < prevLabels.length; i++) {
        if (prevLabels[i] !== currLabels[i]) {
          return true;
        }
        Object.keys(previous[key]).forEach((paramName: string) => {
          if (!current[key].includes(paramName)) {
            return true;
          }
        });
      }
      
    }

    return false;
  }

  /**
   * Cleanup
   */
  public dispose(): void {
    this.stopStatusPolling();
  }
}
