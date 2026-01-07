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
