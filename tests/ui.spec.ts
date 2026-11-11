import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { demoConversations } from '../src/core/demo-data';
import { fixtureModel } from './fixture-model';
import { Store } from '../src/core/store';

test('pending procedure organization remains resumable and retains usage across language changes',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'skillharbor-organization-ui-'));const data=path.join(directory,'data');const model=await fixtureModel();const store=new Store(data);
  store.saveSettings({language:'en',analysisMode:'local',model:'deterministic-ui-fixture',endpoint:model.endpoint,maxModelCalls:1});
  store.saveRun({id:'public-pending-organization',outputLanguage:'source',status:'completed',stage:'done',startedAt:'2026-10-29T00:00:00Z',sources:['chatgpt','claude'],sourceProgress:{},episodes:2,skills:0,modelCalls:1,inputChars:1234,cached:2,warnings:[],collectionComplete:true,pendingAnalysis:0,budget:{maxCalls:1,maxChars:120000},organization:{episodes:2,batches:1,completed:0,cached:0,pending:1,mergedGroups:0,plannedCalls:1,plannedInputChars:5678,bounded:false}});store.close();
  const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string')),SKILLHARBOR_DATA_DIR:data,SKILLHARBOR_TEST:'1',SKILLHARBOR_TEST_HOME:path.join(directory,'home')};delete env.ELECTRON_RUN_AS_NODE;delete env.SKILLHARBOR_DEMO;let app:ElectronApplication|undefined;
  try{
    app=await electron.launch({args:[process.cwd()],env});const page=await app.firstWindow();
    await expect(page.getByRole('button',{name:'Continue generation',exact:true})).toBeEnabled();
    await page.locator('.topbar').getByRole('button',{name:'Switch to 简体中文',exact:true}).click();
    await expect(page.getByRole('button',{name:'继续生成',exact:true})).toBeEnabled();
    const state=await page.evaluate(()=>window.skillharbor.request<import('../src/shared/types').AppState>('getState'));
    expect(state.run!.id).toBe('public-pending-organization');expect(state.run!.organization!.pending).toBe(1);expect(state.run!.modelCalls).toBe(1);expect(state.run!.inputChars).toBe(1234);expect(state.run!.outputLanguage).toBe('source');expect(model.calls()).toBe(0);
    await page.getByRole('button',{name:'继续生成',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('dialog')).toContainText('预算');expect(model.calls()).toBe(0);
    await page.screenshot({path:'test-results/organization-budget.png'});
  }finally{await app?.close();await model.close();await rm(directory,{recursive:true,force:true});}
});

