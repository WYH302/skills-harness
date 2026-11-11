import { contextBridge, ipcRenderer } from 'electron';
const methods=new Set(['getState','setLanguage','discover','generate','chooseSourceDirectory','selectBrowser','connectSource','run','resume','cancel','demo','exitDemo','import','saveSettings','skill','saveSkill','skillState','deleteSkill','evidence','selectedMaterials','versions','rollback','acceptRevision','dismissRevision','export','install','forget','chooseDataDir','openExtension','openExternal','router','getConversations','conversation','rotatePairingCode','restart']);
for(const method of ['chooseGenerator','connectChatGPT','cancelAuthorization','disconnectChatGPT','refreshChatGPTModels','connectGenerator','probeApi'])methods.add(method);
contextBridge.exposeInMainWorld('skillharbor',Object.freeze({
  request:(method:string,args?:unknown)=>{if(!methods.has(method))return Promise.reject(new Error('Unknown action'));return ipcRenderer.invoke('skillharbor:request',method,args);},
  onUpdate:(listener:()=>void)=>{const handler=()=>listener();ipcRenderer.on('skillharbor:update',handler);return ()=>ipcRenderer.removeListener('skillharbor:update',handler);}
}));
