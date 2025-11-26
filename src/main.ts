import './style.css';
import { Graph2D } from './Graph2D.ts';
import type { GraphConfig } from './types';

// Global graph instance
let graph: Graph2D | null = null;

// Configuration options
const graphConfig: Partial<GraphConfig> = {
  maxVisibleNodes: 50000,
  renderDistance: 800,
  minZoom: 0.001, // Allow zooming out much further (was 0.05)
  maxZoom: 100.0,
  lodEnabled: true,
  edgesVisible: false, // Show edges by default
  clusterMode: false,
};

/**
 * Initialize the 2D graph application
 */
function initializeApp(): void {
  try {
    console.log('[Main] Initializing PMCV-Global');
    
    // Create graph instance with configuration
    graph = new Graph2D(graphConfig);
    
    console.log('[Main] Graph initialized successfully');
    
    // Start with loading from API after initialization
    setTimeout(() => {
      if (graph) {
        // First try loading simple graph data
        graph.loadGraph('0').catch(() => {
          console.warn('Failed to load from simple API, trying PRISM format...');
          // Try PRISM API format as fallback
          if (graph) {
            graph.loadPrismProject('0').catch(() => {
              // Final fallback to generating demo nodes
              console.warn('Failed to load from PRISM API, falling back to demo nodes');
              if (graph) {
                graph.generateNodes(500);
              }
            });
          }
        });
      }
    }, 1000);
    
  } catch (error) {
    handleInitializationError(error);
  }
}

/**
 * Handle initialization errors
 */
function handleInitializationError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown initialization error';
  
  console.error('Failed to initialize graph:', error);
  
  // Update UI with error message
  const statsElement = document.getElementById('stats');
  if (statsElement) {
    statsElement.textContent = `Initialization Error: ${message}`;
    statsElement.style.color = '#ff4444';
  }
  
  // Show error alert
  alert(`Failed to initialize 2D Graph:\n${message}\n\nPlease check your browser's WebGL support.`);
}

/**
 * Handle window resize events
 */
function handleWindowResize(): void {
  if (graph) {
    graph.onWindowResize();
  }
}

/**
 * Handle visibility change (for performance optimization)
 */
function handleVisibilityChange(): void {
  if (document.hidden) {
    console.log('Page hidden - could pause rendering here');
  } else {
    console.log('Page visible - resuming normal operation');
  }
}

/**
 * Clean up resources before page unload
 */
function handleBeforeUnload(): void {
  if (graph) {
    console.log('Cleaning up graph resources...');
    graph.dispose();
    graph = null;
  }
}

/**
 * Setup global event listeners
 */
function setupEventListeners(): void {
  // Window resize
  window.addEventListener('resize', handleWindowResize);
  
  // Page visibility for performance optimization
  document.addEventListener('visibilitychange', handleVisibilityChange);
  
  // Cleanup on page unload
  window.addEventListener('beforeunload', handleBeforeUnload);
  
  // Error handling
  window.addEventListener('error', (event) => {
    console.error('Global error:', event.error);
  });
  
  // Unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
  });
}

/**
 * Check browser compatibility
 */
function checkBrowserCompatibility(): boolean {
  // Check WebGL support
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  
  if (!gl) {
    console.error('WebGL not supported');
    alert('This application requires WebGL support. Please update your browser or enable hardware acceleration.');
    return false;
  }
  
  // Check for required features
  const requiredFeatures = [
    'Promise',
    'Float32Array',
    'requestAnimationFrame'
  ];
  
  for (const feature of requiredFeatures) {
    if (!(feature in window)) {
      console.error(`Required feature not supported: ${feature}`);
      alert(`Your browser does not support required features (${feature}). Please update your browser.`);
      return false;
    }
  }
  
  console.log('Browser compatibility check passed');
  return true;
}

/**
 * Log system information for debugging
 */
function logSystemInfo(): void {
  console.group('System Information');
  console.log('User Agent:', navigator.userAgent);
  console.log('Screen:', `${screen.width}x${screen.height}`);
  console.log('Window:', `${window.innerWidth}x${window.innerHeight}`);
  console.log('Device Pixel Ratio:', window.devicePixelRatio);
  console.log('Available Memory:', (navigator as any).deviceMemory || 'Unknown');
  console.log('Hardware Concurrency:', navigator.hardwareConcurrency || 'Unknown');
  
  // WebGL info
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl');
  if (gl) {
    console.log('WebGL Vendor:', gl.getParameter(gl.VENDOR));
    console.log('WebGL Renderer:', gl.getParameter(gl.RENDERER));
    console.log('WebGL Version:', gl.getParameter(gl.VERSION));
  }
  console.groupEnd();
}

/**
 * Main entry point
 */
function main(): void {
  console.log('Starting 2D Million Node Graph application...');
  
  // Log system information
  logSystemInfo();
  
  // Check browser compatibility
  if (!checkBrowserCompatibility()) {
    return;
  }
  
  // Setup event listeners
  setupEventListeners();
  
  // Initialize the application
  initializeApp();
}

// Initialize when DOM is loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}

// Export graph instance for debugging in console
declare global {
  interface Window {
    graph: Graph2D | null;
    debugInfo: () => void;
  }
}

// Make graph globally available for debugging
Object.defineProperty(window, 'graph', {
  get: () => graph,
  configurable: false,
  enumerable: true
});

// Debug function for console
window.debugInfo = () => {
  if (!graph) {
    console.log('Graph not initialized');
    return;
  }
  
  console.group('Graph Debug Info');
  console.log('Node Count:', graph.getNodeCount().toLocaleString());
  console.log('Last Render Time:', graph.getLastRenderTime().toFixed(2) + 'ms');
  console.log('Configuration:', graph.getConfig());
  console.groupEnd();
};

console.log('Main module loaded. Type `debugInfo()` in console for debug information.');