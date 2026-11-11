import { useApp } from './context';

export function BrowserPicker({allowPair=false}:{allowPair?:boolean}) {
  const {state,t,act}=useApp();const clients=state.bridge.clients||[];
  if(state.demo)return null;
  return <div className="browser-picker">
    {clients.length>0&&<label>{t('使用此浏览器中的登录','Use sign-in from this browser')}<select aria-label={t('采集浏览器','Collection browser')} value={state.bridge.selectedClientId||''} disabled={state.run?.status==='running'} onChange={event=>act('selectBrowser',{id:event.target.value})}>{clients.map(client=><option key={client.id} value={client.id}>{client.name} · {client.online?t('在线','online'):t('未连接','offline')}</option>)}</select><small>{t('只读取所选浏览器；其他浏览器账户不会混入。','Only this browser is read. Other browser profiles stay separate.')}</small></label>}
    {allowPair&&clients.length>0&&<details><summary>{t('连接另一个浏览器','Pair another browser')}</summary><p>{t('在另一个浏览器的扩展中输入此配对码：','Enter this code in the extension in your other browser:')}</p><code className="browser-pair-code">{state.bridge.pairingCode}</code><button className="text-button" onClick={()=>act('rotatePairingCode')}>{t('更新配对码','Renew code')}</button></details>}
  </div>;
}
