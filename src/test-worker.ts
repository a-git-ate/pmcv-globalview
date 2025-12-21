/**
 * Test file for Web Worker implementation
 * Run this to verify the worker is processing data correctly
 */

import { PrismAPI } from './PrismAPI';

// Sample test data
const testData = {
  info: {
    id: 'test',
    s: {
      'Variable Values': {
        x: { type: 'number', status: 'active', min: 0, max: 100 },
        state: { type: 'nominal', status: 'active', min: '', max: '', possibleValues: [] }
      }
    },
    t: {
      'Variable Values': {
        action: { type: 'nominal', status: 'active', min: '', max: '', possibleValues: [] }
      }
    }
  },
  nodes: [
    { id: 's1', type: 's', name: 'State 1', details: { 'Variable Values': { x: 10, state: 'A' } } },
    { id: 's2', type: 's', name: 'State 2', details: { 'Variable Values': { x: 20, state: 'B' } } },
    { id: 's3', type: 's', name: 'State 3', details: { 'Variable Values': { x: 30, state: 'A' } } },
    { id: 't1', type: 't', name: 'Trans 1', details: { 'Variable Values': { action: 'move' } } },
    { id: 't2', type: 't', name: 'Trans 2', details: { 'Variable Values': { action: 'wait' } } },
  ],
  edges: [
    { source: 's1', target: 't1', label: '' },
    { source: 't1', target: 's2', label: '' },
    { source: 's2', target: 't2', label: '' },
    { source: 't2', target: 's3', label: '' },
  ]
};

async function testWorker() {
  console.log('=== Testing Web Worker Implementation ===\n');

  // Test with worker enabled
  console.log('1. Testing with Web Worker enabled...');
  const apiWithWorker = new PrismAPI('http://localhost:8080', true);
  const startWithWorker = performance.now();

  try {
    const resultWithWorker = await apiWithWorker.convertNewFormatToInternal(testData);
    const timeWithWorker = performance.now() - startWithWorker;
    console.log(`   ✓ Processed ${resultWithWorker.nodes.length} nodes, ${resultWithWorker.edges.length} edges`);
    console.log(`   ✓ Time: ${timeWithWorker.toFixed(2)}ms\n`);
  } catch (error) {
    console.error('   ✗ Worker test failed:', error);
  }

  // Test with worker disabled (main thread)
  console.log('2. Testing with main thread processing...');
  const apiWithoutWorker = new PrismAPI('http://localhost:8080', false);
  const startWithoutWorker = performance.now();

  try {
    const resultWithoutWorker = await apiWithoutWorker.convertNewFormatToInternal(testData);
    const timeWithoutWorker = performance.now() - startWithoutWorker;
    console.log(`   ✓ Processed ${resultWithoutWorker.nodes.length} nodes, ${resultWithoutWorker.edges.length} edges`);
    console.log(`   ✓ Time: ${timeWithoutWorker.toFixed(2)}ms\n`);
  } catch (error) {
    console.error('   ✗ Main thread test failed:', error);
  }

  // Cleanup
  apiWithWorker.destroy();
  apiWithoutWorker.destroy();

  console.log('=== Test Complete ===');
}

// Run the test
testWorker().catch(console.error);
