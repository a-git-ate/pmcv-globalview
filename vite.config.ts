import { defineConfig } from 'vite';
import type { UserConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }): UserConfig => {
  const isProduction = mode === 'production';
  
  return {
    // Base public path when served in production
    base: './',
    
    // Development server options
    server: {
      host: true, // Listen on all local IPs
      port: 3000,
      open: true, // Automatically open in browser
      cors: true, // Enable CORS for development
      strictPort: false, // Try other ports if 3000 is busy
    },
    
    // Preview server options (for build preview)
    preview: {
      host: true,
      port: 4173,
      open: true,
      cors: true,
    },
    
    // Build options
    build: {
      // Output directory
      outDir: 'dist',
      
      // Generate sourcemaps in development
      sourcemap: !isProduction,
      
      // Minify option - use terser for better compression
      minify: isProduction ? 'terser' : false,
      
      // Rollup options for advanced bundling configuration
      rollupOptions: {
        output: {
          // Manual chunks for better caching strategy
          manualChunks: {
            // Separate vendor chunk for Three.js
            'three': ['three'],
          },
          // Naming pattern for chunks
          chunkFileNames: (chunkInfo) => {
            const facadeModuleId = chunkInfo.facadeModuleId ? 
              chunkInfo.facadeModuleId.split('/').pop()?.replace('.ts', '') : 'chunk';
            return `assets/${facadeModuleId}-[hash].js`;
          },
          // Naming pattern for assets
          assetFileNames: 'assets/[name]-[hash].[ext]',
        },
        // External dependencies (if needed)
        external: [],
      },
      
      // Chunk size warning threshold
      chunkSizeWarningLimit: 1000, // 1MB
      
      // Asset handling
      assetsInlineLimit: 4096, // 4KB - inline small assets as base64
    },
    
    // Dependency optimization
    optimizeDeps: {
      // Include dependencies for pre-bundling
      include: ['three'],
      // Exclude from pre-bundling if needed
      exclude: [],
    },
    
    // CSS options
    css: {
      // Generate sourcemaps for CSS
      devSourcemap: !isProduction,
      // CSS modules configuration (if needed)
      modules: false,
    },
    
    // Define global constants
    define: {
      // Useful for conditional compilation
      __DEV__: !isProduction,
      __PROD__: isProduction,
      // Version info
      __VERSION__: JSON.stringify(process.env.npm_package_version || '1.0.0'),
    },
    
    // Plugin options
    plugins: [
      // Add plugins here if needed
    ],
    
    // TypeScript path resolution (if using path aliases)
    resolve: {
      alias: {
        // Example: '@': path.resolve(__dirname, 'src'),
      },
    },
    
    // Environment variables
    envPrefix: ['VITE_', 'GRAPH_'],
    
    // Worker options (if using web workers)
    worker: {
      format: 'es',
    },
    
    // Experimental features
    experimental: {
      // Enable if using top-level await
      // renderBuiltUrl: false,
    },
    
    // Logging level
    logLevel: isProduction ? 'error' : 'info',
    
    // Clear screen on rebuild
    clearScreen: true,
  };
});