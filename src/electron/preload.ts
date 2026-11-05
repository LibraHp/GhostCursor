import { contextBridge, ipcRenderer } from 'electron';
import type { GhostBridge, HostState, HostEvent } from '../shared/protocol';
const api: GhostBridge = {
  state: () => ipcRenderer.invoke('state'), sources: () => ipcRenderer.invoke('sources'),
  start: options => ipcRenderer.invoke('start', options), stop: () => ipcRenderer.invoke('stop'),
  selectController: id => ipcRenderer.invoke('select-controller', id), toggleControl: () => ipcRenderer.invoke('toggle-control'),
  setHotkey: value => ipcRenderer.invoke('set-hotkey', value),
  recordHotkey: value => ipcRenderer.invoke('record-hotkey', value),
  setVideo: value => ipcRenderer.invoke('set-video', value),
  setCursor: value => ipcRenderer.invoke('set-cursor', value),
  setGraphics: mode => ipcRenderer.invoke('set-graphics', mode),
  setNetwork: value => ipcRenderer.invoke('set-network', value),
  restart: () => ipcRenderer.invoke('restart'), copyGraphicsDiagnostics: () => ipcRenderer.invoke('copy-graphics-diagnostics'),
  disconnect: (id, reason) => ipcRenderer.invoke('disconnect', id, reason),
  diagnostics: () => ipcRenderer.invoke('diagnostics'),
  signal: (id, signal) => ipcRenderer.send('signal', id, signal),
  pointer: (id, message) => ipcRenderer.send('pointer', id, message),
  relayStart: (id, sessionId, streamId, mime) => ipcRenderer.invoke('relay-start', id, sessionId, streamId, mime),
  relayChunk: (id, sessionId, streamId, sequence, data) => ipcRenderer.invoke('relay-chunk', id, sessionId, streamId, sequence, data),
  frameSize: (width, height) => ipcRenderer.send('frame-size', width, height),
  copy: text => ipcRenderer.invoke('copy', text),
  onState: callback => { const fn = (_: unknown, state: HostState) => callback(state); ipcRenderer.on('state', fn); return () => ipcRenderer.removeListener('state', fn); },
  onEvent: callback => { const fn = (_: unknown, event: HostEvent) => callback(event); ipcRenderer.on('event', fn); return () => ipcRenderer.removeListener('event', fn); },
  close: () => ipcRenderer.send('close'), minimize: () => ipcRenderer.send('minimize'),
};
contextBridge.exposeInMainWorld('ghost', api);
