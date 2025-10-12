# Graph API Format

The application expects a JSON object from `http://localhost:3000/0/` with the following structure:

## JSON Structure

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
    },
    {
      "id": 1,
      "x": 0,
      "y": 0,
      "radius": 4.5,
      "cluster": 1,
      "value": 0.95,
      "type": "important"
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

## Node Properties

- `id` (number, optional): Unique identifier. If not provided, array index is used.
- `x` (number, optional): X coordinate. If 0 or missing, position will be calculated by layout algorithm.
- `y` (number, optional): Y coordinate. If 0 or missing, position will be calculated by layout algorithm.
- `radius` (number, optional): Node size. Default: 2.0
- `cluster` (number, optional): Cluster identifier for grouping. Default: 0
- `value` (number, optional): Numeric value for analysis. Default: random
- `type` (string, optional): Node type ("normal" or "important"). Default: "normal"

## Edge Properties

- `from` (number): Source node ID/index
- `to` (number): Target node ID/index  
- `source` (number): Alternative to `from`
- `target` (number): Alternative to `to`
- `weight` (number, optional): Edge weight. Default: 1.0

## Features

- **Force-Directed Layout**: Connected nodes cluster together, isolated nodes spread apart
- **Visual Encoding**: Node color indicates connectivity (warm = connected, cool = isolated)
- **Size Scaling**: Nodes with more connections appear larger
- **Edge Visualization**: Toggle to show/hide graph edges
- **Interactive Controls**: Pan, zoom, click nodes

## Usage

1. Start your API server on `localhost:3000`
2. Ensure endpoint `/0/` returns valid JSON
3. Click "Load from API" button or refresh the page
4. Use "Toggle Edges" to show/hide connections
5. Try "Force-Directed" layout for clustering visualization