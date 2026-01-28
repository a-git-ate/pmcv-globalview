import { appendFile } from 'fs';
import type { Graph2D } from './Graph2D';
import type { NodeData } from './types';
import type { PrismAPI, ParameterMetadata } from './PrismAPI';
import { JSONParser } from '@streamparser/json';

export class ProjectManager {
  private graph: Graph2D;
  private prismAPI: PrismAPI;
  private currentProjectId: string | null = null;
  private availableProjects: string[] = [];
  private statusPollInterval: number | null = null;
  private readonly POLL_INTERVAL_MS = 2000; // Poll every 2 seconds
  private cachedParameterStructure: any = null; // Cache the initial parameter structure
  private cachedStatus: any = null;
  private hasLoggedFilters: boolean = false;
  // DOM Elements
  private projectTabsContainer: HTMLElement | null = null;
  private checkButton: HTMLButtonElement | null = null;
  private resetButton: HTMLButtonElement | null = null;
  private toggleParamStatusButton: HTMLButtonElement | null = null;
  private paramStatusContent: HTMLElement | null = null;
  private PCAOptionsContent: HTMLElement | null = null;

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
    this.PCAOptionsContent = document.getElementById('pca-content');
  }

  private setupEventListeners(): void {
    // Check model button
    this.checkButton?.addEventListener('click', () => this.handleCheckModel());

    // Reset model button
    this.resetButton?.addEventListener('click', () => this.handleResetModel());

    // Toggle parameter status button
    this.toggleParamStatusButton?.addEventListener('click', () => this.toggleParameterStatus());

    // Apply ML-PCA button
    const applyMLPCAButton = document.getElementById('btn-apply-ml-pca');
    applyMLPCAButton?.addEventListener('click', () => this.handleApplyMLPCA());

    // Upload JSON button
    const uploadJsonButton = document.getElementById('btn-upload-json');
    const jsonFileInput = document.getElementById('json-file-input') as HTMLInputElement;

    uploadJsonButton?.addEventListener('click', () => {
      jsonFileInput?.click();
    });

    jsonFileInput?.addEventListener('change', async (event) => {
      const target = event.target as HTMLInputElement;
      const file = target.files?.[0];
      if (file) {
        await this.handleJsonUpload(file);
        // Reset the input so the same file can be uploaded again if needed
        target.value = '';
      }
    });
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

      // Don't auto-select any project - user must manually select
      console.log('[ProjectManager] Projects loaded. User must select a project to begin.');
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

    // Load the graph data for the selected project, but don't render yet
    await this.graph.loadGraphData(projectId);

    // Fetch and display project status
    await this.updateProjectStatus();

    // Inform user to select a layout
    this.graph.ui.updateStatus(`Project ${projectId} loaded. Please select a layout to visualize.`);
  }

  /**
   * Update project status and display in panel
   */
  private async updateProjectStatus(): Promise<void> {
    if (!this.currentProjectId) return;

    try {
      // Get parameter labels before fetching new status
      const previousParamLabels = this.prismAPI.getAllParameterLabels();

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

      this.populatePCAOptions(mergedStatus);
      // Show parameter status section when selecting a project
      this.showParameterStatus();

      // Check if parameters have changed and update dropdowns if needed
      const currentParamLabels = this.prismAPI.getAllParameterLabels();
      if (this.hasParameterDelta(previousParamLabels, currentParamLabels)) {
        console.log('[ProjectManager] Parameter delta detected, updating dropdowns');
        this.graph.ui.updateParameterSelections(currentParamLabels);
      }

      // Don't automatically start polling - only when check model button is clicked
      // Stop polling if no more missing parameters
      if (!this.prismAPI.hasMissingParameters(mergedStatus)) {
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

  private populatePCAOptions(status: any): void {
    if (!this.PCAOptionsContent || !status?.info) return;

    this.PCAOptionsContent.innerHTML = '';

    // Collect all unique NUMERIC and BOOLEAN parameters from both s and t nodes
    const allParameters = new Map<string, {
      inS: boolean;
      inT: boolean;
      category: string;
      convertedFromNominal: boolean;
      isBoolean: boolean;
    }>();

    // Process s nodes
    if (status.info.s) {
      for (const [categoryName, categoryParams] of Object.entries(status.info.s)) {
        if (typeof categoryParams !== 'object' || categoryParams === null) continue;

        for (const [paramName, paramMeta] of Object.entries(categoryParams as Record<string, any>)) {
          // Include numeric and boolean parameters for PCA
          if (paramMeta?.type !== 'number' && paramMeta?.type !== 'boolean') continue;

          const key = `${categoryName}::${paramName}`;
          if (!allParameters.has(key)) {
            allParameters.set(key, {
              inS: true,
              inT: false,
              category: categoryName,
              convertedFromNominal: paramMeta.convertedFromNominal || false,
              isBoolean: paramMeta.type === 'boolean'
            });
          } else {
            allParameters.get(key)!.inS = true;
          }
        }
      }
    }

    // Process t nodes
    if (status.info.t) {
      for (const [categoryName, categoryParams] of Object.entries(status.info.t)) {
        if (typeof categoryParams !== 'object' || categoryParams === null) continue;

        for (const [paramName, paramMeta] of Object.entries(categoryParams as Record<string, any>)) {
          // Include numeric and boolean parameters for PCA
          if (paramMeta?.type !== 'number' && paramMeta?.type !== 'boolean') continue;

          const key = `${categoryName}::${paramName}`;
          if (!allParameters.has(key)) {
            allParameters.set(key, {
              inS: false,
              inT: true,
              category: categoryName,
              convertedFromNominal: paramMeta.convertedFromNominal || false,
              isBoolean: paramMeta.type === 'boolean'
            });
          } else {
            allParameters.get(key)!.inT = true;
          }
        }
      }
    }

    // Group parameters by category
    const paramsByCategory = new Map<string, Array<{
      paramName: string;
      inS: boolean;
      inT: boolean;
      convertedFromNominal: boolean;
      isBoolean: boolean;
    }>>();

    for (const [key, paramInfo] of allParameters.entries()) {
      const [categoryName, paramName] = key.split('::');

      if (!paramsByCategory.has(categoryName)) {
        paramsByCategory.set(categoryName, []);
      }

      paramsByCategory.get(categoryName)!.push({
        paramName,
        inS: paramInfo.inS,
        inT: paramInfo.inT,
        convertedFromNominal: paramInfo.convertedFromNominal,
        isBoolean: paramInfo.isBoolean
      });
    }

    // Create table rows grouped by category
    for (const [categoryName, params] of paramsByCategory.entries()) {
      // Create category header row
      const categoryRow = document.createElement('tr');
      categoryRow.className = 'pca-category-row';

      const categoryCell = document.createElement('td');
      categoryCell.className = 'pca-category-name';
      categoryCell.textContent = categoryName;
      categoryCell.colSpan = 3;
      categoryRow.appendChild(categoryCell);

      this.PCAOptionsContent.appendChild(categoryRow);

      // Create parameter rows for this category
      for (const param of params) {
        const row = document.createElement('tr');
        row.className = 'pca-param-row';
        row.dataset.inS = String(param.inS);
        row.dataset.inT = String(param.inT);

        // Parameter name cell (indented)
        const nameCell = document.createElement('td');
        nameCell.className = 'pca-param-name';

        // Build parameter name with labels
        let displayName = param.paramName;
        if (param.convertedFromNominal) {
          displayName += ' [converted from nominal]';
        } else if (param.isBoolean) {
          displayName += ' [boolean]';
        }

        nameCell.textContent = displayName;
        row.appendChild(nameCell);

        // S node checkbox cell
        const sCell = document.createElement('td');
        sCell.className = 'pca-checkbox-cell';
        if (param.inS) {
          const sCheckbox = document.createElement('input');
          sCheckbox.type = 'checkbox';
          sCheckbox.className = 'pca-param-checkbox';
          sCheckbox.dataset.nodeType = 's';
          sCheckbox.dataset.category = categoryName;
          sCheckbox.dataset.paramName = param.paramName;
          sCheckbox.checked = true;
          sCheckbox.addEventListener('change', () => this.updatePCAApplyButton());
          sCell.appendChild(sCheckbox);
        }
        row.appendChild(sCell);

        // T node checkbox cell
        const tCell = document.createElement('td');
        tCell.className = 'pca-checkbox-cell';
        if (param.inT) {
          const tCheckbox = document.createElement('input');
          tCheckbox.type = 'checkbox';
          tCheckbox.className = 'pca-param-checkbox';
          tCheckbox.dataset.nodeType = 't';
          tCheckbox.dataset.category = categoryName;
          tCheckbox.dataset.paramName = param.paramName;
          tCheckbox.checked = true;
          tCheckbox.addEventListener('change', () => this.updatePCAApplyButton());
          tCell.appendChild(tCheckbox);
        }
        row.appendChild(tCell);

        this.PCAOptionsContent.appendChild(row);
      }
    }

    // Setup node type checkbox listeners
    this.setupPCANodeTypeListeners();

    // Initial state update
    this.updatePCATableState();
  }

  /**
   * Setup event listeners for node type checkboxes in PCA table header
   */
  private setupPCANodeTypeListeners(): void {
    const sNodeTypeCheckbox = document.getElementById('pca-node-type-s') as HTMLInputElement;
    const tNodeTypeCheckbox = document.getElementById('pca-node-type-t') as HTMLInputElement;
    const sSelectAllCheckbox = document.getElementById('pca-select-all-s') as HTMLInputElement;
    const tSelectAllCheckbox = document.getElementById('pca-select-all-t') as HTMLInputElement;

    if (sNodeTypeCheckbox) {
      sNodeTypeCheckbox.addEventListener('change', () => this.updatePCATableState());
    }

    if (tNodeTypeCheckbox) {
      tNodeTypeCheckbox.addEventListener('change', () => this.updatePCATableState());
    }

    // Select All for S nodes
    if (sSelectAllCheckbox) {
      sSelectAllCheckbox.addEventListener('change', (e) => {
        const isChecked = (e.target as HTMLInputElement).checked;
        const sCheckboxes = document.querySelectorAll('.pca-param-checkbox[data-node-type="s"]:not(:disabled)') as NodeListOf<HTMLInputElement>;
        sCheckboxes.forEach(checkbox => {
          checkbox.checked = isChecked;
        });
        this.updatePCAApplyButton();
      });
    }

    // Select All for T nodes
    if (tSelectAllCheckbox) {
      tSelectAllCheckbox.addEventListener('change', (e) => {
        const isChecked = (e.target as HTMLInputElement).checked;
        const tCheckboxes = document.querySelectorAll('.pca-param-checkbox[data-node-type="t"]:not(:disabled)') as NodeListOf<HTMLInputElement>;
        tCheckboxes.forEach(checkbox => {
          checkbox.checked = isChecked;
        });
        this.updatePCAApplyButton();
      });
    }
  }

  /**
   * Update PCA table state based on node type checkbox selections
   */
  private updatePCATableState(): void {
    const sNodeTypeCheckbox = document.getElementById('pca-node-type-s') as HTMLInputElement;
    const tNodeTypeCheckbox = document.getElementById('pca-node-type-t') as HTMLInputElement;

    if (!sNodeTypeCheckbox || !tNodeTypeCheckbox || !this.PCAOptionsContent) return;

    const sChecked = sNodeTypeCheckbox.checked;
    const tChecked = tNodeTypeCheckbox.checked;

    // Only process parameter rows, not category header rows
    const rows = this.PCAOptionsContent.querySelectorAll('tr.pca-param-row');

    rows.forEach(row => {
      const rowElement = row as HTMLElement;
      const inS = rowElement.dataset.inS === 'true';
      const inT = rowElement.dataset.inT === 'true';
      const inBoth = inS && inT;

      const sCheckbox = rowElement.querySelector('input[data-node-type="s"]') as HTMLInputElement;
      const tCheckbox = rowElement.querySelector('input[data-node-type="t"]') as HTMLInputElement;

      // Case 1: Both node types checked - only parameters in both are active
      if (sChecked && tChecked) {
        if (inBoth) {
          // Enable both checkboxes
          if (sCheckbox) {
            sCheckbox.disabled = false;
          }
          if (tCheckbox) {
            tCheckbox.disabled = false;
          }
          rowElement.style.opacity = '1';
        } else {
          // Disable and uncheck
          if (sCheckbox) {
            sCheckbox.disabled = true;
            sCheckbox.checked = false;
          }
          if (tCheckbox) {
            tCheckbox.disabled = true;
            tCheckbox.checked = false;
          }
          rowElement.style.opacity = '0.4';
        }
      }
      // Case 2: Only S checked
      else if (sChecked && !tChecked) {
        if (sCheckbox) {
          sCheckbox.disabled = false;
        }
        if (tCheckbox) {
          tCheckbox.disabled = true;
          tCheckbox.checked = false;
        }
        rowElement.style.opacity = inS ? '1' : '0.4';
      }
      // Case 3: Only T checked
      else if (!sChecked && tChecked) {
        if (sCheckbox) {
          sCheckbox.disabled = true;
          sCheckbox.checked = false;
        }
        if (tCheckbox) {
          tCheckbox.disabled = false;
        }
        rowElement.style.opacity = inT ? '1' : '0.4';
      }
      // Case 4: Both unchecked
      else {
        if (sCheckbox) {
          sCheckbox.disabled = true;
          sCheckbox.checked = false;
        }
        if (tCheckbox) {
          tCheckbox.disabled = true;
          tCheckbox.checked = false;
        }
        rowElement.style.opacity = '0.4';
      }
    });

    // Update apply button state
    this.updatePCAApplyButton();
  }

  /**
   * Update the state of the Apply PCA button based on checked checkboxes
   */
  private updatePCAApplyButton(): void {
    const applyButton = document.getElementById('btn-apply-ml-pca') as HTMLButtonElement;
    if (!applyButton) return;

    const checkedCheckboxes = document.querySelectorAll('.pca-param-checkbox:checked:not(:disabled)');

    // Enable button only if at least 2 checkboxes are checked
    applyButton.disabled = checkedCheckboxes.length < 2;
  }

  /**
   * Mark parameters with zero variance as red in the PCA selection dialog
   * @param problematicParams Array of parameter names in format "category::paramName"
   */
  private markProblematicParameters(problematicParams: string[]): void {
    if (!this.PCAOptionsContent) return;

    console.log('[ProjectManager] Marking problematic parameters:', problematicParams);

    // Get all parameter rows
    const rows = this.PCAOptionsContent.querySelectorAll('tr.pca-param-row');

    rows.forEach(row => {
      const rowElement = row as HTMLElement;
      const nameCell = rowElement.querySelector('.pca-param-name') as HTMLElement;

      // Get checkboxes to extract category and param name
      const checkbox = rowElement.querySelector('.pca-param-checkbox') as HTMLInputElement;
      if (!checkbox) return;

      const category = checkbox.dataset.category || '';
      const paramName = checkbox.dataset.paramName || '';
      const fullParamName = `${category}::${paramName}`;

      // Check if this parameter is in the problematic list
      if (problematicParams.includes(fullParamName)) {
        // Mark the row as problematic with red background
        rowElement.style.backgroundColor = '#ffcccc';
        nameCell.style.color = '#cc0000';
        nameCell.style.fontWeight = 'bold';

        // Add a warning icon/text to the parameter name
        if (!nameCell.textContent?.includes('⚠')) {
          nameCell.textContent = '⚠ ' + nameCell.textContent + ' (zero variance)';
        }

        console.log(`[ProjectManager] Marked parameter as problematic: ${fullParamName}`);
      }
    });
  }

  /**
   * Mark parameters with zero variance that were automatically deselected
   * Updates the UI to show red marking with "deselected because of zero variance" label
   * @param zeroVarianceParams Array of parameter names in format "category::paramName"
   */
  private markZeroVarianceParameters(zeroVarianceParams: string[]): void {
    if (!this.PCAOptionsContent) return;

    console.log('[ProjectManager] Marking zero variance parameters as deselected:', zeroVarianceParams);

    // Get all parameter rows
    const rows = this.PCAOptionsContent.querySelectorAll('tr.pca-param-row');

    rows.forEach(row => {
      const rowElement = row as HTMLElement;
      const nameCell = rowElement.querySelector('.pca-param-name') as HTMLElement;

      // Get checkboxes to extract category and param name
      const checkbox = rowElement.querySelector('.pca-param-checkbox') as HTMLInputElement;
      if (!checkbox) return;

      const category = checkbox.dataset.category || '';
      const paramName = checkbox.dataset.paramName || '';
      const fullParamName = `${category}::${paramName}`;

      // Check if this parameter is in the zero variance list
      if (zeroVarianceParams.includes(fullParamName)) {
        // Mark the row with red background
        rowElement.style.backgroundColor = '#ffcccc';
        nameCell.style.color = '#cc0000';
        nameCell.style.fontWeight = 'bold';

        // Uncheck the checkbox to show it was deselected
        checkbox.checked = false;

        // Update the label to indicate it was deselected
        if (!nameCell.textContent?.includes('deselected')) {
          const originalText = nameCell.textContent?.replace(/^⚠\s*/, '').replace(/\s*\(.*?\)\s*$/, '') || paramName;
          nameCell.textContent = '⚠ ' + originalText + ' (deselected because of zero variance)';
        }

        console.log(`[ProjectManager] Marked parameter as deselected due to zero variance: ${fullParamName}`);
      }
    });

    // Update the Apply button state
    this.updatePCAApplyButton();
  }

  /**
   * Handle Apply ML-PCA button click
   */
  private handleApplyMLPCA(): void {
    console.log('[ProjectManager] Apply ML-PCA clicked');

    // Get all checked checkboxes
    const checkedCheckboxes = document.querySelectorAll('.pca-param-checkbox:checked:not(:disabled)') as NodeListOf<HTMLInputElement>;

    if (checkedCheckboxes.length < 2) {
      alert('Please select at least 2 parameters for PCA');
      return;
    }

    // Collect selected parameters
    const selectedParams: Array<{category: string, paramName: string, nodeTypes: Set<'s' | 't'>}> = [];
    const paramMap = new Map<string, Set<'s' | 't'>>();

    checkedCheckboxes.forEach(checkbox => {
      const category = checkbox.dataset.category;
      const paramName = checkbox.dataset.paramName;
      const nodeType = checkbox.dataset.nodeType as 's' | 't';

      if (!category || !paramName || !nodeType) return;

      const key = `${category}::${paramName}`;

      if (!paramMap.has(key)) {
        paramMap.set(key, new Set());
      }
      paramMap.get(key)!.add(nodeType);
    });

    // Convert map to array
    paramMap.forEach((nodeTypes, key) => {
      const [category, paramName] = key.split('::');
      selectedParams.push({ category, paramName, nodeTypes });
    });

    console.log('[ProjectManager] Selected parameters for ML-PCA:', selectedParams);

    // Get center and scale options from checkboxes
    const centerCheckbox = document.getElementById('pca-center') as HTMLInputElement;
    const scaleCheckbox = document.getElementById('pca-scale') as HTMLInputElement;
    const center = centerCheckbox ? centerCheckbox.checked : true;
    const scale = scaleCheckbox ? scaleCheckbox.checked : true;

    console.log('[ProjectManager] PCA options - center:', center, 'scale:', scale);

    // Show progress indicator
    this.prismAPI.progressIndicator.show({ title: 'Applying PCA' });
    this.prismAPI.progressIndicator.setIndeterminate('Computing principal components...');

    // Call the ML-PCA function on Graph2D
    try {
      const result = this.graph.doMLPCAWithSelection(selectedParams, center, scale);

      // Hide progress indicator
      this.prismAPI.progressIndicator.hide();

      if (result.success) {
        // Mark zero variance parameters with updated label
        if (result.zeroVarianceParams.length > 0) {
          console.log('[ProjectManager] Marking zero variance parameters:', result.zeroVarianceParams);
          this.markZeroVarianceParameters(result.zeroVarianceParams);

          // Show info message about auto-deselection
          alert(`PCA applied successfully!\n\n${result.zeroVarianceParams.length} parameter(s) with zero variance were automatically deselected:\n${result.zeroVarianceParams.join(', ')}`);
        }

        // Close PCA menu after successful application
        const pcaMenu = document.getElementById('pca-menu');
        if (pcaMenu) {
          pcaMenu.classList.add('hidden');
        }

        this.graph.ui.updateStatus('ML-PCA applied successfully');
      } else {
        // PCA failed but didn't throw an error (e.g., not enough params after filtering)
        if (result.zeroVarianceParams.length > 0) {
          this.markZeroVarianceParameters(result.zeroVarianceParams);
        }
      }
    } catch (error) {
      // Hide progress indicator on error
      this.prismAPI.progressIndicator.hide();

      console.error('[ProjectManager] ML-PCA failed:', error);

      const errorMsg = error instanceof Error ? error.message : String(error);
      alert('ML-PCA failed: ' + errorMsg);
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

    // Collect all categories and their parameters from both s and t nodes
    const allCategories = new Map<string, {
      inS: boolean;
      inT: boolean;
      sParams: Record<string, ParameterMetadata>;
      tParams: Record<string, ParameterMetadata>;
    }>();

    // Collect from s nodes
    if (status.info.s) {
      for (const [categoryName, categoryParams] of Object.entries(status.info.s)) {
        if (typeof categoryParams !== 'object' || categoryParams === null) continue;

        if (!allCategories.has(categoryName)) {
          allCategories.set(categoryName, {
            inS: true,
            inT: false,
            sParams: categoryParams as Record<string, ParameterMetadata>,
            tParams: {}
          });
        } else {
          allCategories.get(categoryName)!.inS = true;
          allCategories.get(categoryName)!.sParams = categoryParams as Record<string, ParameterMetadata>;
        }
      }
    }

    // Collect from t nodes
    if (status.info.t) {
      for (const [categoryName, categoryParams] of Object.entries(status.info.t)) {
        if (typeof categoryParams !== 'object' || categoryParams === null) continue;

        if (!allCategories.has(categoryName)) {
          allCategories.set(categoryName, {
            inS: false,
            inT: true,
            sParams: {},
            tParams: categoryParams as Record<string, ParameterMetadata>
          });
        } else {
          allCategories.get(categoryName)!.inT = true;
          allCategories.get(categoryName)!.tParams = categoryParams as Record<string, ParameterMetadata>;
        }
      }
    }

    // Collect shared, s-only, and t-only parameters
    const sharedCategories = new Map<string, Record<string, ParameterMetadata>>();
    const sOnlyCategories = new Map<string, Record<string, ParameterMetadata>>();
    const tOnlyCategories = new Map<string, Record<string, ParameterMetadata>>();

    for (const [categoryName, categoryInfo] of allCategories.entries()) {
      const sharedParams: Record<string, ParameterMetadata> = {};
      const sOnlyParams: Record<string, ParameterMetadata> = {};
      const tOnlyParams: Record<string, ParameterMetadata> = {};

      // Categorize parameters as shared or unique
      if (categoryInfo.inS) {
        for (const [paramName, paramMeta] of Object.entries(categoryInfo.sParams)) {
          if (categoryInfo.inT && paramName in categoryInfo.tParams) {
            sharedParams[paramName] = paramMeta;
          } else {
            sOnlyParams[paramName] = paramMeta;
          }
        }
      }

      if (categoryInfo.inT) {
        for (const [paramName, paramMeta] of Object.entries(categoryInfo.tParams)) {
          if (!(paramName in sharedParams)) {
            tOnlyParams[paramName] = paramMeta;
          }
        }
      }

      // Store categorized parameters
      if (Object.keys(sharedParams).length > 0) {
        sharedCategories.set(categoryName, sharedParams);
      }
      if (Object.keys(sOnlyParams).length > 0) {
        sOnlyCategories.set(categoryName, sOnlyParams);
      }
      if (Object.keys(tOnlyParams).length > 0) {
        tOnlyCategories.set(categoryName, tOnlyParams);
      }
    }

    // Display shared parameters first
    this.renderSharedParameters(sharedCategories);

    // Display s-only parameters
    this.renderSParameters(sOnlyCategories);

    // Display t-only parameters
    this.renderTParameters(tOnlyCategories);

    // Display scheduler parameters if available
    if (status.info.scheduler) {
      this.renderSchedulerParameters('Scheduler', status.info.scheduler);
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
   * Render shared parameters (present in both s and t nodes)
   */
  private renderSharedParameters(sharedCategories: Map<string, Record<string, ParameterMetadata>>): void {
    for (const [categoryName, categoryParams] of sharedCategories.entries()) {
      this.renderCategoryParameters(categoryName, categoryParams, categoryName);
    }
  }

  /**
   * Render s-only parameters (only in state nodes)
   */
  private renderSParameters(sOnlyCategories: Map<string, Record<string, ParameterMetadata>>): void {
    if (sOnlyCategories.size === 0) return;

    // Create section header
    const sectionDiv = document.createElement('div');
    sectionDiv.className = 'param-category';
    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'param-category-title';
    sectionTitle.textContent = 'State Nodes (s)';
    sectionDiv.appendChild(sectionTitle);
    this.paramStatusContent!.appendChild(sectionDiv);

    // Render each category under this section
    for (const [categoryName, categoryParams] of sOnlyCategories.entries()) {
      this.renderCategoryParametersAsSubsection(categoryName, categoryParams, categoryName);
    }
  }

  /**
   * Render t-only parameters (only in transition nodes)
   */
  private renderTParameters(tOnlyCategories: Map<string, Record<string, ParameterMetadata>>): void {
    if (tOnlyCategories.size === 0) return;

    // Create section header
    const sectionDiv = document.createElement('div');
    sectionDiv.className = 'param-category';
    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'param-category-title';
    sectionTitle.textContent = 'Transition Nodes (t)';
    sectionDiv.appendChild(sectionTitle);
    this.paramStatusContent!.appendChild(sectionDiv);

    // Render each category under this section
    for (const [categoryName, categoryParams] of tOnlyCategories.entries()) {
      this.renderCategoryParametersAsSubsection(categoryName, categoryParams, categoryName);
    }
  }

  /**
   * Render category parameters with a main title
   */
  private renderCategoryParameters(title: string, categoryParams: Record<string, ParameterMetadata>, categoryName: string): void {
    if (!this.paramStatusContent) return;

    const categoryDiv = document.createElement('div');
    categoryDiv.className = 'param-category';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'param-category-title';
    titleDiv.textContent = title;
    categoryDiv.appendChild(titleDiv);

    this.renderParameterItems(categoryDiv, categoryParams, categoryName);
    this.paramStatusContent.appendChild(categoryDiv);
  }

  /**
   * Render category parameters as a subsection (with subcategory styling)
   */
  private renderCategoryParametersAsSubsection(categoryName: string, categoryParams: Record<string, ParameterMetadata>, categoryNameForData: string): void {
    if (!this.paramStatusContent) return;

    // Add subcategory title
    const subcategoryDiv = document.createElement('div');
    subcategoryDiv.style.marginTop = '8px';
    subcategoryDiv.style.marginBottom = '4px';
    subcategoryDiv.style.marginLeft = '10px';
    subcategoryDiv.style.fontSize = '11px';
    subcategoryDiv.style.fontWeight = 'bold';
    subcategoryDiv.style.color = '#7f8c8d';
    subcategoryDiv.textContent = categoryName;
    this.paramStatusContent.appendChild(subcategoryDiv);

    // Create container for parameters
    const containerDiv = document.createElement('div');
    containerDiv.style.marginLeft = '10px';
    this.renderParameterItems(containerDiv, categoryParams, categoryNameForData);
    this.paramStatusContent.appendChild(containerDiv);
  }

  /**
   * Render individual parameter items (the actual UI elements)
   */
  private renderParameterItems(containerDiv: HTMLElement, categoryParams: Record<string, ParameterMetadata>, categoryName: string): void {
    for (const [paramName, paramInfo] of Object.entries(categoryParams)) {
      if (!paramInfo || typeof paramInfo !== 'object') continue;

      const outerItemDiv = document.createElement('div');
      outerItemDiv.className = 'param-item';

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
      rangeDiv.className = 'param-item';

      switch (paramInfo.type) {
        case 'number':
          const minSpan = document.createElement('span');
          minSpan.className = 'param-range-label';
          minSpan.textContent = "Min:";
          const minDisplayInput = document.createElement('input');
          minDisplayInput.type = 'text';
          minDisplayInput.className = 'param-min-input';
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

          const undefinedButton = document.createElement('button');
          undefinedButton.textContent = 'Undefined';
          undefinedButton.className = 'param-nominal-button';
          undefinedButton.dataset.paramName = paramName;
          undefinedButton.dataset.category = categoryName;
          undefinedButton.dataset.nominalValue = 'undefined';
          undefinedButton.classList.add(categoryNameClass);
          undefinedButton.classList.add(paramNameClass);
          undefinedButton.addEventListener('click', () => {
            this.toggleFilterOptions(categoryNameClass, paramNameClass, 'undefined');
          });

          rangeDiv.appendChild(falseButton);
          rangeDiv.appendChild(trueButton);
          rangeDiv.appendChild(undefinedButton);
          break;

        case 'nominal':
          const possibleValues = this.prismAPI.getPossibleValuesForParameter(categoryName, paramName);
          possibleValues.forEach(value => {
            const valueButton = document.createElement('button');
            valueButton.textContent = value;
            valueButton.className = 'param-nominal-button';
            const paramNameClass = paramName.replace(/\s+/g, '-').toLowerCase();
            const categoryNameClass = categoryName.replace(/\s+/g, '-').toLowerCase();
            valueButton.classList.add(categoryNameClass);
            valueButton.classList.add(paramNameClass);
            valueButton.dataset.paramName = paramName;
            valueButton.dataset.category = categoryName;
            valueButton.dataset.nominalValue = value;
            valueButton.addEventListener('click', () => {
              this.toggleFilterOptions(categoryNameClass, paramNameClass, value);
            });
            rangeDiv.appendChild(valueButton);
          });
          break;
      }

      outerItemDiv.appendChild(itemDiv);
      outerItemDiv.appendChild(rangeDiv);
      containerDiv.appendChild(outerItemDiv);
    }
  }

  /**
   * Render scheduler parameters
   */
  private renderSchedulerParameters(title: string, schedulerInfo: Record<string, any>): void {
    if (!this.paramStatusContent) return;

    const categoryDiv = document.createElement('div');
    categoryDiv.className = 'param-category';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'param-category-title';
    titleDiv.textContent = title;
    categoryDiv.appendChild(titleDiv);

    // Scheduler parameters are simpler - just key-value pairs
    for (const [paramName, paramValue] of Object.entries(schedulerInfo)) {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'param-item';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'param-name';
      nameSpan.textContent = paramName;
      itemDiv.appendChild(nameSpan);

      const statusSpan = document.createElement('span');
      statusSpan.className = 'param-status-icon';

      if (paramValue === 'missing') {
        statusSpan.textContent = '✗';
        statusSpan.classList.add('missing');
      } else {
        statusSpan.textContent = '✓';
        statusSpan.classList.add('ready');
      }

      itemDiv.appendChild(statusSpan);
      categoryDiv.appendChild(itemDiv);
    }

    this.paramStatusContent.appendChild(categoryDiv);
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
            const undefinedButton = document.createElement('button');
            undefinedButton.textContent = 'Undefined';
            undefinedButton.className = 'param-nominal-button';
            undefinedButton.dataset.paramName = paramName;
            undefinedButton.dataset.category = categoryName;
            undefinedButton.dataset.nominalValue = 'undefined';

            undefinedButton.classList.add(categoryNameClass);
            undefinedButton.classList.add(paramNameClass);
            undefinedButton.addEventListener('click', () => {
              this.toggleFilterOptions(categoryNameClass, paramNameClass, 'undefined');
            });
            rangeDiv.appendChild(falseButton);
            rangeDiv.appendChild(trueButton);
            rangeDiv.appendChild(undefinedButton);
            break;
          case 'nominal':
            const possibleValues = this.prismAPI.getPossibleValuesForParameter(categoryName, paramName);
            console.log(`[ProjectManager] Possible values for ${paramName} in category ${categoryName}:`, possibleValues);
            //console.log(`Possible values for ${paramName}:`, possibleValues);
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
    //console.log("Toggle: button count of " + buttons.length);
    //console.log(`.param-nominal-button.${category}.${paramName}`)
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
    // Reset the flag so filters will be logged again
    this.hasLoggedFilters = false;
    // Apply the filter function to all nodes in the graph
    // The nodeFilterFn will check all the input values and button states
    this.graph.filterNodes(this.nodeFilterFn.bind(this));
  }

  //Returns true if node should be hidden
  public nodeFilterFn(node: NodeData): boolean{
    const minInputs = document.querySelectorAll('.param-min-input') as NodeListOf<HTMLInputElement>;
    const maxInputs = document.querySelectorAll('.param-max-input') as NodeListOf<HTMLInputElement>;

    // First call: log all active filters
    if (!this.hasLoggedFilters) {
      console.log(`[Filter Debug] Active filters:`);
      console.log(`  Min inputs: ${minInputs.length}`);
      minInputs.forEach(input => {
        console.log(`    ${input.dataset.category}::${input.dataset.paramName} >= ${input.value}`);
      });
      console.log(`  Max inputs: ${maxInputs.length}`);
      maxInputs.forEach(input => {
        console.log(`    ${input.dataset.category}::${input.dataset.paramName} <= ${input.value}`);
      });
      this.hasLoggedFilters = true;
    }

    let debugLog = false;
    // Debug specific nodes that should be filtered
    const debugNodeIds: (number | string)[] = [264, 266, 288, 422, 244, 246, 382, 328, 430, 1703, 630, 1903, 634, 1743, 434, 1943];
    if (debugNodeIds.includes(node.id)) {
      debugLog = true;
      const prMaxEqual1 = node.parameters?.['Model Checking Results']?.['PrMax_equal_1'];
      console.log(`[Filter Debug] Checking node ${node.id} (type=${node.type}), PrMax_equal_1=${prMaxEqual1}`);
    }

    // Process min inputs - hide if value is LESS than min
    for (const input of Array.from(minInputs)) {
      const paramName = input.dataset.paramName;
      const category = input.dataset.category;
      const minValue = input.value ? parseFloat(input.value) : null;

      if (paramName && category && minValue !== null) {
        const paramValue = node.parameters?.[category]?.[paramName];
        if (paramValue === undefined || paramValue === null) continue;

        if (debugLog) {
          console.log(`  Min filter: ${category}::${paramName} >= ${minValue}`);
          console.log(`    Node value: ${paramValue}, hide=${paramValue < minValue}`);
        }

        if (paramName == "edges") console.log(`minValue: ${minValue}, paramValue: ${paramValue}, result: ${paramValue > minValue}`);
        if (paramValue < minValue) {
          if (debugLog) console.log(`  -> HIDING (below min)`);
          return true; // Hide if less than minimum
        }
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

        if (debugLog) {
          console.log(`  Max filter: ${category}::${paramName} <= ${maxValue}`);
          console.log(`    Node value: ${paramValue}, hide=${paramValue > maxValue}`);
        }

        if (paramValue > maxValue) {
          if (debugLog) console.log(`  -> HIDING (above max)`);
          return true; // Hide if greater than maximum
        }
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
        //log result and node value (DISABLED - causes freeze with large datasets)
        // console.log(`[Filter Nodes] Checking node ${node.id} parameter ${category}::${paramName} with value: ${paramValue}`);
        // console.log("Result: " + valuesToFilter.has(String(paramValue)));

        if (debugLog) {
          console.log(`  Nominal filter: ${category}::${paramName} in [${Array.from(valuesToFilter).join(', ')}]`);
          console.log(`    Node value: ${paramValue}, matches=${valuesToFilter.has(String(paramValue))}`);
        }

        if ((paramValue === undefined || paramValue === null) && valuesToFilter.has('undefined')) {
          if (debugLog) console.log(`  -> HIDING (undefined and filtered)`);
          return true;
        }
        if (valuesToFilter.has(String(paramValue))) {
          if (debugLog) console.log(`  -> HIDING (matches nominal filter)`);
          return true;
        }
      }
    }

    if (debugLog) console.log(`  -> SHOWING (passed all filters)`);
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
        // Use updateProjectStatus to properly merge and check status
        await this.updateProjectStatus();
        // updateProjectStatus will stop polling if no more missing parameters
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
      }

      // Check if parameter names have changed
      const prevParamNames = Object.keys(previous[key]);
      for (const paramName of prevParamNames) {
        if (!current[key].includes(paramName)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Handle JSON file upload with streaming for large files
   */
  private async handleJsonUpload(file: File): Promise<void> {
    try {
      const parseStart = performance.now();

      const parseMemStart = (performance as any).memory ? (performance as any).memory.usedJSHeapSize : 0;
      const parseMemTotalStart = (performance as any).memory ? (performance as any).memory.totalJSHeapSize : 0;
      let peakMemoryParsing = parseMemTotalStart;
      let peakMemoryProcessing = 0;

      // Helper to track peak memory during parsing
      const updatePeakMemoryParsing = () => {
        if ((performance as any).memory) {
          const current = (performance as any).memory.totalJSHeapSize;
          if (current > peakMemoryParsing) {
            peakMemoryParsing = current;
          }
        }
      };

      // Helper to track peak memory during internal processing
      const updatePeakMemoryProcessing = () => {
        if ((performance as any).memory) {
          const current = (performance as any).memory.totalJSHeapSize;
          if (current > peakMemoryProcessing) {
            peakMemoryProcessing = current;
          }
        }
      };

      const fileSizeMB = file.size / 1024 / 1024;
      console.log(`[ProjectManager] Loading JSON file: ${file.name} (${fileSizeMB.toFixed(2)} MB)`);

      // Show progress indicator
      this.prismAPI.progressIndicator.show({
        title: 'Loading JSON File',
        showAbortButton: false
      });
      this.prismAPI.progressIndicator.setStatus(`Reading ${file.name}...`);

      let data: any;

      // For large files (> 100MB), use streaming approach
      if (fileSizeMB > 100) {
        console.log(`[ProjectManager] Large file detected, using streaming parser...`);
        data = await this.readLargeJsonFile(file, updatePeakMemoryParsing);
        updatePeakMemoryParsing();
      } else {
        // For smaller files, use standard approach
        this.prismAPI.progressIndicator.setStatus('Parsing JSON...');
        const text = await file.text();
        updatePeakMemoryParsing();
        data = JSON.parse(text);
      }

      const parseEnd = performance.now();
      updatePeakMemoryParsing();

      const parseMemEnd = (performance as any).memory ? (performance as any).memory.usedJSHeapSize : 0;
      const parseMemTotalEnd = (performance as any).memory ? (performance as any).memory.totalJSHeapSize : 0;
      const parseMemUsed = Math.max(0, (parseMemEnd - parseMemStart)/1024/1024).toFixed(2);
      const parseMemTotal = Math.max(0, (parseMemTotalEnd - parseMemTotalStart)/1024/1024).toFixed(2);
      const parseTime = parseEnd-parseStart;


      const internalProcessingStart = performance.now();

      this.prismAPI.progressIndicator.setStatus('Validating data structure...');

      // Validate structure
      if (!data.nodes || !Array.isArray(data.nodes)) {
        throw new Error('Invalid JSON: missing or invalid "nodes" array');
      }
      if (!data.edges || !Array.isArray(data.edges)) {
        throw new Error('Invalid JSON: missing or invalid "edges" array');
      }

      console.log(`[ProjectManager] JSON loaded: ${data.nodes.length.toLocaleString()} nodes, ${data.edges.length.toLocaleString()} edges`);

      // Log info object status
      if (data.info) {
        console.log('[ProjectManager] JSON contains info object with parameter metadata');
      } else {
        console.warn('[ProjectManager] JSON does NOT contain info object - parameter menus may be empty');
      }

      // Clear canvas before loading new project
      this.graph.clearGraphCanvas();

      // Clear current project
      this.currentProjectId = `uploaded:${file.name}`;
      this.cachedParameterStructure = null;

      // Only clear parameter metadata if the data doesn't have info
      // If data has info, convertNewFormatToInternal will set it
      if (!data.info) {
        console.warn('[ProjectManager] Clearing parameter metadata because data has no info');
        this.prismAPI.clearParameterMetadata();
      }

      // Update tabs
      const tabs = this.projectTabsContainer?.querySelectorAll('.project-tab');
      tabs?.forEach(tab => tab.classList.remove('active'));

      // Disable check/reset for uploaded files
      if (this.checkButton) this.checkButton.disabled = true;
      if (this.resetButton) this.resetButton.disabled = true;

      const processMemStart = (performance as any).memory ? (performance as any).memory.usedJSHeapSize : 0;
      const processMemTotalStart = (performance as any).memory ? (performance as any).memory.totalJSHeapSize : 0;
      peakMemoryProcessing = processMemTotalStart;
      // Process and load
      this.prismAPI.progressIndicator.setStatus('Processing graph data...');
      const result = await this.prismAPI.convertNewFormatToInternal(data);
      updatePeakMemoryProcessing();

      this.prismAPI.progressIndicator.setStatus('Loading into visualization...');
      await this.graph.loadGraphDataFromMemory(result.nodes, result.edges, file.name);
      updatePeakMemoryProcessing();

      this.prismAPI.progressIndicator.hide();

      // Populate UI components with parameter metadata (same as API flow)
      // Get the metadata that was set by convertNewFormatToInternal
      const metadata = this.prismAPI.getParameterMetadata();
      if (metadata) {
        console.log('[ProjectManager] Populating UI with parameter metadata from uploaded JSON');

        // Cache the parameter structure for later use
        if (!this.cachedParameterStructure) {
          this.cachedParameterStructure = this.deepCloneParameterStructure(metadata);
        }

        // Create a status object that matches the expected format
        const status = { info: metadata };

        // Populate parameter status panel and PCA options
        this.displayParameterStatus(status);
        this.populatePCAOptions(status);
        this.showParameterStatus();

        // Update parameter dropdowns in the graph UI
        const paramLabels = this.prismAPI.getAllParameterLabels();
        this.graph.ui.updateParameterSelections(paramLabels);


        const internalProcessingEnd = performance.now();
        updatePeakMemoryProcessing();

        const internalProcessingTime = (internalProcessingEnd - internalProcessingStart).toFixed(2);
        const processMemEnd = (performance as any).memory ? (performance as any).memory.usedJSHeapSize : 0;
        const processMemTotalEnd = (performance as any).memory ? (performance as any).memory.totalJSHeapSize : 0;

        // Calculate deltas (may be negative if GC occurred)
        const processingMemUsedDelta = (processMemEnd - processMemStart)/1024/1024;
        const processingMemTotalDelta = (processMemTotalEnd - processMemTotalStart)/1024/1024;

        const processingMemUsed = processingMemUsedDelta.toFixed(2);
        const processingMemTotal = processingMemTotalDelta.toFixed(2);
        const peakMemoryParsingUsed = ((peakMemoryParsing - parseMemTotalStart)/1024/1024).toFixed(2);
        const peakMemoryProcessingUsed = ((peakMemoryProcessing - processMemTotalStart)/1024/1024).toFixed(2);

        var paramCount = 0;
        for (const params of Object.keys(paramLabels)){
          paramCount += paramLabels[params].length;
        }

        console.log(`[PERFORMANCE] ========================`)
        console.log(`[PERFORMANCE] Node count: ${this.graph.getNodeCount()}`)
        console.log(`[Performance] Parameter Count: ${paramCount}`)
        console.log(`[PERFORMANCE] JSON parse time: ${parseTime}ms`)
        console.log(`[PERFORMANCE] JSON memory delta (used): ${parseMemUsed}MB`)
        console.log(`[PERFORMANCE] JSON memory delta (total): ${parseMemTotal}MB`)
        console.log(`[PERFORMANCE] Peak Memory Used (parsing): ${peakMemoryParsingUsed}MB`)
        console.log(`[PERFORMANCE] Internal Processing Time: ${internalProcessingTime}ms`)
        console.log(`[PERFORMANCE] Internal Processing Memory delta (used): ${processingMemUsed}MB${processingMemUsedDelta < 0 ? ' (negative: GC occurred)' : ''}`)
        console.log(`[PERFORMANCE] Internal Processing Memory delta (total): ${processingMemTotal}MB${processingMemTotalDelta < 0 ? ' (negative: GC occurred)' : ''}`)
        console.log(`[PERFORMANCE] Peak Memory Used (processing): ${peakMemoryProcessingUsed}MB`)
        console.log(`[PERFORMANCE] ========================`)
        console.log('[ProjectManager] Parameter UI populated successfully');
      } else {
        console.warn('[ProjectManager] No parameter metadata available to populate UI');
      }


      this.graph.ui.updateStatus(`Loaded ${result.nodes.length.toLocaleString()} nodes from ${file.name}. Select a layout to visualize.`);

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load JSON file';
      console.error('[ProjectManager] JSON upload failed:', error);
      this.prismAPI.progressIndicator.hide();

      let userMessage = `Failed to load JSON: ${message}`;

      if (message.includes('Invalid string length') || message.includes('string length')) {
        const fileSizeMB = file.size / 1024 / 1024;
        userMessage = `JavaScript string length limit exceeded (${fileSizeMB.toFixed(2)} MB file).\n\n`;
        userMessage += 'Browser has a maximum string length of ~512MB-1GB.\n\n';
        userMessage += 'Solutions:\n';
        userMessage += '1. Split JSON into smaller parts (<500MB each)\n';
        userMessage += '2. Use backend API instead\n';
        userMessage += '3. Filter/reduce data before exporting';
      }

      this.graph.ui.showError(userMessage);
    }
  }

  /**
   * Stream-parse large JSON files using @streamparser/json library
   */
  private async readLargeJsonFile(file: File, updatePeakMemory?: () => void): Promise<any> {
    return new Promise((resolve, reject) => {
      const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB chunks
      let offset = 0;
      const result: any = { nodes: [], edges: [], info: null };

      console.log(`[ProjectManager] Starting streaming parse with @streamparser/json (${CHUNK_SIZE / 1024 / 1024}MB chunks)`);

      // Create parser with paths to extract only what we need
      const parser = new JSONParser({
        stringBufferSize: 64 * 1024, // 64KB buffer for large strings
        paths: ['$.nodes.*', '$.edges.*', '$.info'],
      });

      // Handle parsed values
      parser.onValue = ({ value, key, stack }) => {
        // stack.length indicates depth
        // For $.nodes.*, stack.length will be 2 (root, nodes array)
        // For $.edges.*, stack.length will be 2 (root, edges array)
        // For $.info, stack.length will be 1 (root)

        if (key === 'info' && stack.length === 1) {
          console.log('[ProjectManager] Captured info object from JSON');
          result.info = value;
        } else if (stack.length === 2) {
          // We're inside an array at depth 2
          const parentKey = stack[1]?.key;
          if (parentKey === 'nodes') {
            result.nodes.push(value);
            if (result.nodes.length % 10000 === 0) {
              console.log(`[ProjectManager] Parsed ${result.nodes.length} nodes...`);
            }
          } else if (parentKey === 'edges') {
            result.edges.push(value);
            if (result.edges.length % 10000 === 0) {
              console.log(`[ProjectManager] Parsed ${result.edges.length} edges...`);
            }
          }
        }
      };

      parser.onError = (error: Error) => {
        console.error('[ProjectManager] Parser error:', error);
        reject(error);
      };

      parser.onEnd = () => {
        console.log(`[ProjectManager] Parsing complete: ${result.nodes.length} nodes, ${result.edges.length} edges`);
        console.log(`[ProjectManager] Info object present: ${result.info ? 'YES' : 'NO'}`);
        if (result.info) {
          console.log('[ProjectManager] Info contains s types:', Object.keys(result.info.s || {}));
          console.log('[ProjectManager] Info contains t types:', Object.keys(result.info.t || {}));
        }
        if (updatePeakMemory) updatePeakMemory();
        resolve(result);
      };

      const readNextChunk = () => {
        if (offset >= file.size) {
          // Finish parsing
          try {
            parser.end();
          } catch (error) {
            reject(error);
          }
          return;
        }

        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const reader = new FileReader();

        reader.onload = (event) => {
          try {
            const text = event.target?.result as string;
            if (!text) {
              reject(new Error('Failed to read chunk: text is null'));
              return;
            }

            // Pass text as string to avoid UTF-8 splitting issues
            // The JSONParser library handles partial tokens across chunks correctly
            parser.write(text);

            // Track peak memory after processing chunk
            if (updatePeakMemory) updatePeakMemory();

            offset += CHUNK_SIZE;
            const progress = Math.min(100, (offset / file.size) * 100);
            this.prismAPI.progressIndicator.updateProgress(progress);
            this.prismAPI.progressIndicator.setStatus(
              `Parsing JSON... ${progress.toFixed(0)}% (${result.nodes.length.toLocaleString()} nodes, ${result.edges.length.toLocaleString()} edges)`
            );

            // Read next chunk
            setTimeout(readNextChunk, 0);
          } catch (error) {
            console.error('[ProjectManager] Error processing chunk:', error);
            reject(error);
          }
        };

        reader.onerror = () => {
          console.error('[ProjectManager] FileReader error');
          reject(new Error('Failed to read file'));
        };

        // Use readAsText to let FileReader handle UTF-8 decoding properly
        reader.readAsText(slice, 'UTF-8');
      };

      readNextChunk();
    });
  }

  /**
   * Cleanup
   */
  public dispose(): void {
    this.stopStatusPolling();
  }
}
