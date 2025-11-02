import type { Graph2D } from './Graph2D';
import type { PrismAPI } from './PrismAPI';

export class ProjectManager {
  private graph: Graph2D;
  private prismAPI: PrismAPI;
  private currentProjectId: string | null = null;
  private availableProjects: string[] = [];
  private statusPollInterval: number | null = null;
  private readonly POLL_INTERVAL_MS = 2000; // Poll every 2 seconds

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

    // Fetch and display project status
    await this.updateProjectStatus();
  }

  /**
   * Update project status and display in panel
   */
  private async updateProjectStatus(): Promise<void> {
    if (!this.currentProjectId) return;

    try {
      const status = await this.prismAPI.fetchProjectStatus(this.currentProjectId);
      this.displayParameterStatus(status);

      // Show parameter status section when selecting a project
      this.showParameterStatus();

      // Start polling if there are missing parameters
      if (this.prismAPI.hasMinsingParameters(status)) {
        this.startStatusPolling();
      } else {
        this.stopStatusPolling();
      }
    } catch (error) {
      console.error('[ProjectManager] Failed to fetch project status:', error);
    }
  }

  /**
   * Display parameter status in the panel
   */
  private displayParameterStatus(status: any): void {
    if (!this.paramStatusContent || !status?.info) return;

    this.paramStatusContent.innerHTML = '';

    // Display scheduler parameters
    if (status.info.scheduler) {
      this.renderParameterCategory('Scheduler', status.info.scheduler);
    }

    // Display state node parameters
    if (status.info.s) {
      this.renderNodeTypeParameters('State Nodes (s)', status.info.s);
    }

    // Display transition node parameters
    if (status.info.t) {
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
   * Render a simple parameter category (like scheduler)
   */
  private renderParameterCategory(title: string, params: Record<string, any>): void {
    if (!this.paramStatusContent) return;

    const categoryDiv = document.createElement('div');
    categoryDiv.className = 'param-category';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'param-category-title';
    titleDiv.textContent = title;
    categoryDiv.appendChild(titleDiv);

    for (const [key, value] of Object.entries(params)) {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'param-item';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'param-name';
      nameSpan.textContent = key;
      itemDiv.appendChild(nameSpan);

      const statusSpan = document.createElement('span');
      statusSpan.className = 'param-status-icon';

      if (value === 'missing') {
        statusSpan.textContent = '✗';
        statusSpan.classList.add('missing');
      } else if (value === 'ready') {
        statusSpan.textContent = '✓';
        statusSpan.classList.add('ready');
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
  private renderNodeTypeParameters(title: string, nodeTypeInfo: Record<string, any>): void {
    if (!this.paramStatusContent) return;

    const categoryDiv = document.createElement('div');
    categoryDiv.className = 'param-category';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'param-category-title';
    titleDiv.textContent = title;
    categoryDiv.appendChild(titleDiv);

    // Iterate through parameter categories
    for (const [categoryName, categoryParams] of Object.entries(nodeTypeInfo)) {
      if (typeof categoryParams !== 'object') continue;

      // Add subcategory title
      const subcategoryDiv = document.createElement('div');
      subcategoryDiv.style.marginTop = '8px';
      subcategoryDiv.style.marginBottom = '4px';
      subcategoryDiv.style.fontSize = '11px';
      subcategoryDiv.style.fontWeight = 'bold';
      subcategoryDiv.style.color = '#7f8c8d';
      subcategoryDiv.textContent = categoryName;
      categoryDiv.appendChild(subcategoryDiv);

      // Add parameters
      for (const [paramName, paramInfo] of Object.entries(categoryParams)) {
        if (typeof paramInfo !== 'object') continue;

        const itemDiv = document.createElement('div');
        itemDiv.className = 'param-item';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'param-name';
        nameSpan.textContent = paramName;
        itemDiv.appendChild(nameSpan);

        const statusSpan = document.createElement('span');
        statusSpan.className = 'param-status-icon';

        const status = (paramInfo as any).status || (paramInfo as any).type;

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
        categoryDiv.appendChild(itemDiv);
      }
    }

    this.paramStatusContent.appendChild(categoryDiv);
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
        if (!this.prismAPI.hasMinsingParameters(status)) {
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
      await this.updateProjectStatus();

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
   * Cleanup
   */
  public dispose(): void {
    this.stopStatusPolling();
  }
}
