import { contextBridge, ipcRenderer } from 'electron'
import { type Bridge } from '../shared/schema'

const api: Bridge = {
  command: (command) => ipcRenderer.invoke('director:command', command),
  previsFrame: (sessionId, index, data) => ipcRenderer.invoke('director:previs-frame', sessionId, index, data),
  onChange: (listener) => {
    const handler = () => listener()
    ipcRenderer.on('director:changed', handler)
    return () => ipcRenderer.removeListener('director:changed', handler)
  },
}
contextBridge.exposeInMainWorld('director', api)
