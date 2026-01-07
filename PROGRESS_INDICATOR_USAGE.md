# Progress Indicator Usage Guide

## Overview

The `ProgressIndicator` is a modular, reusable component that displays a loading progress window in the bottom-right corner of the screen. It's designed to show progress for long-running operations like fetching large models, processing data, or any other time-consuming tasks.

## Features

- **Rectangular window positioned in bottom-right corner**
- **Smooth animations** for showing/hiding
- **Multiple display modes:**
  - Progress bar with percentage (0-100%)
  - Byte/megabyte tracking for downloads
  - Node count tracking for data processing
  - Indeterminate mode for unknown progress
- **Customizable title and status text**
- **Modular design** - can be used anywhere in the application

## Basic Usage

### 1. Import the ProgressIndicator

```typescript
import { ProgressIndicator } from './ProgressIndicator';
```

### 2. Create an instance

```typescript
const progressIndicator = new ProgressIndicator();
```

### 3. Show the progress indicator

```typescript
progressIndicator.show({ title: 'Loading Data' });
```

### 4. Update progress

```typescript
// Update with percentage (0-100)
progressIndicator.updateProgress(50);

// Update with custom status message
progressIndicator.setStatus('Processing...');
```

### 5. Hide when done

```typescript
progressIndicator.hide();
```

## API Reference

### Methods

#### `show(config?: ProgressConfig): void`
Shows the progress indicator.

**Config options:**
- `title?: string` - The title displayed in the header bar (default: "Loading...")
- `showPercentage?: boolean` - Whether to show percentage (default: true)
- `showBytes?: boolean` - Whether to display byte information
- `showNodeCount?: boolean` - Whether to display node count information

**Example:**
```typescript
progressIndicator.show({ title: 'Fetching Graph Data' });
```

#### `hide(): void`
Hides the progress indicator and resets it to default state.

#### `updateProgress(percentage: number): void`
Updates the progress bar (0-100%).

**Example:**
```typescript
progressIndicator.updateProgress(75);
```

#### `setTitle(title: string): void`
Updates the title text.

**Example:**
```typescript
progressIndicator.setTitle('Processing Nodes');
```

#### `setStatus(status: string): void`
Updates the status text below the progress bar.

**Example:**
```typescript
progressIndicator.setStatus('5 MB / 10 MB');
```

#### `updateBytes(loaded: number, total?: number): void`
Updates the progress indicator with byte information.

**Parameters:**
- `loaded: number` - Bytes loaded so far
- `total?: number` - Total bytes (optional, if known)

**Example:**
```typescript
progressIndicator.updateBytes(5242880, 10485760); // 5 MB / 10 MB
```

#### `updateNodeCount(count: number, total?: number): void`
Updates the progress indicator with node count information.

**Parameters:**
- `count: number` - Nodes processed so far
- `total?: number` - Total nodes (optional, if known)

**Example:**
```typescript
progressIndicator.updateNodeCount(50000, 100000); // 50,000 / 100,000 nodes
```

#### `setIndeterminate(status?: string): void`
Sets the progress bar to indeterminate mode (animated gradient when progress is unknown).

**Example:**
```typescript
progressIndicator.setIndeterminate('Processing...');
```

#### `clearIndeterminate(): void`
Clears the indeterminate mode and returns to normal progress bar.

#### `isShowing(): boolean`
Returns `true` if the progress indicator is currently visible.

#### `dispose(): void`
Removes the progress indicator from the DOM and cleans up resources.

## Complete Examples

### Example 1: Tracking file download

```typescript
const progressIndicator = new ProgressIndicator();

async function downloadFile(url: string) {
  progressIndicator.show({ title: 'Downloading File' });

  const response = await fetch(url);
  const total = parseInt(response.headers.get('content-length') || '0', 10);
  const reader = response.body?.getReader();

  let receivedLength = 0;
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader!.read();
    if (done) break;

    chunks.push(value);
    receivedLength += value.length;

    // Update progress
    progressIndicator.updateBytes(receivedLength, total);
  }

  progressIndicator.hide();
}
```

### Example 2: Tracking data processing

```typescript
const progressIndicator = new ProgressIndicator();

function processNodes(nodes: any[]) {
  progressIndicator.show({ title: 'Processing Nodes' });

  const total = nodes.length;

  for (let i = 0; i < nodes.length; i++) {
    // Process node
    processNode(nodes[i]);

    // Update every 1000 nodes
    if (i % 1000 === 0) {
      progressIndicator.updateNodeCount(i, total);
    }
  }

  progressIndicator.hide();
}
```

### Example 3: Unknown progress (indeterminate)

```typescript
const progressIndicator = new ProgressIndicator();

async function performComplexOperation() {
  progressIndicator.show({ title: 'Processing' });
  progressIndicator.setIndeterminate('Analyzing data...');

  await someComplexOperation();

  progressIndicator.hide();
}
```

## Integration in PrismAPI

The progress indicator is already integrated in the `PrismAPI` class for tracking graph data fetching:

```typescript
// In PrismAPI.ts
async fetchSimpleGraph(projectId: string = '0'): Promise<...> {
  // Show progress
  this.progressIndicator.show({ title: 'Loading Graph Data' });

  // Fetch with byte tracking
  const response = await fetch(url);
  const total = parseInt(response.headers.get('content-length') || '0', 10);

  // Stream and track progress
  while (reading) {
    this.progressIndicator.updateBytes(receivedLength, total);
  }

  // Hide when done
  this.progressIndicator.hide();
}
```

The worker also sends progress updates during node processing, which are automatically displayed by the progress indicator.

## Styling

The progress indicator uses CSS classes defined in `style.css`:

- `.progress-indicator` - Main container
- `.progress-title-bar` - Header with title
- `.progress-bar-container` - Progress bar background
- `.progress-bar-fill` - Progress bar fill
- `.progress-status` - Status text
- `.progress-percentage` - Percentage display

You can customize the appearance by modifying these classes in the stylesheet.

## Notes

- The progress indicator automatically positions itself in the bottom-right corner
- It has a high z-index (1000) to appear above most content
- The component includes smooth fade-in/fade-out animations
- Multiple calls to `show()` won't create multiple instances - the same instance is reused
- Always call `hide()` when the operation is complete to ensure the indicator is removed