test('mainstream brands, bilingual source search, region preservation and language changes during generation',async()=>{
  test.setTimeout(70000);const directory=await mkdtemp(path.join(tmpdir(),'skillharbor-mainstream-')),home=path.join(directory,'user'),sessions=path.join(home,'.codex','sessions');await mkdir(sessions,{recursive:true});
  const c=demoConversations()[0];await writeFile(path.join(sessions,'public.jsonl'),[{type:'session_meta',payload:{id:'bilingual-public',cwd:directory}},...c.messages.map(m=>({type:'response_item',payload:{type:'message',role:m.role,id:m.id,content:[{type:m.role==='user'?'input_text':'output_text',text:m.text}]}}))].map(r=>JSON.stringify(r)).join('\n'));
  const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string')),SKILLHARBOR_DATA_DIR:path.join(directory,'data'),SKILLHARBOR_TEST:'1',SKILLHARBOR_TEST_HOME:home};delete env.ELECTRON_RUN_AS_NODE;delete env.SKILLHARBOR_DEMO;
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);const model=await fixtureModel({beforeReply:()=>gate,english:true});let app:ElectronApplication|undefined;
  try{
    app=await electron.launch({args:[process.cwd()],env});let page=await app.firstWindow();await expect(page.getByRole('heading',{name:'Codex',exact:true})).toBeVisible();await page.setViewportSize({width:1440,height:900});await page.screenshot({path:'test-results/mainstream-home-zh-1440.png'});
    await page.getByRole('button',{name:'管理来源',exact:true}).click();let dialog=page.getByRole('dialog');await dialog.getByRole('tab',{name:'全部',exact:true}).click();await expect(dialog.locator('.source-card')).toHaveCount(22);await expect(dialog.getByRole('checkbox',{name:'DeepSeek',exact:true})).toHaveCount(1);
    await dialog.getByRole('tab',{name:'开发工具',exact:true}).click();await expect(dialog.getByRole('checkbox',{name:'GitHub Copilot',exact:true})).toBeVisible();await expect(dialog.getByRole('checkbox',{name:'Microsoft Copilot',exact:true})).toHaveCount(0);
    await dialog.getByRole('tab',{name:'中文常用',exact:true}).click();await dialog.getByLabel('搜索历史来源',{exact:true}).fill('doubao');await dialog.getByRole('checkbox',{name:'豆包',exact:true}).check();await expect(dialog.locator('.source-state')).toContainText('仅文件导入');
    await dialog.getByRole('button',{name:'切换到 English',exact:true}).click();await expect(dialog.getByRole('heading',{name:'Manage history sources'})).toBeVisible();await expect(dialog.getByLabel('Search history sources',{exact:true})).toHaveValue('doubao');await expect(dialog.getByRole('tab',{name:'Popular in Chinese'})).toHaveAttribute('aria-selected','true');await expect(dialog.getByRole('checkbox',{name:'Doubao',exact:true})).toBeChecked();await page.screenshot({path:'test-results/mainstream-sources-en.png'});await dialog.getByRole('checkbox',{name:'Doubao',exact:true}).uncheck();await dialog.getByRole('button',{name:'Use these sources',exact:true}).click();
    await page.getByRole('button',{name:'Change assistant',exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.locator('.assistant-brand')).toHaveCount(10);await expect(dialog.locator('.assistant-brand[data-brand=chatgpt]')).toHaveCount(1);await page.screenshot({path:'test-results/mainstream-assistants-en.png'});
    await dialog.locator('.assistant-brand[data-brand=chatgpt]').click();await expect(dialog.getByRole('button',{name:'Continue with ChatGPT',exact:true})).toBeVisible();await dialog.getByRole('button',{name:'Back to assistants',exact:true}).click();await dialog.locator('.assistant-brand[data-brand=qwen]').click();await dialog.getByRole('button',{name:'Connect API',exact:true}).click();await dialog.getByLabel('API provider',{exact:true}).selectOption('qwen-intl');await dialog.getByLabel('API Key',{exact:true}).fill('fixture-unsaved-key');await dialog.getByRole('button',{name:'Switch to 简体中文',exact:true}).click();await expect(dialog.getByLabel('API 服务商',{exact:true})).toHaveValue('qwen-intl');await expect(dialog.getByLabel('API 服务地址',{exact:true})).toHaveValue('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');await expect(dialog.getByLabel('API Key',{exact:true})).toHaveValue('fixture-unsaved-key');await page.keyboard.press('Escape');expect(model.calls()).toBe(0);
    await page.evaluate(endpoint=>window.skillharbor.request('saveSettings',{analysisMode:'local',endpoint,model:'deterministic-ui-fixture',skillOutputLanguage:'en'}),model.endpoint);await expect(page.getByRole('heading',{name:'自定义模型',exact:true})).toBeVisible();await page.getByRole('button',{name:'生成我的 Skills',exact:true}).click();await expect.poll(()=>model.calls()).toBe(1);let state=await page.evaluate(()=>window.skillharbor.request<import('../src/shared/types').AppState>('getState'));const runId=state.run!.id;expect(state.run!.outputLanguage).toBe('en');
    await page.locator('.topbar').getByRole('button',{name:'切换到 English',exact:true}).click();await expect(page.getByRole('button',{name:'Pause and save',exact:true})).toBeVisible();state=await page.evaluate(()=>window.skillharbor.request<import('../src/shared/types').AppState>('getState'));expect(state.run!.id).toBe(runId);expect(state.run!.outputLanguage).toBe('en');expect(state.run!.modelCalls).toBe(1);release();await expect(page.getByRole('heading',{name:/^Your skill library/})).toBeVisible();
    state=await page.evaluate(()=>window.skillharbor.request<import('../src/shared/types').AppState>('getState'));expect(state.skills).toHaveLength(1);const markdown=state.skills[0].markdown;expect(markdown).toContain('## Procedure');expect(markdown).not.toMatch(/[\p{Script=Han}]/u);await page.getByLabel('Search skills',{exact:true}).fill('Evaluate');await page.locator('.topbar').getByRole('button',{name:'Switch to 简体中文',exact:true}).click();await expect(page.getByLabel('搜索技能',{exact:true})).toHaveValue('Evaluate');expect(model.calls()).toBe(1);state=await page.evaluate(()=>window.skillharbor.request<import('../src/shared/types').AppState>('getState'));expect(state.skills[0].markdown).toBe(markdown);
    await app.close();app=undefined;app=await electron.launch({args:[process.cwd()],env});page=await app.firstWindow();await expect(page.getByRole('button',{name:'更新我的 Skills',exact:true})).toBeEnabled();await page.getByRole('button',{name:'更新我的 Skills',exact:true}).click();await expect.poll(async()=>{state=await page.evaluate(()=>window.skillharbor.request<import('../src/shared/types').AppState>('getState'));return state.run?.status==='completed'&&state.run.modelCalls===0;}).toBe(true);expect(model.calls()).toBe(1);expect(state.run!.outputLanguage).toBe('en');await page.locator('.topbar').getByRole('button',{name:'切换到 English',exact:true}).click();await page.setViewportSize({width:430,height:850});const b=await page.getByRole('button',{name:'Update my Skills',exact:true}).boundingBox();expect(b!.y+b!.height).toBeLessThanOrEqual(850);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'test-results/mainstream-home-en-430.png'});
  }finally{release();await app?.close();await model.close();}
});

