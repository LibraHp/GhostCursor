export type GraphicsMode = 'auto' | 'hardware' | 'compatibility';
export interface GraphicsState { mode: GraphicsMode; compatibility: boolean; restartRequired: boolean }
export function validGraphicsMode(value: unknown): value is GraphicsMode { return value === 'auto' || value === 'hardware' || value === 'compatibility'; }
export function useCompatibility(mode: GraphicsMode, windowsBuild: number, platform = 'win32'): boolean {
  return mode === 'compatibility' || (mode === 'auto' && platform === 'win32' && windowsBuild < 22000);
}
