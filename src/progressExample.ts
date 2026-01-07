/**
 * Example usage of the ProgressIndicator component
 * This file demonstrates how to use the progress indicator for various scenarios
 */

import { ProgressIndicator } from './ProgressIndicator';

// Create a progress indicator instance
const progress = new ProgressIndicator();

/**
 * Example 1: Simulating a file download with byte tracking
 */
export async function exampleFileDownload() {
  progress.show({ title: 'Downloading Large File' });

  const totalBytes = 50 * 1024 * 1024; // 50 MB
  let loadedBytes = 0;

  // Simulate downloading in chunks
  const interval = setInterval(() => {
    loadedBytes += 1024 * 1024; // Add 1 MB per tick

    if (loadedBytes >= totalBytes) {
      clearInterval(interval);
      progress.hide();
      console.log('Download complete!');
    } else {
      progress.updateBytes(loadedBytes, totalBytes);
    }
  }, 100);
}

/**
 * Example 2: Processing nodes with count tracking
 */
export async function exampleNodeProcessing() {
  progress.show({ title: 'Processing Graph Nodes' });

  const totalNodes = 100000;
  let processedNodes = 0;

  // Simulate processing nodes
  const interval = setInterval(() => {
    processedNodes += 5000; // Process 5000 nodes per tick

    if (processedNodes >= totalNodes) {
      clearInterval(interval);
      progress.hide();
      console.log('Node processing complete!');
    } else {
      progress.updateNodeCount(processedNodes, totalNodes);
    }
  }, 100);
}

/**
 * Example 3: Indeterminate progress (unknown duration)
 */
export async function exampleIndeterminateOperation() {
  progress.show({ title: 'Analyzing Data' });
  progress.setIndeterminate('Please wait...');

  // Simulate a long operation with unknown duration
  await new Promise(resolve => setTimeout(resolve, 3000));

  progress.hide();
  console.log('Analysis complete!');
}

/**
 * Example 4: Custom progress with manual updates
 */
export async function exampleCustomProgress() {
  progress.show({ title: 'Custom Operation' });

  // Step 1
  progress.updateProgress(0);
  progress.setStatus('Initializing...');
  await new Promise(resolve => setTimeout(resolve, 500));

  // Step 2
  progress.updateProgress(25);
  progress.setStatus('Loading configuration...');
  await new Promise(resolve => setTimeout(resolve, 500));

  // Step 3
  progress.updateProgress(50);
  progress.setStatus('Processing data...');
  await new Promise(resolve => setTimeout(resolve, 500));

  // Step 4
  progress.updateProgress(75);
  progress.setStatus('Finalizing...');
  await new Promise(resolve => setTimeout(resolve, 500));

  // Step 5
  progress.updateProgress(100);
  progress.setStatus('Complete!');
  await new Promise(resolve => setTimeout(resolve, 500));

  progress.hide();
  console.log('Custom operation complete!');
}

/**
 * Example 5: Multi-stage operation with title changes
 */
export async function exampleMultiStageOperation() {
  // Stage 1: Fetching data
  progress.show({ title: 'Stage 1: Fetching Data' });
  progress.setIndeterminate('Connecting to server...');
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Stage 2: Processing
  progress.setTitle('Stage 2: Processing Data');
  progress.clearIndeterminate();

  for (let i = 0; i <= 100; i += 10) {
    progress.updateProgress(i);
    progress.setStatus(`Processing... ${i}%`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  // Stage 3: Finalizing
  progress.setTitle('Stage 3: Finalizing');
  progress.setIndeterminate('Cleaning up...');
  await new Promise(resolve => setTimeout(resolve, 1000));

  progress.hide();
  console.log('Multi-stage operation complete!');
}

// Example of using the progress indicator in a real fetch operation
export async function exampleRealFetch(url: string) {
  progress.show({ title: 'Fetching Resource' });

  try {
    const response = await fetch(url);
    const contentLength = response.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedLength = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      chunks.push(value);
      receivedLength += value.length;

      // Update progress
      if (total > 0) {
        progress.updateBytes(receivedLength, total);
      } else {
        progress.updateBytes(receivedLength);
      }
    }

    // Combine chunks
    const allChunks = new Uint8Array(receivedLength);
    let position = 0;
    for (const chunk of chunks) {
      allChunks.set(chunk, position);
      position += chunk.length;
    }

    progress.hide();

    return allChunks;
  } catch (error) {
    progress.hide();
    throw error;
  }
}

// Make examples available globally for testing in console
if (typeof window !== 'undefined') {
  (window as any).progressExamples = {
    fileDownload: exampleFileDownload,
    nodeProcessing: exampleNodeProcessing,
    indeterminate: exampleIndeterminateOperation,
    custom: exampleCustomProgress,
    multiStage: exampleMultiStageOperation,
    realFetch: exampleRealFetch
  };

  console.log('Progress indicator examples loaded. Try in console:');
  console.log('  progressExamples.fileDownload()');
  console.log('  progressExamples.nodeProcessing()');
  console.log('  progressExamples.indeterminate()');
  console.log('  progressExamples.custom()');
  console.log('  progressExamples.multiStage()');
}
