/**
 * Test file to verify new JSON format parsing with info metadata
 * Run this with: npx tsx src/test-new-format.ts
 */

import { PrismAPI } from './PrismAPI';

// Sample data in the new format (based on user's example)
const sampleData = {
  "nodes": [
    {
      "id": "244",
      "name": "2;2;0;2;0",
      "type": "s",
      "details": {
        "Variable Values": {
          "coin1": 0,
          "coin2": 0,
          "counter": 2,
          "pc1": 2,
          "pc2": 2
        },
        "Reward Structures": {
          "steps": 1
        },
        "Model Checking Results": {
          "PrMax_equal_0": 1,
          "PrMax_equal_1": 0,
          "PrMax_finished": 1,
          "PrMin_finished": 1
        },
        "Atomic Propositions": {
          "agree": true,
          "all_coins_equal_0": true,
          "all_coins_equal_1": false,
          "cause": false,
          "deadlock": false,
          "eff": false,
          "finished": false,
          "init": false
        }
      }
    },
    {
      "id": "100",
      "name": "1;1;0;1;1",
      "type": "s",
      "details": {
        "Variable Values": {
          "coin1": 1,
          "coin2": 1,
          "counter": 0,
          "pc1": 1,
          "pc2": 1
        },
        "Reward Structures": {
          "steps": 2
        },
        "Model Checking Results": {
          "PrMax_equal_0": 0,
          "PrMax_equal_1": 1,
          "PrMax_finished": 0,
          "PrMin_finished": 0
        },
        "Atomic Propositions": {
          "agree": false,
          "all_coins_equal_0": false,
          "all_coins_equal_1": true,
          "cause": false,
          "deadlock": false,
          "eff": false,
          "finished": false,
          "init": true
        }
      }
    }
  ],
  "edges": [
    {
      "source": "244",
      "target": "100",
      "label": "process1"
    },
    {
      "source": "100",
      "target": "244",
      "label": "process2"
    }
  ],
  "info": {
    "id": "0",
    "scheduler": {
      "PrMax_equal_0": "ready",
      "PrMax_equal_1": "ready",
      "PrMax_finished": "ready",
      "PrMin_finished": "ready"
    },
    "s": {
      "Atomic Propositions": {
        "init": {
          "identifier": "fa-solid fa-right-from-bracket",
          "icon": true,
          "type": "boolean"
        },
        "all_coins_equal_0": {
          "identifier": "a0",
          "icon": false,
          "type": "boolean"
        }
      },
      "Model Checking Results": {
        "PrMax_equal_0": {
          "type": "number",
          "status": "ready",
          "min": 0,
          "max": 1
        },
        "PrMax_equal_1": {
          "type": "number",
          "status": "ready",
          "min": 0,
          "max": 1
        },
        "PrMax_finished": {
          "type": "number",
          "status": "ready",
          "min": 0,
          "max": 1
        },
        "PrMin_finished": {
          "type": "number",
          "status": "ready",
          "min": 0,
          "max": 1
        }
      },
      "Reward Structures": {
        "steps": {
          "type": "number",
          "status": "ready",
          "min": 0,
          "max": "Infinity"
        }
      },
      "Variable Values": {
        "coin1": {
          "type": "number",
          "status": "ready",
          "min": 0,
          "max": 1
        },
        "coin2": {
          "type": "number",
          "status": "ready",
          "min": 0,
          "max": 1
        },
        "counter": {
          "type": "number",
          "status": "ready",
          "min": 0,
          "max": 12
        },
        "pc1": {
          "type": "number",
          "status": "ready",
          "min": 0,
          "max": 4
        },
        "pc2": {
          "type": "number",
          "status": "ready",
          "min": 0,
          "max": 4
        }
      }
    }
  }
};

console.log('Testing new JSON format parsing with info metadata...\n');

// Create PrismAPI instance
const api = new PrismAPI('http://localhost:8080');

// Test the conversion
try {
  // Access the private method through type assertion for testing
  const result = (api as any).convertNewFormatToInternal(sampleData);

  console.log('✓ Conversion successful!');
  console.log(`\nNodes converted: ${result.nodes.length}`);
  console.log(`Edges converted: ${result.edges.length}`);

  console.log('\nNode 0 details:');
  console.log(`  ID: ${result.nodes[0].id}`);
  console.log(`  Type: ${result.nodes[0].type}`);
  console.log(`  Parameters: [${result.nodes[0].parameters.join(', ')}]`);
  console.log(`  Radius: ${result.nodes[0].radius}`);

  console.log('\nNode 1 details:');
  console.log(`  ID: ${result.nodes[1].id}`);
  console.log(`  Type: ${result.nodes[1].type}`);
  console.log(`  Parameters: [${result.nodes[1].parameters.join(', ')}]`);
  console.log(`  Radius: ${result.nodes[1].radius}`);

  console.log('\nEdge 0 details:');
  console.log(`  From: ${result.edges[0].from} -> To: ${result.edges[0].to}`);
  console.log(`  Weight: ${result.edges[0].weight}`);

  // Test parameter metadata extraction
  const metadata = api.getParameterMetadata();
  console.log('\n✓ Parameter metadata stored successfully!');
  console.log(`  Graph ID: ${metadata?.id}`);
  console.log(`  Has state info: ${!!metadata?.s}`);

  if (metadata?.s?.['Variable Values']) {
    const varCount = Object.keys(metadata.s['Variable Values']).length;
    console.log(`  Variable Values count: ${varCount}`);
  }

  // Verify parameter extraction order
  const paramOrder = (api as any).extractParameterOrder(metadata, 's');
  console.log(`\n✓ Parameter extraction order (${paramOrder.length} params):`);
  paramOrder.slice(0, 10).forEach((p: any, i: number) => {
    console.log(`  ${i}: ${p.category} -> ${p.key}`);
  });

  // Test parameter labels for UI
  const paramLabels = api.getParameterLabels('s');
  console.log(`\n✓ Parameter labels for UI (${paramLabels.length} labels):`);
  paramLabels.forEach((label: any) => {
    console.log(`  [${label.index}] ${label.label} - ${label.fullPath}`);
  });

  console.log('\n✓ All tests passed!');

} catch (error) {
  console.error('✗ Test failed:', error);
  process.exit(1);
}