test('focused homepage, model-required generation, restart and unchanged cache',async()=>{
  test.setTimeout(60000);const directory=await mkdtemp(path.join(tmpdir(),'skillharbor-focus-'));const home=path.join(directory,'user');const sessions=path.join(home,'.codex','sessions');await mkdir(sessions,{recursive:true});
  const c=demoConversations()[0];await writeFile(path.join(sessions,'fixture.jsonl'),[{type:'session_meta',payload:{id:'focus-fixture',cwd:path.join(directory,'project')}},...c.messages.map(m=>({type:'response_item',payload:{type:'message',role:m.role,id:m.id,content:[{type:m.role==='user'?'input_text':'output_text',text:m.text}]}}))].map(r=>JSON.stringify(r)).join('\n'));
  const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string')),SKILLHARBOR_DATA_DIR:path.join(directory,'data'),SKILLHARBOR_TEST:'1',SKILLHARBOR_TEST_HOME:home};delete env.ELECTRON_RUN_AS_NODE;delete env.SKILLHARBOR_DEMO;
  const model=await fixtureModel();let app:ElectronApplication|undefined;
  try{
    app=await electron.launch({args:[process.cwd()],env,timeout:30000});let page=await app.firstWindow();await expect(page.getByRole('heading',{name:'Codex',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'选择你的 AI'})).toBeVisible();
    for(const [width,height] of [[1440,900],[1280,720],[900,680],[430,850]]){await page.setViewportSize({width,height});const b=await page.getByRole('button',{name:'生成我的 Skills',exact:true}).boundingBox();expect(b).not.toBeNull();expect(b!.y+b!.height).toBeLessThanOrEqual(height);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);}
    await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:'test-results/focus-home-1440.png'});
    await page.getByRole('button',{name:'生成我的 Skills',exact:true}).click();await expect(page.getByRole('heading',{name:'选择生成助手'})).toBeVisible();await expect(page.getByRole('tab',{name:'主流助手',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.locator('.assistant-brand[data-brand=chatgpt]')).toHaveCount(1);await page.locator('.assistant-brand[data-brand=chatgpt]').click();await expect(page.getByRole('button',{name:'Continue with ChatGPT',exact:true})).toBeVisible();await expect(page.getByLabel('API Key',{exact:true})).toHaveCount(0);await expect(page.getByText('本机规则提取（明确步骤）',{exact:true})).toHaveCount(0);await page.screenshot({path:'test-results/focus-membership-picker.png'});
    await page.getByRole('tab',{name:'本机模型',exact:true}).click();await expect(page.getByRole('heading',{name:'还没有发现运行中的大模型'})).toBeVisible();await page.getByRole('tab',{name:'API 接入',exact:true}).click();await expect(page.getByLabel('API Key',{exact:true})).toBeVisible();await page.keyboard.press('Escape');
    await page.evaluate(endpoint=>window.skillharbor.request('saveSettings',{analysisMode:'local',endpoint,model:'deterministic-ui-fixture'}),model.endpoint);await expect(page.getByRole('heading',{name:'自定义模型',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'生成我的 Skills',exact:true}).click();await expect(page.getByRole('heading',{name:/^你的技能库/})).toBeVisible();let state=await page.evaluate(()=>window.skillharbor.request<import('../src/shared/types').AppState>('getState'));expect(state.stats.skills).toBe(1);expect(state.run?.modelCalls).toBe(1);expect(model.calls()).toBe(1);
    await app.close();app=undefined;app=await electron.launch({args:[process.cwd()],env,timeout:30000});page=await app.firstWindow();await expect(page.getByRole('heading',{name:'Codex',exact:true})).toBeVisible();await page.getByRole('button',{name:'更新我的 Skills',exact:true}).click();await expect.poll(async()=>{state=await page.evaluate(()=>window.skillharbor.request<import('../src/shared/types').AppState>('getState'));return state.run?.status==='completed'&&state.run.modelCalls===0;}).toBe(true);await expect(page.getByRole('button',{name:'管理来源',exact:true})).toBeEnabled();expect(state.run?.modelCalls).toBe(0);expect(model.calls()).toBe(1);expect(state.run?.skills).toBe(0);
    await page.getByRole('button',{name:'管理来源',exact:true}).click();await page.getByRole('checkbox',{name:'ChatGPT',exact:true}).check();await page.getByRole('button',{name:'使用这些来源',exact:true}).click();await expect(page.locator('.focus-coverage')).toContainText('1 个未连接来源');await page.setViewportSize({width:430,height:850});await page.screenshot({path:'test-results/focus-home-430.png'});
  }finally{await app?.close();await model.close();}
});

