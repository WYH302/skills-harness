import { useMemo } from 'react';
import { diffLines } from 'diff';
import { useApp } from './context';

export function RevisionDiff({before,after}:{before:string;after:string}) {
  const {t}=useApp();
  const changes=useMemo(()=>diffLines(before,after,{stripTrailingCr:true,timeout:80,maxEditLength:4000}),[before,after]);
  const added=changes?.filter(change=>change.added).reduce((sum,change)=>sum+change.count,0)||0;
  const removed=changes?.filter(change=>change.removed).reduce((sum,change)=>sum+change.count,0)||0;
  return <div className="revision-review">
    <p className="revision-explanation">{t('红色内容将被删除，绿色内容将加入。采用建议会替换当前全文；原版本可在版本记录中恢复。','Red content will be removed; green content will be added. Accepting replaces the current text. The prior version remains recoverable.')}</p>
    {changes?<><div className="diff-summary"><span className="diff-added">+ {added} {t('行新增','lines added')}</span><span className="diff-removed">− {removed} {t('行删除','lines removed')}</span></div><div className="revision-diff" role="region" aria-label={t('修订差异','Revision changes')} tabIndex={0}>
      {changes.map((change,index)=>!change.added&&!change.removed&&change.count>10?<details className="diff-unchanged" key={index}><summary>{t(`${change.count} 行保持不变`,`${change.count} unchanged lines`)}</summary><pre>{change.value}</pre></details>:<pre className={change.added?'diff-line added':change.removed?'diff-line removed':'diff-line'} key={index}><span className="diff-marker" aria-hidden="true">{change.added?'+':change.removed?'−':' '}</span><span>{change.value}</span></pre>)}
    </div></>:<p className="info-box">{t('差异较多，请展开下方全文进行比较。','Large change: expand the full texts below to compare.')}</p>}
    <details className="revision-full-text"><summary>{t('查看两版全文','View both full versions')}</summary><div className="revision-comparison"><div><h3>{t('当前内容','Current content')}</h3><pre>{before}</pre></div><div><h3>{t('建议内容','Proposed content')}</h3><pre>{after}</pre></div></div></details>
  </div>;
}
