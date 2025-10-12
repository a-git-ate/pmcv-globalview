const http = require('http');
const url = require('url');

// Sample graph data
const sampleGraphs = {
  '0': {
    nodes: [
      { id: 0, x: 0, y: 0, radius: 3, cluster: 0, value: 1.0, type: 'important' },
      { id: 1, x: 20, y: 15, radius: 2, cluster: 0, value: 0.8, type: 'normal' },
      { id: 2, x: -15, y: 20, radius: 2, cluster: 1, value: 0.6, type: 'normal' },
      { id: 3, x: 25, y: -10, radius: 2, cluster: 0, value: 0.4, type: 'normal' },
      { id: 4, x: -20, y: -15, radius: 2, cluster: 1, value: 0.3, type: 'normal' },
      { id: 5, x: 10, y: 25, radius: 2, cluster: 0, value: 0.7, type: 'normal' },
      { id: 6, x: -25, y: 5, radius: 2, cluster: 1, value: 0.5, type: 'normal' },
      { id: 7, x: 15, y: -20, radius: 2, cluster: 0, value: 0.9, type: 'normal' },
      { id: 8, x: -10, y: -25, radius: 2, cluster: 1, value: 0.2, type: 'normal' },
      { id: 9, x: 30, y: 10, radius: 2, cluster: 2, value: 0.1, type: 'normal' }
    ],
    edges: [
      { from: 0, to: 1, weight: 1.0 },
      { from: 0, to: 3, weight: 0.8 },
      { from: 0, to: 5, weight: 0.6 },
      { from: 1, to: 3, weight: 0.7 },
      { from: 1, to: 5, weight: 0.4 },
      { from: 3, to: 7, weight: 0.9 },
      { from: 2, to: 4, weight: 0.8 },
      { from: 2, to: 6, weight: 0.5 },
      { from: 4, to: 6, weight: 0.6 },
      { from: 4, to: 8, weight: 0.3 },
      { from: 7, to: 9, weight: 0.4 }
    ]
  }
};

// Sample PRISM data
const samplePrismProjects = {
  'test-model': {
    states: [
      { id: 's0', name: 'Initial', x: 0, y: 0, type: 'initial', properties: { reward: 0 } },
      { id: 's1', name: 'State 1', x: 30, y: 0, type: 'normal', properties: { reward: 1 } },
      { id: 's2', name: 'State 2', x: 15, y: 25, type: 'normal', properties: { reward: 2 } },
      { id: 's3', name: 'Target', x: 45, y: 25, type: 'target', properties: { reward: 10 } },
      { id: 's4', name: 'Deadlock', x: 0, y: 50, type: 'deadlock', properties: { reward: -1 } }
    ],
    transitions: [
      { source: 's0', target: 's1', probability: 0.7, action: 'move_right' },
      { source: 's0', target: 's2', probability: 0.3, action: 'move_up' },
      { source: 's1', target: 's3', probability: 0.8, action: 'reach_target' },
      { source: 's1', target: 's4', probability: 0.2, action: 'fail' },
      { source: 's2', target: 's3', probability: 0.6, action: 'reach_target' },
      { source: 's2', target: 's4', probability: 0.4, action: 'fail' }
    ]
  },
  'markov-chain': {
    nodes: [
      { id: 0, label: 'Start', x: 0, y: 0, type: 'initial' },
      { id: 1, label: 'Processing', x: 40, y: 0, type: 'normal' },
      { id: 2, label: 'Success', x: 20, y: 30, type: 'target' },
      { id: 3, label: 'Retry', x: 60, y: 30, type: 'normal' },
      { id: 4, label: 'Failure', x: 40, y: 60, type: 'deadlock' }
    ],
    edges: [
      { source: 0, target: 1, probability: 1.0, action: 'start' },
      { source: 1, target: 2, probability: 0.6, action: 'succeed' },
      { source: 1, target: 3, probability: 0.3, action: 'retry' },
      { source: 1, target: 4, probability: 0.1, action: 'fail' },
      { source: 3, target: 1, probability: 0.8, action: 'restart' },
      { source: 3, target: 4, probability: 0.2, action: 'give_up' }
    ]
  }
};

const server = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;
  
  console.log(`${req.method} ${pathname}${Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : ''}`);
  
  try {
    // Handle simple graph requests: /0/, /1/, etc.
    const simpleGraphMatch = pathname.match(/^\/(\d+)\/?$/);
    if (simpleGraphMatch) {
      const graphId = simpleGraphMatch[1];
      const graphData = sampleGraphs[graphId];
      
      if (graphData) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(graphData));
        return;
      }
    }
    
    // Handle PRISM project requests: /project-name or /project-name?view=1&view=2
    const prismMatch = pathname.match(/^\/([^\/]+)\/?$/);
    if (prismMatch) {
      const projectId = prismMatch[1];
      const projectData = samplePrismProjects[projectId];
      
      if (projectData) {
        let responseData = { ...projectData };
        
        // If view IDs are specified, you could filter data here
        if (query.view) {
          const viewIds = Array.isArray(query.view) ? query.view : [query.view];
          console.log(`Requested views: ${viewIds.join(', ')}`);
          // For demo, we'll just return all data regardless of views
          responseData.metadata = {
            requestedViews: viewIds,
            note: 'This is demo data - view filtering not implemented'
          };
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
        return;
      }
    }
    
    // Handle root request - return available endpoints
    if (pathname === '/' || pathname === '') {
      const info = {
        message: 'PRISM Graph API Test Server',
        endpoints: {
          simpleGraphs: Object.keys(sampleGraphs).map(id => `/0/`),
          prismProjects: Object.keys(samplePrismProjects),
          examples: [
            'GET /0/ - Simple graph with 10 nodes',
            'GET /test-model - PRISM model with states/transitions',
            'GET /markov-chain - PRISM model with nodes/edges',
            'GET /test-model?view=1&view=2 - PRISM model with view filter'
          ]
        },
        availableData: {
          graphs: Object.keys(sampleGraphs),
          projects: Object.keys(samplePrismProjects)
        }
      };
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info, null, 2));
      return;
    }
    
    // 404 for unknown endpoints
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Not Found',
      message: `Endpoint ${pathname} not found`,
      availableEndpoints: [
        '/',
        '/0/',
        '/test-model',
        '/markov-chain'
      ]
    }));
    
  } catch (error) {
    console.error('Server error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Internal Server Error',
      message: error.message
    }));
  }
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`🚀 PRISM Graph API Test Server running on http://localhost:${PORT}`);
  console.log('');
  console.log('Available endpoints:');
  console.log('  GET /           - API information');
  console.log('  GET /0/         - Simple graph data');
  console.log('  GET /test-model - PRISM states/transitions format');
  console.log('  GET /markov-chain - PRISM nodes/edges format');
  console.log('  GET /test-model?view=1&view=2 - PRISM with view parameters');
  console.log('');
  console.log('Try opening http://localhost:3001 in your browser to see the graph visualization!');
});