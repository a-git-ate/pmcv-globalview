# PRISM API Integration

The graph visualization now supports both simple graph data and full PRISM model integration.

## API Endpoints

### Simple Graph API
- **Endpoint**: `http://localhost:3000/0/` (or any graph ID)
- **Format**: Simple JSON with nodes and edges arrays
- **Usage**: Click "Load Graph (ID: 0)" button

### PRISM Project API
- **Endpoint**: `http://localhost:3000/{project_id}` 
- **Query Parameters**: `?view=1&view=2&view=3` (optional)
- **Format**: PRISM-specific JSON with states/nodes and transitions/edges
- **Usage**: Enter project ID and view IDs, click "Load PRISM Project"

## Supported Data Formats

### Simple Graph Format
```json
{
  "nodes": [
    {
      "id": 0,
      "x": 10.5,
      "y": -5.2,
      "radius": 3.0,
      "cluster": 1,
      "value": 0.75,
      "type": "normal"
    }
  ],
  "edges": [
    {
      "from": 0,
      "to": 1,
      "weight": 1.0
    }
  ]
}
```

### PRISM Format (Multiple Variants Supported)
```json
{
  "states": [
    {
      "id": "s0",
      "name": "Initial State",
      "x": 0,
      "y": 0,
      "type": "initial",
      "properties": {"reward": 0}
    }
  ],
  "transitions": [
    {
      "source": "s0",
      "target": "s1", 
      "probability": 0.8,
      "action": "move"
    }
  ]
}
```

Alternative PRISM formats also supported:
- `nodes`/`edges` instead of `states`/`transitions`
- `graph.vertices`/`graph.transitions` nested format

## Features

### Auto-Loading
- Application tries to load from `localhost:3000/0/` on startup
- Falls back to PRISM format if simple format fails
- Falls back to demo data if all API calls fail

### UI Controls
- **Load Graph (ID: 0)**: Load simple graph from default endpoint
- **Project ID Input**: Enter PRISM project identifier
- **View IDs Input**: Comma-separated view numbers (optional)
- **Load PRISM Project**: Load specific PRISM project with optional views
- **Check API**: Test API connectivity and health

### Force-Directed Layout
- Connected nodes cluster together
- Isolated nodes spread apart
- Node size reflects connectivity (more connections = larger)
- Color coding: warm colors = connected, cool colors = isolated

### Edge Visualization
- Toggle edges on/off with "Toggle Edges" button
- Semi-transparent lines show connections
- Configurable opacity and color

## API Integration Features

### Caching
- 30-second cache for API responses
- Reduces redundant API calls
- Cache clearing on URL updates

### Error Handling
- Robust error handling with retries
- Graceful fallbacks between formats
- Clear error messages in UI

### Timeout Management
- 10-second timeout for API calls
- AbortController for proper request cancellation
- Health check with 5-second timeout

## Example API URLs

Based on your Java backend structure:

```
# Simple graph load
GET http://localhost:3000/0/

# PRISM project without views  
GET http://localhost:3000/my-prism-model

# PRISM project with specific views
GET http://localhost:3000/my-prism-model?view=1&view=2&view=3

# Single view
GET http://localhost:3000/my-prism-model?view=5
```

## Node Type Mapping

### Simple Format → Internal
- `type: "important"` → Important node (larger, different color)
- All others → Normal nodes

### PRISM Format → Internal  
- `type: "initial"` → Important node
- `type: "target"` → Important node  
- `type: "deadlock"` → Important node
- Others → Normal nodes

## Usage Examples

### Loading a Specific PRISM Project
1. Enter "my-model" in Project ID field
2. Enter "1,2,3" in View IDs field (optional)
3. Click "Load PRISM Project"

### Checking API Connectivity
1. Click "Check API" button
2. Status shows ✓ if healthy, ✗ if not responding

### Switching Between Formats
- Use "Load Graph (ID: 0)" for simple JSON format
- Use "Load PRISM Project" for PRISM-specific format
- Both support force-directed clustering

The integration automatically handles format detection and conversion, making it easy to work with either simple graph data or complex PRISM model outputs.