const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dubflowDesktop', {
  pickVideo: () => ipcRenderer.invoke('dubflow:pick-video'),
  pickAudio: () => ipcRenderer.invoke('dubflow:pick-audio'),
  pickLogo: () => ipcRenderer.invoke('dubflow:pick-logo'),
  pickGoogleCredentials: () => ipcRenderer.invoke('dubflow:pick-google-credentials'),
  pickOutputFolder: () => ipcRenderer.invoke('dubflow:pick-output-folder'),
});
