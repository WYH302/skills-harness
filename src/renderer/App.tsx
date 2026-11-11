import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, CircleAlert, Copy, ExternalLink, FolderOpen, History, Info, LibraryBig, LoaderCircle, PanelLeftClose, RefreshCw, Search, Settings2, Sparkles, Wifi, X } from 'lucide-react';
import type { AppState } from '../shared/types';
import { AppContext } from './context';
import { HarborMark, Modal, LanguageSwitch } from './components';
import { CollectView } from './CollectView';
import { LibraryView } from './LibraryView';
import { HistoryView } from './HistoryView';
import { SettingsView } from './SettingsView';
import { localizeNotice } from '../shared/localization';

type Page = 'collect'|'library'|'history'|'settings';
interface Confirmation {title:string;detail:string;destructive:boolean;labels?:{confirm?:string;cancel?:string};resolve:(value:boolean)=>void}
export function App() {
  const [state,setState]=useState<AppState|null>(null);const stateRef=useRef<AppState|null>(null);
  const [page,setPage]=useState<Page>('collect');const [bootError,setBootError]=useState('');
  const [toast,setToast]=useState<{text:string;error:boolean}|null>(null);const [pending,setPending]=useState(new Set<string>());
  const [confirmation,setConfirmation]=useState<Confirmation|null>(null);const [setup,setSetup]=useState(false);const [collapsed,setCollapsed]=useState(false);
  const [autoOpenRun,setAutoOpenRun]=useState<string|null>(null);
  const navigationGuard=useRef<(()=>Promise<boolean>)|null>(null);
  const guardNavigation=useCallback((guard:()=>Promise<boolean>)=>{navigationGuard.current=guard;return()=>{if(navigationGuard.current===guard)navigationGuard.current=null;};},[]);
  const t=useCallback((zh:string,en:string)=>state?.settings.language==='en'?en:zh,[state?.settings.language]);
  const refresh=useCallback(async()=>{const value=await window.skillharbor.request<AppState>('getState');stateRef.current=value;setState(value);},[]);
  const act=useCallback(async<T=unknown,>(method:string,args?:unknown,success?:string):Promise<T|undefined>=>{
    setPending(previous=>new Set(previous).add(method));
    try{const result=await window.skillharbor.request<T>(method,args);await refresh();if(success&&!(result&&typeof result==='object'&&'cancelled' in result&&result.cancelled))setToast({text:success,error:false});return result;}
    catch(error){setToast({text:localizeNotice((error instanceof Error?error.message:String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,''),stateRef.current?.settings.language||'zh'),error:true});return undefined;}
    finally{setPending(previous=>{const next=new Set(previous);next.delete(method);return next;});}
  },[refresh]);
  const confirm=useCallback((title:string,detail:string,destructive=false,labels?:{confirm?:string;cancel?:string})=>new Promise<boolean>(resolve=>setConfirmation({title,detail,destructive,labels,resolve})),[]);
  const navigate=useCallback(async(next:Page)=>{if(next===page)return true;if(navigationGuard.current&&!await navigationGuard.current())return false;setPage(next);return true;},[page]);
  useEffect(()=>{
    if(!window.skillharbor){setBootError('请使用 Skills-Harness 桌面应用打开。 / Open this interface in the Skills-Harness desktop app.');return;}
    let timer:ReturnType<typeof setTimeout>|undefined;
    void refresh().catch(error=>setBootError(error instanceof Error?error.message:String(error)));
    const unsubscribe=window.skillharbor.onUpdate(()=>{if(!timer){void refresh().catch(()=>{});timer=setTimeout(()=>{timer=undefined;void refresh().catch(()=>{});},120);}});
    return()=>{unsubscribe();if(timer)clearTimeout(timer);};
  },[refresh]);
  useEffect(()=>{if(state)document.documentElement.lang=state.settings.language==='zh'?'zh-CN':'en';},[state?.settings.language]);
  useEffect(()=>{if(autoOpenRun&&state?.run?.id===autoOpenRun&&state.run.status==='completed'&&!setup&&!confirmation){if((state.run.skills>0||!state.demo&&state.stats.skills>0)&&page==='collect')setPage('library');setAutoOpenRun(null);}},[autoOpenRun,state?.run?.id,state?.run?.status,state?.run?.skills,state?.demo,state?.stats.skills,page,setup,confirmation]);
  useEffect(()=>{if(!setup)return;const timer=setInterval(()=>{void refresh().catch(()=>{});},3000);return()=>clearInterval(timer);},[setup,refresh]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(null),toast.error?15000:5500);return()=>clearTimeout(timer);},[toast]);
  const findSkills=useCallback(async()=>{if(await navigate('library'))setTimeout(()=>document.querySelector<HTMLInputElement>('.library-toolbar input')?.focus(),80);},[navigate]);
  useEffect(()=>{const shortcut=(event:KeyboardEvent)=>{if(!document.querySelector('[role=dialog]')&&(event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();findSkills();}};document.addEventListener('keydown',shortcut);return()=>document.removeEventListener('keydown',shortcut);},[findSkills]);
  const resolveConfirmation=(result:boolean)=>{confirmation?.resolve(result);setConfirmation(null);};
  if(!state)return <div className="boot-screen"><HarborMark/><h1>Skills-Harness</h1>{bootError?<><p role="alert">{bootError}</p><button className="button secondary" onClick={()=>window.location.reload()}><RefreshCw size={15}/>重新打开 / Retry</button></>:<><LoaderCircle className="spin" size={23}/><p>正在打开你的本地工作空间… / Opening your local workspace…</p></>}</div>;
  const nav=[{id:'collect' as const,icon:<Sparkles size={18}/>,label:t('采集与生成','Collect & generate')},{id:'library' as const,icon:<LibraryBig size={18}/>,label:t('技能库','Skill library'),count:state.stats.skills},{id:'history' as const,icon:<History size={18}/>,label:t('历史与依据','History & evidence')},{id:'settings' as const,icon:<Settings2 size={18}/>,label:t('设置与隐私','Settings & privacy')}];
  const openSetup=()=>setSetup(true);
  return <AppContext.Provider value={{state,t,refresh,act,confirm,pending,guardNavigation}}><div className={`app-shell ${navigator.platform.startsWith('Win')?'windows':''} ${collapsed?'sidebar-collapsed':''}`}>
    <aside className="sidebar">
      <div className="brand"><HarborMark/><div><strong>Skills-Harness</strong><span>{t('你的个人技能工作空间','Your personal skill workspace')}</span></div></div>
      <div className="workspace-label"><span className="workspace-symbol">{state.demo?'S':'H'}</span><div><strong>{state.demo?t('示例工作空间','Sample workspace'):t('我的工作空间','My workspace')}</strong><span>{t('仅在此设备上','On this device')}</span></div></div>
      <div className="nav-section-label">{t('工作空间','WORKSPACE')}</div>
      <nav aria-label={t('主导航','Main navigation')}>{nav.map(item=><button key={item.id} title={item.label} aria-label={item.label} className={page===item.id?'active':''} onClick={()=>{void navigate(item.id);}} aria-current={page===item.id?'page':undefined}>{item.icon}<span>{item.label}</span>{item.count!==undefined&&<span className="nav-count">{item.count}</span>}</button>)}</nav>
      <div className="sidebar-spacer"/>
      <button className={`sidebar-connect ${state.bridge.paired?'is-connected':''}`} onClick={openSetup}><span className="sidebar-connect-icon"><Wifi size={17}/></span><div><strong>{state.bridge.paired?t('浏览器已连接','Browser connected'):t('连接浏览器','Connect browser')}</strong><span>{state.bridge.paired?t('查看连接与权限','Connection & permissions'):t('让网页中的经验也靠岸','Bring your web history here')}</span></div><ArrowRight size={14}/></button>

    </aside>
    <main className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="icon-button sidebar-toggle" onClick={()=>setCollapsed(!collapsed)} aria-label={t('切换侧边栏','Toggle sidebar')}><PanelLeftClose size={18}/></button></div><div className="topbar-actions"><button className="global-search" onClick={findSkills}><Search size={14}/><span>{t('搜索技能','Search skills')}</span><kbd>{navigator.platform.includes('Mac')?'⌘ K':'Ctrl K'}</kbd></button><LanguageSwitch/><button className="icon-button" onClick={()=>act('getState')} aria-label={t('刷新状态','Refresh status')}><RefreshCw size={15} className={pending.has('getState')?'spin':''}/></button></div></header>
      {state.demo&&<div className="demo-banner"><span className="demo-label">{t('示例模式','DEMO')}</span><span>{t('独立的示例工作空间，与个人历史分开保存。','A separate sample workspace. Your personal history stays separate.')}</span><button onClick={async()=>{if(!navigationGuard.current||await navigationGuard.current())await act('exitDemo');}} disabled={state.run?.status==='running'}>{t('返回我的工作空间','Return to my workspace')}<ArrowRight size={13}/></button></div>}
      <div className="page-content" key={state.demo?'demo':'personal'}>{page==='collect'?<CollectView onLibrary={()=>{void navigate('library');}} onSetup={openSetup} onSettings={()=>{void navigate('settings');}} onRunStarted={setAutoOpenRun}/>:page==='library'?<LibraryView onCollect={()=>{void navigate('collect');}}/>:page==='history'?<HistoryView onCollect={()=>{void navigate('collect');}}/>:<SettingsView onSetup={openSetup}/>}</div>
    </main>
    {toast&&<div className={`toast ${toast.error?'error':''}`} role={toast.error?'alert':'status'}>{toast.error?<CircleAlert size={18}/>:<Check size={18}/>}<span>{toast.text}</span><button className="icon-button" aria-label={t('关闭通知','Dismiss notification')} onClick={()=>setToast(null)}><X size={16}/></button></div>}
    {confirmation&&<Modal title={confirmation.title} onClose={()=>resolveConfirmation(false)}><p className="confirmation-detail">{confirmation.detail}</p><div className="modal-actions"><button className="button secondary" onClick={()=>resolveConfirmation(false)}>{confirmation.labels?.cancel||t('取消','Cancel')}</button><button className={`button ${confirmation.destructive?'danger':'primary'}`} onClick={()=>resolveConfirmation(true)}>{confirmation.labels?.confirm||(confirmation.destructive?t('确认删除','Delete'):t('确认','Confirm'))}</button></div></Modal>}
    {setup&&<Modal title={t('连接浏览器，收集网页历史','Connect your browser')} onClose={()=>setSetup(false)}><div className="setup-intro"><span className="setup-graphic"><Wifi size={29}/></span><div><h3>{t('首次连接，只需要做一次','One-time setup')}</h3><p>{t('扩展只读取你勾选的网站，无需提供密码或 Cookie。','The extension reads only selected websites. No passwords or cookies are requested.')}</p></div></div><ol className="setup-steps"><li><span>1</span><div><strong>{t('在 Chrome 或 Edge 中加载扩展','Load the extension in Chrome or Edge')}</strong><p>{t('打开扩展管理页，开启「开发者模式」，选择「加载已解压的扩展程序」。','Open the extensions page, enable Developer mode, and select Load unpacked.')}</p><div className="button-group"><button className="button secondary small-button" onClick={()=>act('openExtension')}><FolderOpen size={15}/>{t('打开扩展文件夹','Open extension folder')}</button><code>chrome://extensions</code></div></div></li><li><span>2</span><div><strong>{t('打开扩展，输入本次配对码','Open the extension and enter this pairing code')}</strong>{state.bridge.paired?<div className="paired-success"><Check size={17}/>{t('浏览器已连接','Browser connected')}</div>:<div className="pairing-code"><code>{state.bridge.pairingCode||'— — — — — —'}</code><button className="icon-button" disabled={!state.bridge.pairingCode} onClick={()=>{if(state.bridge.pairingCode)void navigator.clipboard.writeText(state.bridge.pairingCode).then(()=>setToast({text:t('配对码已复制。','Pairing code copied.'),error:false})).catch(()=>setToast({text:t('无法复制，请手动输入配对码。','Could not copy. Please enter the code manually.'),error:true}));}} aria-label={t('复制配对码','Copy pairing code')}><Copy size={17}/></button></div>}{!state.bridge.paired&&<div className="button-group"><button className="text-button" disabled={pending.has('rotatePairingCode')} onClick={()=>act('rotatePairingCode',{},t('配对码已更新。','Pairing code renewed.'))}><RefreshCw size={13}/>{t('刷新配对码','Renew pairing code')}</button><span className="small muted">{t('配对码有效期为 10 分钟。','Pairing codes expire after 10 minutes.')}</span></div>}<p>{t('配对只连接到此设备，不会上传你的聊天记录。','Pairing connects only to this device. It does not upload conversations.')}</p></div></li><li><span>3</span><div><strong>{t('在来源网站完成登录，然后开始采集','Sign in on your source websites, then start collecting')}</strong><p>{t('回到应用，勾选来源，点击「收集历史并生成 Skills」。','Return here, select sources, and click Collect History & Generate Skills.')}</p></div></li></ol><details className="advanced-settings"><summary>{t('连接详情','Connection details')}</summary><p className="small muted">{t('本机连接地址','Local connection address')}: <code>http://127.0.0.1:{state.bridge.port}</code></p><p className="small muted">{t('仅使用页面已登录状态；网站改版可能影响读取范围，失败项会逐条报告。','Uses your signed-in website context. Website changes can affect coverage; failures are reported per source.')}</p></details><div className="modal-actions"><button className="button primary" onClick={()=>setSetup(false)}>{t('返回工作台','Back to workspace')}<ArrowRight size={15}/></button></div></Modal>}
  </div></AppContext.Provider>;
}
