import { io, Socket } from 'socket.io-client';
import type { NodeData } from './types';

// Selection action types
export type SelectionAction = 'merge' | 'delete' | 'duplicate' | 'export' | 'expand' | 'collapse';

// Selected state payload for STATE_SELECTED event
export interface StateSelectedPayload {
  id: string;  // project ID
  states: NodeData[];
}

// Socket events interface - Server to Client
interface ServerToClientEvents {
  'overview nodes selected': (nodeIds: string[]) => void;
  'handle selection': (action: SelectionAction) => void;
  'STATE_SELECTED': (payload: StateSelectedPayload) => void;
  'overview node clicked': (nodeId: string) => void;
  'pane added': (data: any) => void;
  'pane removed': (data: any) => void;
  'duplicate pane ids': (data: any) => void;
  'active pane': (data: any) => void;
  'reset pane-node markings': (data: any) => void;
}

// Client to Server events
interface ClientToServerEvents {
  'overview nodes selected': (nodeIds: string[]) => void;
  'handle selection': (action: SelectionAction) => void;
  'STATE_SELECTED': (payload: StateSelectedPayload, callback?: (err: any, resp: any) => void) => void;
  'overview node clicked': (nodeId: string) => void;
  'MC_STATUS': (project: string, callback: (data: any) => void) => void;
}

// Typed socket
export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

class SocketManager {
  private socket: TypedSocket | null = null;
  private _connected: boolean = false;
  private baseUrl: string = 'http://localhost:8080'; // Default socket server URL

  /**
   * Initialize the socket connection
   */
  public connect(url?: string): void {
    if (this.socket?.connected) {
      console.log('[Socket] Already connected');
      return;
    }

    const socketUrl = url || this.baseUrl;
    console.log(`[Socket] Connecting to ${socketUrl}...`);

    this.socket = io(socketUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    }) as TypedSocket;

    this.setupConnectionHandlers();
    this.setupListeners();
  }

  /**
   * Setup connection event handlers
   */
  private setupConnectionHandlers(): void {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      console.log('[Socket] Connected to backend successfully');
      this._connected = true;
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected from backend:', reason);
      this._connected = false;
    });

    this.socket.on('connect_error', (error) => {
      console.error('[Socket] Connection error:', error);
      this._connected = false;
    });
  }

  /**
   * Setup listeners for incoming socket events
   */
  private setupListeners(): void {
    if (!this.socket) return;

    // Listen for node selections from overview
    this.socket.on('overview nodes selected', (nodeIds) => {
      console.log('[Socket] Received overview nodes selected:', nodeIds);
      // Could emit custom events here for Graph2D to listen to
    });

    // Listen for selection actions (merge, delete, etc.)
    this.socket.on('handle selection', (action) => {
      console.log('[Socket] Received handle selection:', action);
      // Could emit custom events here for Graph2D to listen to
    });

    // Listen for STATE_SELECTED events
    this.socket.on('STATE_SELECTED', (payload) => {
      console.log('[Socket] Received STATE_SELECTED:', payload);
      // Could emit custom events here for Graph2D to listen to
    });
  }

  /**
   * Wait for connection before proceeding
   */
  public async waitForConnection(): Promise<void> {
    if (this._connected) return;

    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (this._connected) {
          clearInterval(interval);
          resolve();
        }
      }, 50);

      // Add timeout after 10 seconds
      setTimeout(() => {
        clearInterval(interval);
        console.warn('[Socket] Connection timeout - proceeding anyway');
        resolve();
      }, 10000);
    });
  }

  /**
   * Emit selected nodes to other clients (STATE_SELECTED event)
   * @param payload The state selected payload
   * @param callback Optional acknowledgment callback
   */
  public emitStateSelected(payload: StateSelectedPayload, callback?: (err: any, resp: any) => void): void {
    if (!this.socket?.connected) {
      console.warn('[Socket] Cannot emit STATE_SELECTED - not connected');
      return;
    }

    console.log(`[Socket] Emitting STATE_SELECTED for project ${payload.id} with ${payload.states.length} states`);

    if (callback) {
      this.socket.emit('STATE_SELECTED', payload, callback);
    } else {
      this.socket.emit('STATE_SELECTED', payload);
    }
  }

  /**
   * Emit overview nodes selected event
   * @param nodeIds Array of selected node IDs
   */
  public emitOverviewNodesSelected(nodeIds: string[]): void {
    if (!this.socket?.connected) {
      console.warn('[Socket] Cannot emit overview nodes selected - not connected');
      return;
    }

    console.log(`[Socket] Emitting overview nodes selected:`, nodeIds);
    this.socket.emit('overview nodes selected', nodeIds);
  }

  /**
   * Emit selection action
   * @param action The action to perform on selected nodes
   */
  public emitSelectionAction(action: SelectionAction): void {
    if (!this.socket?.connected) {
      console.warn('[Socket] Cannot emit handle selection - not connected');
      return;
    }

    console.log(`[Socket] Emitting handle selection:`, action);
    this.socket.emit('handle selection', action);
  }

  /**
   * Listen to a socket event (typed)
   */
  public on<E extends keyof ServerToClientEvents>(
    eventName: E,
    callback: ServerToClientEvents[E]
  ): void {
    if (!this.socket) {
      console.warn('[Socket] Cannot listen - socket not initialized');
      return;
    }
    this.socket.on(eventName, callback as any);
  }

  /**
   * Remove a socket event listener (typed)
   */
  public off<E extends keyof ServerToClientEvents>(
    eventName: E,
    callback?: ServerToClientEvents[E]
  ): void {
    if (!this.socket) return;
    if (callback) {
      this.socket.off(eventName, callback as any);
    } else {
      this.socket.off(eventName);
    }
  }

  /**
   * Disconnect the socket
   */
  public disconnect(): void {
    if (this.socket) {
      console.log('[Socket] Disconnecting...');
      this.socket.disconnect();
      this.socket = null;
      this._connected = false;
    }
  }

  /**
   * Check if socket is connected
   */
  public isConnected(): boolean {
    return this._connected;
  }

  /**
   * Get the typed socket instance (for advanced usage)
   */
  public getSocket(): TypedSocket | null {
    return this.socket;
  }
}

// Export singleton instance
export const socketManager = new SocketManager();