test('production import without a generator saves evidence but cannot generate rule-based Skills',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'skillharbor-no-ai-'));const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string')),SKILLHARBOR_DATA_DIR:directory,SKILLHARBOR_TEST:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.SKILLHARBOR_DEMO;let app:ElectronApplication|undefined;
  try{app=await electron.launch({args:[process.cwd()],env});const page=await app.firstWindow();const file=path.join(process.cwd(),'examples','histories.json');await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.evaluate(()=>window.skillharbor.request('import'));await expect.poll(async()=>{const state=await page.evaluate(()=>window.skillharbor.request<import('../src/shared/types').AppState>('getState'));return state.run?.status;}).toBe('completed');const state=await page.evaluate(()=>window.skillharbor.request<import('../src/shared/types').AppState>('getState'));expect(state.stats.conversations).toBe(8);expect(state.stats.skills).toBe(0);expect(state.run?.modelCalls).toBe(0);expect(state.run?.pendingAnalysis).toBeGreaterThan(0);}finally{await app?.close();}
});
test('desktop demo, evidence, editing, rollback, lifecycle, bilingual settings, and responsive layout',async()=>{
  test.setTimeout(150_000);
  const temp=await mkdtemp(path.join(tmpdir(),'skillharbor-ui-'));
  const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
  Object.assign(env,{SKILLHARBOR_DATA_DIR:temp,SKILLHARBOR_TEST:'1',SKILLHARBOR_DEMO:'1'});
  delete env.ELECTRON_RUN_AS_NODE;
  const fixture=await fixtureModel();
  let app:ElectronApplication|undefined;
  try{
    app=await electron.launch({args:['.'],cwd:process.cwd(),env,timeout:60_000});
    const page=await app.firstWindow();await page.setViewportSize({width:1440,height:1080});
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await expect(page.getByRole('heading',{name:'把经验，变成你的 Skills。'})).toBeVisible({timeout:30_000});
    await page.getByRole('button',{name:'管理来源',exact:true}).click();await expect(page.locator('.source-card')).toHaveCount(22);await page.getByRole('button',{name:'使用这些来源',exact:true}).click();
    let state=await page.evaluate(()=>window.skillharbor.request<{demo:boolean}>('getState'));
    if(!state.demo)await page.getByRole('button',{name:'先看看技能样例'}).click();
    await expect.poll(async()=>{const state=await page.evaluate(()=>window.skillharbor.request<{demo:boolean;run:{status:string}|null;stats:{skills:number}}>('getState'));return state.demo&&state.run?.status==='completed'&&state.stats.skills===3;},{timeout:60_000}).toBe(true);await page.waitForTimeout(200);
    await expect(page.locator('.demo-banner')).toContainText('独立的示例工作空间');
    await page.evaluate(()=>document.fonts.ready);
    await page.screenshot({path:'test-results/skillharbor-collect.png',fullPage:true});
    await page.getByRole('navigation').getByRole('button',{name:/技能库/}).click();
    await expect(page.locator('.skill-card').first()).toBeVisible();
    expect(await page.locator('.skill-card').count()).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Control+k');await expect(page.getByLabel('搜索技能',{exact:true})).toBeFocused();
    await page.getByRole('button',{name:'列表视图'}).click();await expect(page.locator('.skill-list-layout')).toBeVisible();
    await page.getByRole('button',{name:'卡片视图'}).click();
    await page.screenshot({path:'test-results/skillharbor-library.png',fullPage:true});
    await page.locator('.skill-card').first().click();
    const skillDialog=page.getByRole('dialog').first();
    await skillDialog.getByRole('button',{name:/来源依据/}).click();
    await skillDialog.locator('.evidence-row').first().click();
    await expect(page.getByRole('heading',{name:'任务与原始依据'})).toBeVisible();
    await expect(page.locator('.evidence-quote').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await skillDialog.getByRole('button',{name:'编辑',exact:true}).click();
    const editor=page.getByLabel('编辑 SKILL.md');
    const original=await editor.inputValue();
    await editor.fill(original+'\n\n## 使用备注\n保留输入中的验收要求。\n');
    await skillDialog.getByRole('button',{name:'保存修改'}).click();
    await expect(page.locator('.markdown-preview')).toContainText('保留输入中的验收要求。');
    await skillDialog.getByRole('button',{name:'版本',exact:true}).click();
    await expect(skillDialog.locator('.version-row')).toHaveCount(2);
    await skillDialog.getByRole('button',{name:'恢复',exact:true}).first().click();
    await page.getByRole('dialog').last().getByRole('button',{name:'确认',exact:true}).click();
    await skillDialog.getByRole('button',{name:'技能内容',exact:true}).click();
    await expect(page.locator('.markdown-preview')).not.toContainText('保留输入中的验收要求。');
    await skillDialog.getByLabel('调整技能状态').selectOption('archived');
    await expect(skillDialog.locator('.badge')).toContainText('已归档');
    await skillDialog.getByLabel('调整技能状态').selectOption('active');
    await expect(skillDialog.locator('.badge')).toContainText('已启用');
    await page.keyboard.press('Escape');
    await page.getByRole('navigation').getByRole('button',{name:'历史与依据'}).click();
    await expect(page.locator('.history-row').first()).toBeVisible();
    await page.locator('.history-row').first().click();
    await expect(page.locator('.transcript-message').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('navigation').getByRole('button',{name:'设置与隐私'}).click();
    await page.getByRole('button',{name:'English',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Settings & privacy'})).toBeVisible();
    await expect(page.locator('.settings-save-bar')).toHaveCount(0);
    await page.getByRole('button',{name:'简体中文',exact:true}).click();
    await page.getByText('高级 API 与处理设置',{exact:true}).click();
    await page.locator('.model-option').filter({hasText:'远程模型'}).click();
    await expect(page.getByText('发送前，请确认你理解传输范围',{exact:true})).toBeVisible();
    await expect(page.getByRole('checkbox',{name:'我同意将分析所需的历史片段发送给所选服务。'})).not.toBeChecked();
    // No remote settings are saved and no model request is made during this test.
    await page.getByRole('button',{name:'English',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Settings & privacy'})).toBeVisible();
    await page.getByRole('button',{name:'简体中文',exact:true}).click();
    await page.getByRole('navigation').getByRole('button',{name:'采集与生成'}).click();
    await expect(page.getByRole('heading',{name:'离开前，保留这些设置？'})).toBeVisible();
    await page.getByRole('button',{name:'继续编辑',exact:true}).click();
    await expect(page.getByRole('radio',{name:/远程模型/})).toBeChecked();
    await page.getByRole('navigation').getByRole('button',{name:'采集与生成'}).click();
    await page.getByRole('button',{name:'放弃修改并离开',exact:true}).click();
    await page.getByRole('button',{name:'管理来源',exact:true}).click();await page.getByRole('checkbox',{name:'Codex',exact:true}).uncheck();
    await page.getByText('时间范围与导入',{exact:true}).click();
    await page.getByRole('checkbox',{name:'指定时间范围',exact:true}).check();
    await page.getByLabel('开始日期',{exact:true}).fill('2026-01-01');
    await page.getByLabel('结束日期',{exact:true}).fill('2026-12-31');await page.getByRole('button',{name:'使用这些来源',exact:true}).click();
    await page.getByRole('navigation').getByRole('button',{name:'技能库',exact:true}).click();
    await page.getByRole('navigation').getByRole('button',{name:'采集与生成',exact:true}).click();
    await page.getByRole('button',{name:'管理来源',exact:true}).click();await expect(page.getByRole('checkbox',{name:'Codex',exact:true})).not.toBeChecked();
    await expect(page.getByLabel('开始日期',{exact:true})).toHaveValue('2026-01-01');
    await expect(page.getByLabel('结束日期',{exact:true})).toHaveValue('2026-12-31');
    await page.getByRole('checkbox',{name:'指定时间范围',exact:true}).uncheck();await page.getByRole('button',{name:'使用这些来源',exact:true}).click();
    await page.setViewportSize({width:430,height:900});
    await expect(page.getByRole('button',{name:'查看样例技能'})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.screenshot({path:'test-results/skillharbor-mobile.png',fullPage:true});
    // Native-dialog operations use isolated files; no owner history or network provider is touched.
    await page.setViewportSize({width:1440,height:1080});
    const exported=path.join(temp,'library-export.zip');
    await app.evaluate(({dialog},savePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:savePath});},exported);
    const exportResult=await page.evaluate(()=>window.skillharbor.request<{path:string}>('export'));
    expect(exportResult.path).toBe(exported);expect((await readFile(exported)).byteLength).toBeGreaterThan(100);
    await page.evaluate(()=>window.skillharbor.request('exitDemo'));
    // Save a fake key through OS encryption, then prove it is not reused at another endpoint and can be removed.
    const encryptionSupported=await app.evaluate(({safeStorage})=>safeStorage.isEncryptionAvailable()&&!(process.platform==='linux'&&safeStorage.getSelectedStorageBackend()==='basic_text'));
    if(encryptionSupported){
    await page.evaluate(()=>window.skillharbor.request('saveSettings',{analysisMode:'local',model:'fixture',endpoint:'http://127.0.0.1:11434/v1',apiKey:'fixture-private-key-not-real'}));
    expect((await page.evaluate(()=>window.skillharbor.request<{settings:{apiKeySet:boolean}}>('getState'))).settings.apiKeySet).toBe(true);
    expect((await readFile(path.join(temp,'provider-key.bin'))).includes(Buffer.from('fixture-private-key-not-real'))).toBe(false);
    await page.evaluate(()=>window.skillharbor.request('saveSettings',{endpoint:'http://127.0.0.1:11435/v1'}));
    expect((await page.evaluate(()=>window.skillharbor.request<{settings:{apiKeySet:boolean}}>('getState'))).settings.apiKeySet).toBe(false);
    await page.evaluate(()=>window.skillharbor.request('saveSettings',{endpoint:'http://127.0.0.1:11434/v1'}));
    expect((await page.evaluate(()=>window.skillharbor.request<{settings:{apiKeySet:boolean}}>('getState'))).settings.apiKeySet).toBe(true);
    await page.evaluate(()=>window.skillharbor.request('saveSettings',{apiKey:''}));
    expect((await page.evaluate(()=>window.skillharbor.request<{settings:{apiKeySet:boolean}}>('getState'))).settings.apiKeySet).toBe(false);
    }
    await page.evaluate(()=>window.skillharbor.request('saveSettings',{analysisMode:'remote',endpoint:'https://one.example/v1',model:'fixture',remoteConsent:true,consentEndpoint:'https://one.example/v1'}));
    const denied=await page.evaluate(async()=>{try{await window.skillharbor.request('saveSettings',{endpoint:'https://two.example/v1',remoteConsent:true});return false;}catch{return true;}});
    expect(denied).toBe(true);
    await page.evaluate(endpoint=>window.skillharbor.request('saveSettings',{analysisMode:'local',model:'deterministic-ui-fixture',endpoint}),fixture.endpoint);
    const importPath=path.join(process.cwd(),'examples','histories.json');
    await app.evaluate(({dialog},filePath)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[filePath]});},importPath);
    await page.evaluate(()=>window.skillharbor.request('import',{}));
    await expect.poll(async()=>{const s=await page.evaluate(()=>window.skillharbor.request<{run:{status:string}|null;stats:{skills:number}}>('getState'));return s.run?.status==='completed'&&s.stats.skills===3;},{timeout:30_000}).toBe(true);
    const imported=await page.evaluate(()=>window.skillharbor.request<{stats:{conversations:number;skills:number};run:unknown;settings:{analysisMode:string}}>('getState'));
    expect(imported.stats.conversations).toBe(8);expect(imported.stats.skills,JSON.stringify({stats:imported.stats,run:imported.run,mode:imported.settings.analysisMode})).toBe(3);
    await page.evaluate(()=>window.skillharbor.request('forget',{scope:'derived'}));
    expect((await page.evaluate(()=>window.skillharbor.request<{stats:{skills:number}}>('getState'))).stats.skills).toBe(3);
    // The production import/evidence/revision path, using only synthetic material.
    const criteriaPath=path.join(process.cwd(),'examples','skillopt-adoption','histories.json');
    await app.evaluate(({dialog},filePath)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[filePath]});},criteriaPath);
    await page.evaluate(()=>window.skillharbor.request('import',{}));
    await expect.poll(async()=>{const s=await page.evaluate(()=>window.skillharbor.request<{run:{status:string}|null;stats:{conversations:number}}>('getState'));return s.run?.status==='completed'&&s.stats.conversations===9;}).toBe(true);
    const reviewSkill=await page.evaluate(async()=>{const s=await window.skillharbor.request<import('../src/shared/types').AppState>('getState');return s.skills.find(skill=>skill.title.includes('换文档'))!;});
    expect(reviewSkill).toBeTruthy();
    await page.getByRole('navigation').getByRole('button',{name:'技能库',exact:true}).click();
    await page.locator('.skill-card').filter({hasText:reviewSkill.title}).click();
    const criteriaDialog=page.getByRole('dialog').first();
    await criteriaDialog.getByRole('button',{name:/来源依据/}).click();await criteriaDialog.locator('.evidence-row').first().click();
    await expect(page.getByRole('heading',{name:'历史中的验收要求'})).toBeVisible();
    await page.locator('.evidence-context').first().getByText('展开这条消息的上下文',{exact:true}).click();
    await expect(page.locator('.context-message.cited').first()).toBeVisible();await page.keyboard.press('Escape');await page.keyboard.press('Escape');
    await page.evaluate(async({id,markdown})=>{await window.skillharbor.request('saveSkill',{id,markdown:markdown+'\n保留我手动添加的这条个人要求。\n'});await window.skillharbor.request('resume',{analysisOnly:true});},{id:reviewSkill.id,markdown:reviewSkill.markdown});
    await expect.poll(async()=>{const s=await page.evaluate(()=>window.skillharbor.request<import('../src/shared/types').AppState>('getState'));return s.run?.status==='completed'&&!!s.skills.find(skill=>skill.id===reviewSkill.id)?.proposedRevision;}).toBe(true);
    await page.locator('.skill-card').filter({hasText:reviewSkill.title}).click();await page.getByRole('button',{name:'审阅修订',exact:true}).click();
    await expect(page.getByRole('region',{name:'修订差异'})).toBeVisible();await expect(page.locator('.diff-line.removed')).toContainText('保留我手动添加的这条个人要求。');
    await page.screenshot({path:'test-results/skillharbor-revision.png',fullPage:true});
    await page.getByRole('button',{name:'保留当前版本',exact:true}).click();
    await expect(page.locator('.revision-banner')).toHaveCount(0);await page.keyboard.press('Escape');
    await page.evaluate(()=>window.skillharbor.request('resume',{analysisOnly:true}));
    await expect.poll(async()=>{const s=await page.evaluate(()=>window.skillharbor.request<import('../src/shared/types').AppState>('getState'));return s.run?.status==='completed'&&s.run.skills===0;}).toBe(true);
    const kept=await page.evaluate(id=>window.skillharbor.request<import('../src/shared/types').Skill>('skill',{id}),reviewSkill.id);
    expect(kept.proposedRevision).toBeUndefined();expect(kept.markdown).toContain('保留我手动添加的这条个人要求。');
    expect(errors).toEqual([]);
  }finally{
    await app?.close();await fixture.close();if(path.dirname(path.resolve(temp))!==path.resolve(tmpdir())||!path.basename(temp).startsWith('skillharbor-ui-'))throw new Error('Unsafe temporary cleanup');await rm(temp,{recursive:true,force:true});
  }
});
