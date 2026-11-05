export type GraphicsMode = 'auto' | 'hardware' | 'compatibility';
export interface GraphicsState { mode: GraphicsMode; compatibility: boolean; restartRequired: boolean }
export function validGraphicsMode(value: unknown): value is GraphicsMode { return value === 'auto' || value === 'hardware' || value === 'compatibility'; }
export function useCompatibility(mode: GraphicsMode, windowsBuild: number): boolean {
  return mode === 'compatibility' || (mode === 'auto' && windowsBuild < 22000);
}
