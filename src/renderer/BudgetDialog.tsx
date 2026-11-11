import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useApp } from './context';
import { Modal } from './components';

export function BudgetDialog({onClose,onSaved}:{onClose:()=>void;onSaved?:(calls:number)=>void}){
  const {state,t,act,pending}=useApp();
  const usedCalls=state.run?.modelCalls||0;
  const defaultCalls=state.settings.maxModelCalls>0&&usedCalls>=state.settings.maxModelCalls?Math.max(25,usedCalls+12):state.settings.maxModelCalls;
  const [calls,setCalls]=useState(defaultCalls);const [chars,setChars]=useState(state.settings.maxInputChars);
  const valid=Number.isInteger(calls)&&calls>=0&&calls<=1000&&Number.isInteger(chars)&&chars>=1000&&chars<=20000000;
  return <Modal title={t('这次用多少，由你决定','Set a budget you are comfortable with')} onClose={onClose}><p className="budget-explanation">{t('全部历史先在本机整理，只将选出的代表材料交给生成服务。以下上限覆盖本轮的生成、失败请求与继续处理。','All history is prepared locally. Only selected representatives go to generation. These caps cover generation, failed requests and resuming the same workflow.')}</p><div className="form-grid"><label className="field"><span>{t('最多调用次数','Maximum model calls')}</span><input aria-label={t('最多调用次数','Maximum model calls')} type="number" min="0" max="1000" value={calls} onChange={e=>setCalls(Number(e.target.value))}/><small>{t('设为 0：只在本机整理，保留待生成材料。','Set to 0 to prepare locally and retain materials for later.')}</small></label><label className="field"><span>{t('累计输入字符上限','Total input character limit')}</span><input aria-label={t('累计输入字符上限','Total input character limit')} type="number" min="1000" max="20000000" step="1000" value={chars} onChange={e=>setChars(Number(e.target.value))}/><small>{t('含指令和请求封装，不等于服务商的 tokens 或费用。','Includes instructions and packaging; not a token or currency estimate.')}</small></label></div><p className="info-box"><ShieldCheck size={18}/>{t('达到上限自动保留进度，不会为了补取、重试而越过预算。未完成部分会明确列出。','Reaching a cap saves progress. Follow-ups and retries cannot exceed the budget. Unfinished work is listed.')}</p><div className="modal-actions"><button className="button secondary" onClick={onClose}>{t('取消','Cancel')}</button><button className="button primary" disabled={!valid||pending.has('saveSettings')||state.run?.status==='running'} onClick={async()=>{const effectiveCalls=calls>0&&usedCalls>=calls?usedCalls+calls:calls;if(await act('saveSettings',{maxModelCalls:effectiveCalls,maxInputChars:chars})){onClose();onSaved?.(effectiveCalls);}}}>{t('保存预算','Save budget')}</button></div></Modal>;
}
