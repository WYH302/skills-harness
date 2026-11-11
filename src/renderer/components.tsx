import { useLayoutEffect, useId, useRef, type ReactNode } from 'react';
import { Check, CheckCircle2, Circle, LoaderCircle, X } from 'lucide-react';
import type { SourceId, SkillState } from '../shared/types';
import { useApp } from './context';
import { PRODUCTS, product } from '../shared/catalog';

export function HarborMark({small=false}: {small?:boolean}) {
  return <svg width={small?28:34} height={small?28:34} viewBox="0 0 40 40" fill="none" aria-hidden="true"><rect x=".5" y=".5" width="39" height="39" rx="9.5" fill="#09090B" stroke="#27272A"/><path d="M12.5 12v16m15-16v16M12.5 20h15" stroke="#FAFAFA" strokeWidth="2.4" strokeLinecap="round"/><path d="m17.5 14.5 5 11" stroke="#A1A1AA" strokeWidth="2.2" strokeLinecap="round"/><circle cx="28.5" cy="11.5" r="2.5" fill="#6366F1"/></svg>;
}
const platformColors=Object.fromEntries(PRODUCTS.map(p=>[p.id,p.color])) as Record<SourceId,string>;
export function PlatformIcon({source,small=false}:{source:SourceId;small?:boolean}) {
  const glyphs:Partial<Record<SourceId,ReactNode>>={
    chatgpt:<>{Array.from({length:6},(_,i)=><path key={i} d="M12 3.5c-4-2-7 2-5.5 5l8.5 5v-6L12 5.7" transform={`rotate(${i*60} 12 12)`} stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/>)}</>,
    claude:<>{Array.from({length:12},(_,i)=><path key={i} d="M12 3v5.7" transform={`rotate(${i*30} 12 12)`} stroke="currentColor" strokeWidth={i%3===0?'1.9':'1.45'} strokeLinecap="round"/>)}</>,
    gemini:<path d="M12 1.8C10.8 8.9 8.9 10.8 1.8 12c7.1 1.2 9 3.1 10.2 10.2 1.2-7.1 3.1-9 10.2-10.2-7.1-1.2-9-3.1-10.2-10.2Z" fill="currentColor"/>,
    deepseek:<><path d="M3 10c3.5-2 6 1 9 0 2.5-1 4-4 7-3-.8 1.7-.8 3.1.3 4.7-1.4 6-8.2 8.6-12.9 5.1C4.5 15.4 3.1 13.1 3 10Z" fill="currentColor"/><path d="m17.8 8.5 4-3.3-.8 6.2-3.2-2.9Z" fill="currentColor"/><circle cx="8.5" cy="12.1" r=".9" fill="white"/></>,
    grok:<><path d="m5 18 14-14M10 6a7.7 7.7 0 1 0 8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/><path d="m11 13 4 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></>,
    perplexity:<><path d="M12 3v18M5 5l14 14V9H5v10L19 5H5Zm0 14 7-7 7 7M5 9l7 3 7-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></>,
    codex:<><path d="m5 7 5 5-5 5m8 0h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></>,
    'claude-code':<><path d="m4 8 4 4-4 4m12-8-4 4 4 4m2 2h3" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"/></>,
    antigravity:<><path d="M12 3.2 4.5 18.8h3.4l1.6-3.5h5l1.6 3.5h3.4L12 3.2Zm-1.4 9.2L12 9.1l1.4 3.3h-2.8Z" fill="currentColor"/><circle cx="12" cy="19.8" r="1.3" fill="currentColor"/></>,
    'gemini-cli':<><path d="M9.5 4.5c-.8 4.6-2 5.8-6.5 6.5 4.5.7 5.7 1.9 6.5 6.5.8-4.6 2-5.8 6.5-6.5-4.5-.7-5.7-1.9-6.5-6.5Z" fill="currentColor"/><path d="M15 17.5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></>,
    openclaw:<><path d="M6.5 17.5c-1.8-2.8-1.4-6.8 1.2-9.4 2.2-2.2 5.6-2.7 8.3-1.2-2.4.6-4.3 2.4-4.8 4.8-.6 2.7.7 5.2 3.1 6.3-2.7 1.2-5.9.9-7.8-.5Z" fill="currentColor"/><path d="m14.5 9.5 4-2.5m-3 5.5 4.5-.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></>,
    hermes:<><path d="M5 18V6l4.5 4.5L14 6v12M14 12h5m0 0-2.2-2.2M19 12l-2.2 2.2" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"/></>,
    'deepseek-harness':<><path d="M3 10c3.5-2 6 1 9 0 2.5-1 4-4 7-3-.8 1.7-.8 3.1.3 4.7-1.4 6-8.2 8.6-12.9 5.1C4.5 15.4 3.1 13.1 3 10Z" fill="currentColor"/><path d="M15 18h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></>,
    cursor:<><path d="m5 3 14 6-6 3-3 9L5 3Z" fill="currentColor"/><path d="m5 3 8 9m0 0 6 6" stroke="white" strokeWidth="1.1" strokeLinecap="round"/></>,
    opencode:<><path d="M5 5h14v14H5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="m8 10 2 2-2 2m5 0h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></>
  };
  return <span className={`platform-icon platform-${source} ${small?'small':''}`} style={{'--platform-color':platformColors[source]} as React.CSSProperties} aria-hidden="true"><svg width="23" height="23" viewBox="0 0 24 24" fill="none">{glyphs[source]||<text x="12" y="17" textAnchor="middle" fill="currentColor" fontSize={product(source).glyph.length>1?12:17} fontWeight="650">{product(source).glyph}</text>}</svg></span>;
}
export function StateBadge({state}:{state:SkillState}) {
  const {t}=useApp();
  const text:Record<SkillState,string>={candidate:t('待确认','Candidate'),active:t('已启用','Active'),dormant:t('休眠','Dormant'),archived:t('已归档','Archived')};
  return <span className={`badge state-${state}`}><span className="badge-dot"/>{text[state]}</span>;
}
export function LanguageSwitch(){const {state,t,act}=useApp();return <button className="language-button" onClick={()=>act('setLanguage',{language:state.settings.language==='zh'?'en':'zh'})} aria-label={t('切换到 English','Switch to 简体中文')}><span className={state.settings.language==='zh'?'selected-language':''}>简体中文</span><i aria-hidden="true">|</i><span className={state.settings.language==='en'?'selected-language':''}>English</span></button>;}
export function Modal({title,children,onClose,wide=false}:{title:string;children:ReactNode;onClose:()=>void;wide?:boolean}) {
  const {t}=useApp();
  const id=useId(); const ref=useRef<HTMLDivElement>(null); const closeRef=useRef(onClose); closeRef.current=onClose;
  useLayoutEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const first=ref.current?.querySelector<HTMLElement>('button, input, textarea, select, [tabindex="0"]'); first?.focus();
    const key=(event:KeyboardEvent)=>{
      const dialogs=document.querySelectorAll('[role="dialog"]');
      if(dialogs[dialogs.length-1]!==ref.current)return;
      if(event.key==='Escape'){event.preventDefault();closeRef.current();}
      if(event.key==='Tab'){
        const nodes=ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]');
        if(!nodes?.length)return;
        const first=nodes[0],last=nodes[nodes.length-1];
        if(event.shiftKey && document.activeElement===first){event.preventDefault();last.focus();}
        else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
      }
    };
    document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);previous?.focus();};
  },[]);
  return <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}><div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} className={`modal ${wide?'wide':''}`}><header className="modal-header"><h2 id={id}>{title}</h2><LanguageSwitch/><button className="icon-button" onClick={onClose} aria-label={t('关闭','Close')}><X size={20}/></button></header><div className="modal-body">{children}</div></div></div>;
}
export function Empty({icon,title,detail,children}:{icon:ReactNode;title:string;detail:string;children?:ReactNode}) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><h3>{title}</h3><p>{detail}</p>{children}</div>;
}
export function StatusGlyph({status}:{status:string}) {
  return status==='running'?<LoaderCircle className="spin" size={16}/>:status==='done'||status==='completed'?<CheckCircle2 size={16}/>:status==='error'||status==='failed'?<X size={16}/>:<Circle size={16}/>;
}
export function Checkbox({checked,onChange,label,disabled=false}:{checked:boolean;onChange:(checked:boolean)=>void;label:string;disabled?:boolean}) {
  return <label className={`check-label ${disabled?'disabled':''}`}><input type="checkbox" checked={checked} onChange={event=>onChange(event.target.checked)} disabled={disabled}/><span className="check-visual" aria-hidden="true">{checked&&<Check size={13}/>}</span><span>{label}</span></label>;
}
